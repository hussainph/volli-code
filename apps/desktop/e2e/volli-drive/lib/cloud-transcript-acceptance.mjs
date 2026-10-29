/**
 * Cloud wake acceptance's object-store boundary and read-only upload evidence.
 * No body is seeded: this bucket can acquire bytes ONLY from an HTTP PUT by
 * the production runner. The backend signs every PUT/GET; this fake checks
 * SigV4 independently with Node crypto, lengths, checksums and expiry.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { gunzipSync, zstdDecompressSync } from "node:zlib";

import { verifyS3Request } from "../../../../../convex/fixture/s3-boundary.ts";
import { waitUntil } from "../../lib/smoke-kit.mjs";

const exec = promisify(execFile);
const MAX_BYTES = 64 * 1024 * 1024;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function clientFor(fixture, token) {
  const [{ ConvexHttpClient }, { makeFunctionReference }] = await Promise.all([
    import("convex/browser"),
    import("convex/server"),
  ]);
  const client = new ConvexHttpClient(fixture.convexUrl);
  if (token === undefined) {
    assert.ok(fixture.adminKey, "the throwaway backend's admin key is required");
    client.setAdminAuth(fixture.adminKey);
  } else client.setAuth(token);
  return { client, ref: makeFunctionReference };
}

/** Pinned backend's own paginated admin read, not a product test hook. */
async function tableRows(fixture, table, sessionId) {
  const { client, ref } = await clientFor(fixture);
  const rows = [];
  let cursor = null;
  for (let pages = 0; pages < 10; pages++) {
    const page = await client.query(ref("_system/cli/tableData:default"), {
      table,
      order: "asc",
      paginationOpts: { numItems: 128, cursor },
    });
    rows.push(...page.page.filter((row) => row.sessionId === sessionId));
    if (page.isDone) return rows;
    cursor = page.continueCursor;
  }
  throw new Error(`Unexpectedly large throwaway backend table: ${table}`);
}

/** A same-process, bounded, path-style S3 bucket with renderer CORS support. */
export async function startTranscriptStore(fixture, reportDir) {
  const credentials = {
    accessKeyId: "wake-acceptance",
    secretAccessKey: randomBytes(32).toString("hex"),
  };
  const bucket = "wake-history";
  const objects = new Map();
  const requests = [];
  const problems = [];
  let totalBytes = 0;
  let endpoint;
  const server = createServer(
    { requestTimeout: 30_000, headersTimeout: 10_000 },
    (request, response) => {
      void (async () => {
        let key = null;
        // Production's renderer fetches from the store, not from Convex. Handle
        // real Chromium CORS/preflight as an S3-compatible deployment would.
        response.setHeader("access-control-allow-origin", "*");
        response.setHeader("access-control-allow-methods", "GET, HEAD, PUT, OPTIONS");
        response.setHeader("access-control-allow-headers", "*");
        response.setHeader(
          "access-control-expose-headers",
          "content-length, x-amz-checksum-sha256",
        );
        try {
          const url = new URL(request.url, endpoint);
          assert.ok(url.pathname.startsWith(`/${bucket}/v1/`));
          key = decodeURIComponent(url.pathname.slice(bucket.length + 2));
          assert.ok(
            key
              .split("/")
              .every((part) => /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(part) && !part.includes("..")),
          );
          if (request.method === "OPTIONS") {
            response.writeHead(204).end();
            return;
          }
          key = verifyS3Request(request, url, { ...credentials, bucket, region: "auto" });
          let body;
          if (request.method === "PUT") {
            if (request.headers["if-none-match"] === "*" && objects.has(key)) {
              request.resume();
              response.writeHead(412).end();
              return;
            }
            const length = Number(request.headers["content-length"]);
            assert.ok(Number.isSafeInteger(length) && length > 0 && length <= MAX_BYTES);
            const chunks = [];
            let read = 0;
            for await (const chunk of request) {
              read += chunk.length;
              assert.ok(read <= length, "upload stays within its signed length");
              chunks.push(chunk);
            }
            body = Buffer.concat(chunks);
            assert.equal(body.length, length);
            assert.equal(
              request.headers["x-amz-checksum-sha256"],
              createHash("sha256").update(body).digest("base64"),
            );
            totalBytes += body.length - (objects.get(key)?.length ?? 0);
            assert.ok(totalBytes <= 2 * MAX_BYTES, "acceptance bucket is bounded");
            // Wire keys may contain durable colons (runtime-attachment:<id>).
            // GitHub artifacts require portable filenames; requests below keep
            // the exact key -> checksum mapping for these content-addressed copies.
            await fs.mkdir(join(reportDir, "objects"), { recursive: true });
            await fs.writeFile(join(reportDir, "objects", `${sha256(body)}.zst`), body);
            objects.set(key, body);
          } else {
            body = objects.get(key);
            if (body === undefined) {
              response.writeHead(404).end();
              return;
            }
          }
          requests.push({
            method: request.method,
            key,
            bytes: body.length,
            sha256: sha256(body),
            origin: request.headers.origin ?? null,
          });
          if (request.method === "PUT") response.writeHead(200).end();
          else
            response
              .writeHead(200, {
                "content-type": "application/octet-stream",
                "content-length": body.length,
                "x-amz-checksum-sha256": createHash("sha256").update(body).digest("base64"),
              })
              .end(request.method === "HEAD" ? undefined : body);
        } catch (error) {
          problems.push({ method: request.method, key, error: error.message });
          if (!response.headersSent) response.writeHead(400);
          response.end("Object-store boundary rejected the request");
        }
      })();
    },
  );
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  endpoint = `http://127.0.0.1:${server.address().port}`;
  const close = async () => {
    let forced = false;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        forced = true;
        server.closeAllConnections();
      }, 5_000);
      server.close((error) => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      });
    });
    assert.equal(forced, false, "object store closed without forcing active connections");
    return { closed: !server.listening, problems };
  };
  try {
    // Same admin environment API as convex/fixture/backend.ts; throwaway
    // credentials live only here/in the fixture backend, never in evidence.
    const response = await fetch(`${fixture.convexUrl}/api/update_environment_variables`, {
      method: "POST",
      headers: { authorization: `Convex ${fixture.adminKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        changes: Object.entries({
          VOLLI_S3_ENDPOINT: endpoint,
          VOLLI_S3_BUCKET: bucket,
          VOLLI_S3_ACCESS_KEY_ID: credentials.accessKeyId,
          VOLLI_S3_SECRET_ACCESS_KEY: credentials.secretAccessKey,
          VOLLI_S3_REGION: "auto",
        }).map(([name, value]) => ({ name, value })),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    assert.ok(response.ok, `fixture object-store configuration: HTTP ${response.status}`);
    await response.text();
  } catch (error) {
    await close();
    throw error;
  }
  return { endpoint, objects, requests, problems, close };
}

/** Read committed indexes; validate the real objects against the unchanged local files. */
export async function waitForTranscriptUploads({
  fixture,
  store,
  sessionId,
  layout,
  expectedReplies,
}) {
  assert.match(sessionId, /^[0-9a-f-]{36}$/u);
  return waitUntil(
    `${expectedReplies.length} finished turns packed, and Pi's complete log uploaded`,
    async () => {
      const [turns, segments, piLogs, staged] = await Promise.all(
        ["sessionTurns", "transcriptSegments", "piLogSegments", "transcriptArtifacts"].map((name) =>
          tableRows(fixture, name, sessionId),
        ),
      );
      const finished = turns.filter((turn) => turn.endedSequence !== null);
      assert.equal(finished.length, expectedReplies.length, "all requested turns finished");
      segments.sort((a, b) => a.firstSequence - b.firstSequence);
      let through = 0;
      const packs = [];
      for (const segment of segments) {
        assert.equal(segment.firstSequence, through + 1, "pack ranges are contiguous from 1");
        through = segment.lastSequence;
        const compressed = store.objects.get(segment.key);
        assert.ok(compressed, "committed pack crossed HTTP PUT");
        assert.equal(compressed.length, segment.bytes);
        assert.equal(sha256(compressed), segment.sha256);
        const lines = zstdDecompressSync(compressed, { maxOutputLength: MAX_BYTES })
          .toString("utf8")
          .trimEnd()
          .split("\n")
          .map((line) => JSON.parse(line));
        const [header, ...entries] = lines;
        assert.equal(header.format, "volli.transcript-pack/1");
        assert.equal(header.sessionId, sessionId);
        assert.equal(header.firstSequence, segment.firstSequence);
        assert.equal(header.lastSequence, segment.lastSequence);
        assert.deepEqual(header.turnIds, segment.turnIds);
        assert.equal(entries.length, segment.artifactCount);
        assert.equal(header.artifactCount, entries.length);
        assert.deepEqual(header.missing ?? [], [], "no silently missing local history");
        for (const entry of entries) {
          // This fake-provider fixture has no injected credentials. Every body
          // must still be the durable gzip artifact, byte/digest unchanged.
          assert.match(entry.digest, /^sha256:[a-f0-9]{64}$/u);
          const canonical = gunzipSync(
            await fs.readFile(
              join(layout.userDataDir, "session-transcripts", `${entry.digest.slice(7)}.json.gz`),
            ),
          );
          assert.equal(`sha256:${sha256(canonical)}`, entry.digest);
          assert.deepEqual(JSON.parse(canonical.toString("utf8")), entry.body);
        }
        packs.push({
          segmentId: segment.id,
          key: segment.key,
          firstSequence: segment.firstSequence,
          lastSequence: segment.lastSequence,
          entries,
        });
      }
      assert.ok(
        through >= Math.max(...finished.map((turn) => turn.endedSequence)),
        "pack covers the last finished turn",
      );
      for (const turn of finished)
        assert.ok(
          segments.some((segment) => segment.turnIds.includes(turn.turnId)),
          "every finished turn is indexed in a pack",
        );
      for (const text of expectedReplies)
        assert.ok(
          packs.some((pack) =>
            pack.entries.some((entry) => JSON.stringify(entry.body).includes(text)),
          ),
          `pack contains ${text}`,
        );

      const { stdout } = await exec(
        "sqlite3",
        [
          "-readonly",
          "-json",
          layout.dbPath,
          `SELECT id, native_detail FROM session_attachments WHERE session_id = '${sessionId}'`,
        ],
        { timeout: 10_000 },
      );
      const files = JSON.parse(stdout).flatMap((row) => {
        const detail = JSON.parse(row.native_detail ?? "null");
        const locator = detail?.kind === "volli.native-binding.v1" ? detail.locator : detail;
        return locator?.runtime === "pi" && typeof locator.sessionFilePath === "string"
          ? [{ attachmentId: row.id, path: locator.sessionFilePath }]
          : [];
      });
      assert.ok(files.length > 0, "real Pi attachment exposes its own sidecar");
      let logText = "";
      const piFiles = [];
      for (const file of files) {
        const inside = relative(layout.scratch, file.path);
        assert.ok(
          isAbsolute(file.path) &&
            inside !== ".." &&
            !inside.startsWith(`..${sep}`) &&
            !isAbsolute(inside),
        );
        const source = await fs.readFile(file.path);
        const completeBytes = source.lastIndexOf(0x0a) + 1;
        const piFileId = basename(file.path).replace(/\.jsonl$/u, "");
        const ranges = piLogs
          .filter((row) => row.piFileId === piFileId)
          .toSorted((a, b) => a.startOffset - b.startOffset);
        let end = 0;
        for (const range of ranges) {
          assert.equal(range.attachmentId, file.attachmentId);
          assert.equal(range.startOffset, end, "Pi byte ranges are contiguous from zero");
          const compressed = store.objects.get(range.key);
          assert.ok(compressed, "committed Pi bytes crossed HTTP PUT");
          assert.equal(compressed.length, range.bytes);
          assert.equal(sha256(compressed), range.sha256);
          const plain = zstdDecompressSync(compressed, { maxOutputLength: MAX_BYTES });
          assert.deepEqual(
            plain,
            source.subarray(range.startOffset, range.endOffset),
            "uploaded Pi lines equal the real sidecar byte range",
          );
          logText += plain.toString("utf8");
          end = range.endOffset;
        }
        assert.ok(
          completeBytes > 0 && end === completeBytes,
          "Pi upload reached its complete-line EOF",
        );
        piFiles.push({
          attachmentId: file.attachmentId,
          piFileId,
          completeBytes,
          segments: ranges.length,
        });
      }
      for (const text of expectedReplies)
        assert.ok(logText.includes(text), `Pi log contains ${text}`);
      assert.deepEqual(store.problems, [], "object-store HTTP boundary accepted every request");
      return {
        sessionId,
        finishedTurns: finished.map(({ turnId, endedSequence }) => ({ turnId, endedSequence })),
        packedThrough: through,
        packs,
        piFiles,
        staged,
      };
    },
    { timeout: 90_000, interval: 750 },
  );
}

/**
 * SETUP: simulate staging's one-hour age, not its bodies or upload lifecycle.
 * Only already-packed rows, each covered by an object verified above, get an
 * expiry-only patch through the pinned backend's existing dashboard admin
 * mutation. Then the UNCHANGED production sweep actually deletes them. Never
 * clear unpacked history, write a body, or introduce a production test hook.
 */
export async function sweepPackedStaging(fixture, uploads, token) {
  const rows = uploads.staged.filter((row) => row.packedSegmentId !== null);
  assert.ok(rows.length > 0, "packing marked staging rows before aging");
  for (const row of rows) {
    const pack = uploads.packs.find((candidate) => candidate.segmentId === row.packedSegmentId);
    assert.ok(
      pack?.entries.some((entry) => entry.digest === row.digest),
      "only a verified packed body may expire",
    );
    assert.ok(row.expiresAt !== null, "production commit assigned the packed TTL");
  }
  const { client, ref } = await clientFor(fixture);
  const patched = await client.mutation(ref("_system/frontend/patchDocumentsFields:default"), {
    table: "transcriptArtifacts",
    ids: rows.map((row) => row["_id"]),
    fields: { expiresAt: 0 },
  });
  assert.equal(patched.success, true);
  await client.mutation(ref("transcripts:sweepPacked"), {});
  const viewer = await clientFor(fixture, token);
  const digests = [
    ...new Set(uploads.packs.flatMap((pack) => pack.entries.map((entry) => entry.digest))),
  ];
  const absent = await viewer.client.query(viewer.ref("sessionTranscript:artifacts"), {
    sessionId: uploads.sessionId,
    digests,
  });
  assert.equal(absent.length, digests.length);
  assert.ok(
    absent.every((body) => body.status === "absent"),
    "no staged body can supply Mac B's finished turns",
  );
  return { agedRows: rows.length, absentDigests: digests };
}

/** GETs are observed, never issued here: the visible window must fetch packs. */
export function assertPackedDownloads(store, uploads, since, expectedReplies) {
  const downloaded = store.requests.slice(since).filter((row) => row.method === "GET");
  for (const text of expectedReplies) {
    const containing = uploads.packs.filter((pack) =>
      pack.entries.some((entry) => JSON.stringify(entry.body).includes(text)),
    );
    assert.ok(
      containing.some((pack) =>
        downloaded.some((request) => request.key === pack.key && request.origin !== null),
      ),
      `Mac B's renderer fetched the pack containing ${text} over HTTP`,
    );
  }
  assert.deepEqual(store.problems, []);
  return downloaded;
}

/** Keep identifiers/checksums and boundary evidence, not admin credentials or signed URLs. */
export function transcriptEvidence(uploads) {
  return {
    sessionId: uploads.sessionId,
    finishedTurns: uploads.finishedTurns,
    packedThrough: uploads.packedThrough,
    piFiles: uploads.piFiles,
    packs: uploads.packs.map(({ entries, ...pack }) => ({
      ...pack,
      digests: entries.map((entry) => entry.digest),
    })),
  };
}
