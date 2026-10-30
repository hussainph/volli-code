/** Parent orchestration end to end against the pinned backend and HTTP S3.
 * Simulated wiring: cross-platform file copy and expiry waits only. The CLI
 * has no bypass; all safety checks, real SIGKILLs, backup, exporter, imports,
 * verification, rollback/re-move, escape hatch, report and cleanup run.
 */
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRawDb } from "../../packages/host-core/src/db/test-helpers";
import { expect, test, vi } from "vite-plus/test";
import { api, internal } from "../functions/_generated/api";
import { connectBackend } from "../fixture/testing";
import { mintTestToken } from "../fixture/jwt";
import {
  verifyS3MoveRequest,
  verifyS3ReadRequest,
  verifyS3Request,
  verifyS3ListRequest,
} from "../fixture/s3-boundary";
import { enrollBackendPreview } from "./preview-fixtures";
import {
  runMoveRehearsal,
  runRehearsalChild,
} from "../../packages/host-core/src/migration-dry-run/move-rehearsal";
import {
  runMoveJob,
  type MoveJob,
} from "../../packages/host-core/src/migration-dry-run/move-worker";
import { writeMoveProfile } from "../../packages/host-core/src/migration-dry-run/test-support/move-profile";

function quote(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

test("Move all on a synthetic copy verifies, resumes unchanged, rolls back and goes back to local", async () => {
  const backend = connectBackend();
  const subject = `user:rehearsal-${randomUUID()}`;
  const person = backend.client(subject);
  const { userId } = await person.mutation(api.accounts.ensureViewer, {});
  await enrollBackendPreview(backend, person, userId);
  const runnerId = await backend.admin(internal.testSeed.seedRunner, {
    ownerUserId: userId,
    name: "Rehearsal",
  });
  const root = mkdtempSync(join(tmpdir(), "move-rehearsal-http-"));
  const source = join(root, "source"),
    profile = join(root, "copy");
  const fixture = writeMoveProfile(source, { artifacts: 4 });
  // All backend files share one deployment. Do not collide with the original
  // migration dry-run test's fixed synthetic UUIDs.
  const unique = openRawDb(fixture.dbPath);
  try {
    unique.pragma("foreign_keys = OFF");
    const prefix = randomUUID().slice(0, 24);
    // This is fixture construction, not a product write. Preserve every
    // production trigger verbatim while re-keying its immutable identities.
    const triggers = unique
      .prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger'")
      .all() as { name: string; sql: string }[];
    for (const trigger of triggers) unique.exec(`DROP TRIGGER ${quote(trigger.name)}`);
    for (const { name } of unique
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[]) {
      for (const column of unique.prepare(`PRAGMA table_info(${quote(name)})`).all() as {
        name: string;
        type: string;
      }[]) {
        if (column.type === "TEXT") {
          for (const [from, to] of [
            ["7a1f0c2e-0000-4000-8000-", prefix],
            ["mcp-docs", `mcp-docs-${prefix}`],
          ]) {
            unique
              .prepare(
                `UPDATE ${quote(name)} SET ${quote(column.name)}=replace(${quote(column.name)},?,?) WHERE instr(${quote(column.name)},?)>0`,
              )
              .run(from, to, from);
          }
        }
      }
    }
    for (const trigger of triggers) unique.exec(trigger.sql);
    expect(unique.pragma("foreign_key_check")).toEqual([]);
  } finally {
    unique.close();
  }
  const original = readFileSync(fixture.dbPath);
  const objects = new Map<string, Buffer>();
  const config = {
    endpoint: "",
    bucket: "volli-test",
    region: "auto",
    accessKeyId: "test-access",
    secretAccessKey: "test-secret",
  };
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url!, config.endpoint);
      const headers = Object.fromEntries(
        Object.entries(req.headers).map(([k, v]) => [k, String(v)]),
      );
      const request = { method: req.method!, headers };
      if (req.method === "GET" && url.searchParams.has("list-type")) {
        const { prefix } = verifyS3ListRequest(request, url, config);
        const keys = [...objects.keys()].filter((key) => key.startsWith(prefix));
        res
          .writeHead(200, { "content-type": "application/xml" })
          .end(
            `<ListBucketResult><IsTruncated>false</IsTruncated>${keys.map((key) => `<Contents><Key>${encodeURIComponent(key)}</Key></Contents>`).join("")}</ListBucketResult>`,
          );
      } else if (req.method === "DELETE") {
        objects.delete(verifyS3MoveRequest(request, url, config));
        res.writeHead(204).end();
      } else if (req.method === "PUT") {
        const key =
          headers["if-none-match"] === "*"
            ? verifyS3MoveRequest(request, url, config)
            : verifyS3Request(request, url, config);
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const bytes = Buffer.concat(chunks);
        expect(createHash("sha256").update(bytes).digest("base64")).toBe(
          headers["x-amz-checksum-sha256"],
        );
        if (objects.has(key) && headers["if-none-match"] === "*") {
          res.writeHead(412).end();
          return;
        }
        objects.set(key, bytes);
        res.writeHead(200).end();
      } else {
        const key = verifyS3ReadRequest(request, url, config);
        const bytes = objects.get(key);
        if (!bytes) {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, {
          "content-length": bytes.length,
          "x-amz-checksum-sha256": createHash("sha256").update(bytes).digest("base64"),
        });
        res.end(req.method === "HEAD" ? undefined : bytes);
      }
    } catch {
      res.writeHead(500).end();
    }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  config.endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const changes = {
    VOLLI_S3_ENDPOINT: config.endpoint,
    VOLLI_S3_BUCKET: config.bucket,
    VOLLI_S3_REGION: config.region,
    VOLLI_S3_ACCESS_KEY_ID: config.accessKeyId,
    VOLLI_S3_SECRET_ACCESS_KEY: config.secretAccessKey,
    VOLLI_MIGRATION_REHEARSAL: "enabled",
  };
  const update = await fetch(`${backend.url}/api/update_environment_variables`, {
    method: "POST",
    headers: {
      authorization: `Convex ${process.env.VOLLI_CONVEX_ADMIN_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      changes: Object.entries(changes).map(([name, value]) => ({ name, value })),
    }),
  });
  expect(update.ok).toBe(true);
  vi.stubEnv("VOLLI_MOVE_TOKEN_FILE", "");
  const redactions = join(root, "redactions.json");
  writeFileSync(redactions, "[]"); // known synthetic data; loopback only
  vi.stubEnv("VOLLI_MOVE_REDACTIONS_FILE", redactions);
  vi.stubEnv(
    "VOLLI_MOVE_TOKEN",
    mintTestToken(process.env.VOLLI_CONVEX_TEST_PRIVATE_KEY!, subject),
  );
  vi.stubEnv("VOLLI_MOVE_ADMIN_KEY", process.env.VOLLI_CONVEX_ADMIN_KEY!);
  const reportPath = join(root, "report.json");
  let workspaceId = "";
  let returned = false;
  try {
    // Public clients cannot call the cleanup helper, even with its exact args.
    await expect(
      person.mutation(
        internal.migration.cleanupRehearsal as never,
        { workspaceId: randomUUID(), userId } as never,
      ),
    ).rejects.toThrow();
    const ok = await runMoveRehearsal(
      {
        target: backend.url,
        source,
        profile,
        report: reportPath,
        runnerId,
        userId,
        allowProduction: false,
        includeRemoved: false,
        killUpload: true,
        killImport: true,
        rollback: true,
        goBack: true,
        hold: false,
      },
      {
        cloneProfile: async (from, to) => {
          cpSync(from, to, { recursive: true });
        },
        async runChild(file, onRss) {
          const job = JSON.parse(readFileSync(file, "utf8")) as MoveJob;
          workspaceId = job.workspaceId;
          if (job.kill) return runRehearsalChild(file, onRss);
          if (job.operation === "rollback") {
            // The manual UI check changed the cloud copy: rehearsal rollback
            // must explicitly confirm discarding those sandbox-only changes.
            const db = openRawDb(join(profile, "volli.db"));
            try {
              const ticketId = db
                .prepare(
                  "SELECT t.id FROM tickets t JOIN cloud_moves m ON m.project_id=t.project_id WHERE m.move_id=? LIMIT 1",
                )
                .pluck()
                .get(job.moveId) as string;
              await person.mutation(api.board.createComment, {
                commandId: randomUUID(),
                commentId: randomUUID(),
                ticketId,
                body: "synthetic UI change",
              });
            } finally {
              db.close();
            }
          }
          onRss(process.memoryUsage().rss);
          const result = await runMoveJob(file, async () => {});
          if (job.operation === "go-back") {
            const db = openRawDb(join(profile, "volli.db"));
            try {
              returned =
                db
                  .prepare("SELECT state FROM cloud_moves WHERE move_id=?")
                  .pluck()
                  .get(job.moveId) === "returned";
            } finally {
              db.close();
            }
          }
          return { killed: false, result };
        },
        async waitPurged(client, moveId) {
          await backend.admin(internal.testSeed.expireRehearsalUploads, { moveId });
          const until = Date.now() + 15_000;
          while (Date.now() < until) {
            if (
              ((await client.query("projectImports:status", { moveId })) as { status: string })
                .status === "purged"
            )
              return;
            await delay(20);
          }
          throw new Error("test purge did not finish");
        },
      },
    );
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    // Phase timings in the CI log: which engine run (or the teardown) is slow.
    console.info(
      "move rehearsal phases (ms):",
      report.runs
        .map(
          (run: { operation: string; kill: string | null; elapsedMs: number }) =>
            `${run.operation}${run.kill ? `/kill-${run.kill}` : ""}=${run.elapsedMs}`,
        )
        .join(" "),
      `total=${report.elapsedMs}`,
    );
    expect(ok, JSON.stringify(report)).toBe(true);
    expect(report).toMatchObject({
      ok: true,
      kills: ["upload", "import"],
      failures: [],
      cleanup: { profile: true, workspace: true },
    });
    expect(
      report.runs.filter((run: { operation: string }) => run.operation === "move-again"),
    ).toHaveLength(1);
    expect(
      report.runs.every(
        (run: { elapsedMs: number; peakRssBytes: number }) =>
          run.elapsedMs >= 0 && run.peakRssBytes > 0,
      ),
    ).toBe(true);
    expect(returned).toBe(true);
    expect(existsSync(profile)).toBe(false);
    expect(existsSync(`${profile}.rehearsal.json`)).toBe(false);
    expect(objects.size).toBe(0);
    expect(readFileSync(fixture.dbPath)).toEqual(original);
    expect(readFileSync(reportPath, "utf8")).not.toContain("synthetic UI change");
    expect(readFileSync(reportPath, "utf8")).not.toContain(workspaceId);
    await expect(person.query(api.workspaces.get, { workspaceId })).rejects.toThrow();
  } finally {
    vi.unstubAllEnvs();
    // A pooled client can leave a connection to this store open that never
    // carries a request, and `close()` alone waits on it forever (VC-1023).
    // Every rehearsal step and assertion has finished by now: drop them all.
    await new Promise<void>((done) => {
      server.close(() => done());
      server.closeAllConnections();
    });
    rmSync(root, { recursive: true, force: true });
    await fetch(`${backend.url}/api/update_environment_variables`, {
      method: "POST",
      headers: {
        authorization: `Convex ${process.env.VOLLI_CONVEX_ADMIN_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        changes: Object.keys(changes).map((name) => ({ name, value: null })),
      }),
    });
  }
}, 180_000);
