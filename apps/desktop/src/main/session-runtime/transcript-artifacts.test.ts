import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzip, gzip } from "node:zlib";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vite-plus/test";
import { canonicalJson, type SessionTranscriptArtifact } from "@volli/session-engine";

import {
  createFileTranscriptArtifactStore,
  FileTranscriptArtifactStore,
  repackLegacyTranscriptArtifacts,
} from "./transcript-artifacts";

const gunzipAsync = promisify(gunzip);
const gzipAsync = promisify(gzip);

let directory: string | undefined;

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

function artifact(text = "Hello"): SessionTranscriptArtifact {
  return {
    version: 1,
    threadId: "thread-1",
    branchId: "branch-1",
    attemptId: "attempt-1",
    turnId: null,
    message: { id: "message-1", role: "assistant", parts: [{ type: "text", text }] },
  };
}

async function store() {
  directory = await mkdtemp(join(tmpdir(), "volli-transcript-artifacts-"));
  return createFileTranscriptArtifactStore(directory);
}

function canonicalBytes(value: SessionTranscriptArtifact): Buffer {
  return Buffer.from(canonicalJson(value), "utf8");
}

function referenceFor(value: SessionTranscriptArtifact) {
  const bytes = canonicalBytes(value);
  const digest = createHash("sha256").update(bytes).digest("hex");
  return {
    bytes,
    reference: {
      id: `sha256:${digest}`,
      digest: `sha256:${digest}`,
      mediaType: "application/vnd.volli.ui-message+json",
    },
  } as const;
}

describe("FileTranscriptArtifactStore", () => {
  it("writes gzip bytes at the canonical digest and reads them back verified", async () => {
    const artifacts = await store();
    const value = artifact("Hello ".repeat(200));
    const reference = await artifacts.write(value);

    expect(reference).toEqual({
      id: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      mediaType: "application/vnd.volli.ui-message+json",
    });
    const name = `${reference.id.slice("sha256:".length)}.json.gz`;
    const packed = await readFile(join(directory!, name));
    expect([...packed.subarray(0, 2)]).toEqual([0x1f, 0x8b]);
    const bytes = await gunzipAsync(packed);
    expect(`sha256:${createHash("sha256").update(bytes).digest("hex")}`).toBe(reference.id);
    expect(packed.length).toBeLessThan(bytes.length);
    await expect(artifacts.read(reference)).resolves.toEqual(value);
  });

  it("reads a verified legacy plain artifact without changing it", async () => {
    const artifacts = await store();
    const value = artifact("legacy");
    const { bytes, reference } = referenceFor(value);
    const path = join(directory!, `${reference.id.slice("sha256:".length)}.json`);
    await writeFile(path, bytes);

    await expect(artifacts.read(reference)).resolves.toEqual(value);
    await expect(readFile(path)).resolves.toEqual(bytes);
  });

  it("fails loudly on a corrupt gzip and never falls back to a valid plain sibling", async () => {
    const artifacts = await store();
    const value = artifact("do not hide corruption");
    const { bytes, reference } = referenceFor(value);
    const digest = reference.id.slice("sha256:".length);
    await writeFile(join(directory!, `${digest}.json`), bytes);
    await writeFile(join(directory!, `${digest}.json.gz`), Buffer.from([0x1f, 0x8b, 0x08]));

    await expect(artifacts.read(reference)).rejects.toThrow();
  });

  it("deduplicates concurrent identical writes", async () => {
    const artifacts = await store();
    const value = artifact();
    const references = await Promise.all(Array.from({ length: 8 }, () => artifacts.write(value)));

    expect(new Set(references.map((reference) => reference.id))).toEqual(
      new Set([references[0]!.id]),
    );
    await expect(artifacts.read(references[0]!)).resolves.toEqual(value);
  });

  it("retries directory initialization after a transient creation failure", async () => {
    directory = await mkdtemp(join(tmpdir(), "volli-transcript-artifacts-"));
    const blockedDirectory = join(directory, "artifacts");
    await writeFile(blockedDirectory, "not a directory");
    const artifacts = createFileTranscriptArtifactStore(blockedDirectory);

    await expect(artifacts.write(artifact())).rejects.toThrow();
    await rm(blockedDirectory);
    await expect(artifacts.write(artifact())).resolves.toMatchObject({
      id: expect.stringMatching(/^sha256:/),
    });
  });

  it("uses canonical JSON semantics for optional UI message values and arrays", async () => {
    const artifacts = await store();
    const withOptionalValues = {
      version: 1 as const,
      threadId: "thread-1",
      branchId: "branch-1",
      attemptId: "attempt-1",
      turnId: null,
      message: {
        role: "assistant",
        id: "message-1",
        metadata: { omitted: undefined, retained: "value" },
        parts: [{ text: "Hello", type: "text", metadata: { ignored: undefined } }, undefined],
      } as unknown as SessionTranscriptArtifact["message"],
    };
    const canonicalEquivalent = {
      attemptId: "attempt-1",
      branchId: "branch-1",
      message: {
        id: "message-1",
        metadata: { retained: "value" },
        parts: [{ metadata: {}, text: "Hello", type: "text" }, null],
        role: "assistant",
      } as unknown as SessionTranscriptArtifact["message"],
      threadId: "thread-1",
      turnId: null,
      version: 1 as const,
    };

    const first = await artifacts.write(withOptionalValues);
    const second = await artifacts.write(canonicalEquivalent);

    expect(second).toEqual(first);
    const packed = await readFile(join(directory!, `${first.id.slice("sha256:".length)}.json.gz`));
    await expect(gunzipAsync(packed).then((bytes) => bytes.toString("utf8"))).resolves.toBe(
      '{"attemptId":"attempt-1","branchId":"branch-1","message":{"id":"message-1","metadata":{"retained":"value"},"parts":[{"metadata":{},"text":"Hello","type":"text"},null],"role":"assistant"},"threadId":"thread-1","turnId":null,"version":1}',
    );
    await expect(artifacts.read(first)).resolves.toEqual(canonicalEquivalent);
  });

  it("rejects invalid reference metadata and checksum-corrupted artifact bytes", async () => {
    const artifacts = await store();
    await expect(
      artifacts.read({
        id: "sha256:../../outside",
        digest: "sha256:../../outside",
        mediaType: null,
      }),
    ).rejects.toThrow("reference is invalid");

    const reference = await artifacts.write(artifact());
    await expect(artifacts.read({ ...reference, mediaType: "application/json" })).rejects.toThrow(
      "reference is invalid",
    );
    await writeFile(join(directory!, `${reference.id.slice("sha256:".length)}.json.gz`), "corrupt");
    await expect(artifacts.read(reference)).rejects.toThrow();
  });

  it("rejects a digest filename replaced with a symlink", async () => {
    const artifacts = await store();
    const reference = await artifacts.write(artifact());
    const artifactPath = join(directory!, `${reference.id.slice("sha256:".length)}.json.gz`);
    const externalPath = join(directory!, "outside.json.gz");
    await writeFile(externalPath, await readFile(artifactPath));
    await rm(artifactPath);
    await symlink(externalPath, artifactPath);

    await expect(artifacts.read(reference)).rejects.toThrow("not a regular file");
  });

  it("rejects tampered and symlinked digest paths before publishing a write", async () => {
    const artifacts = await store();
    const value = artifact();
    const reference = await artifacts.write(value);
    const artifactPath = join(directory!, `${reference.id.slice("sha256:".length)}.json.gz`);

    await writeFile(artifactPath, "bytes for another digest");
    await expect(artifacts.write(value)).rejects.toThrow();

    const externalPath = join(directory!, "outside.json.gz");
    await writeFile(externalPath, await readFile(artifactPath));
    await rm(artifactPath);
    await symlink(externalPath, artifactPath);
    await expect(artifacts.write(value)).rejects.toThrow("not a regular file");
  });

  it("repack skips wrong digest bytes and keeps the only readable form in place", async () => {
    const artifacts = await store();
    const { reference } = referenceFor(artifact("expected"));
    const digest = reference.id.slice("sha256:".length);
    const plainPath = join(directory!, `${digest}.json`);
    await writeFile(plainPath, canonicalBytes(artifact("different")));
    const failures: string[] = [];

    const report = await repackLegacyTranscriptArtifacts(artifacts, {
      batchSize: 1,
      pause: async () => undefined,
      onError: (path, error) => failures.push(`${path}: ${String(error)}`),
    });

    expect(report).toMatchObject({ scanned: 1, repacked: 0, skipped: 1 });
    expect(failures).toHaveLength(1);
    expect((await lstat(plainPath)).isFile()).toBe(true);
    await expect(lstat(join(directory!, `${digest}.json.gz`))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("keeps a good plain artifact readable when compressed publication fails", async () => {
    await store();
    const value = artifact("publish failure");
    const { bytes, reference } = referenceFor(value);
    const digest = reference.id.slice("sha256:".length);
    const plainPath = join(directory!, `${digest}.json`);
    await writeFile(plainPath, bytes);
    const artifacts = new FileTranscriptArtifactStore(directory!, {
      gzipBytes: async () => {
        throw new Error("fixture gzip failed");
      },
    });

    const report = await repackLegacyTranscriptArtifacts(artifacts, {
      pause: async () => undefined,
    });

    expect(report).toMatchObject({ scanned: 1, repacked: 0, skipped: 1 });
    expect((await lstat(plainPath)).isFile()).toBe(true);
    await expect(artifacts.read(reference)).resolves.toEqual(value);
  });

  it("removes its bad publication and keeps the plain artifact when gzip inflates to wrong bytes", async () => {
    await store();
    const value = artifact("good plain bytes");
    const { bytes, reference } = referenceFor(value);
    const digest = reference.id.slice("sha256:".length);
    const plainPath = join(directory!, `${digest}.json`);
    const compressedPath = join(directory!, `${digest}.json.gz`);
    await writeFile(plainPath, bytes);
    const artifacts = new FileTranscriptArtifactStore(directory!, {
      gzipBytes: async () => gzipAsync(canonicalBytes(artifact("wrong compressed bytes"))),
    });

    const report = await repackLegacyTranscriptArtifacts(artifacts, {
      pause: async () => undefined,
    });

    expect(report).toMatchObject({ scanned: 1, repacked: 0, skipped: 1 });
    expect((await lstat(plainPath)).isFile()).toBe(true);
    await expect(lstat(compressedPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(artifacts.read(reference)).resolves.toEqual(value);
  });

  it("keeps a same-bytes legacy replacement when its file identity changes during publish", async () => {
    await store();
    const value = artifact("identity changed");
    const { bytes, reference } = referenceFor(value);
    const digest = reference.id.slice("sha256:".length);
    const plainPath = join(directory!, `${digest}.json`);
    await writeFile(plainPath, bytes);
    const artifacts = new FileTranscriptArtifactStore(directory!, {
      gzipBytes: async (canonical) => {
        await rm(plainPath);
        await writeFile(plainPath, canonical);
        return gzipAsync(canonical);
      },
    });

    const report = await repackLegacyTranscriptArtifacts(artifacts, {
      pause: async () => undefined,
    });

    expect(report).toMatchObject({ scanned: 1, repacked: 0, skipped: 1 });
    expect((await lstat(plainPath)).isFile()).toBe(true);
    await expect(artifacts.read(reference)).resolves.toEqual(value);
  });

  it("keeps both known-bad gzip and good plain bytes when the repair temp fails verification", async () => {
    await store();
    const value = artifact("repair source survives");
    const { bytes, reference } = referenceFor(value);
    const digest = reference.id.slice("sha256:".length);
    const plainPath = join(directory!, `${digest}.json`);
    const compressedPath = join(directory!, `${digest}.json.gz`);
    const knownBad = Buffer.from([0x1f, 0x8b, 0x08]);
    await writeFile(plainPath, bytes);
    await writeFile(compressedPath, knownBad);
    const artifacts = new FileTranscriptArtifactStore(directory!, {
      gzipBytes: async () => gzipAsync(canonicalBytes(artifact("wrong repair bytes"))),
    });

    const report = await repackLegacyTranscriptArtifacts(artifacts, {
      pause: async () => undefined,
    });

    expect(report).toMatchObject({ scanned: 1, repacked: 0, skipped: 1 });
    await expect(readFile(compressedPath)).resolves.toEqual(knownBad);
    await expect(readFile(plainPath)).resolves.toEqual(bytes);
  });

  it("atomically repairs a known-bad compressed sibling from a verified plain artifact", async () => {
    const artifacts = await store();
    const value = artifact("repair me");
    const { bytes, reference } = referenceFor(value);
    const digest = reference.id.slice("sha256:".length);
    const plainPath = join(directory!, `${digest}.json`);
    const compressedPath = join(directory!, `${digest}.json.gz`);
    await writeFile(plainPath, bytes);
    await writeFile(compressedPath, Buffer.from([0x1f, 0x8b, 0x08]));

    const report = await repackLegacyTranscriptArtifacts(artifacts, {
      pause: async () => undefined,
    });

    expect(report).toMatchObject({ scanned: 1, repacked: 1, skipped: 0 });
    await expect(lstat(plainPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(gunzipAsync(await readFile(compressedPath))).resolves.toEqual(bytes);
    await expect(artifacts.read(reference)).resolves.toEqual(value);
  });

  it("backs off while a turn is live before attempting a legacy batch", async () => {
    await store();
    const entry = referenceFor(artifact("wait for idle"));
    await writeFile(
      join(directory!, `${entry.reference.id.slice("sha256:".length)}.json`),
      entry.bytes,
    );
    const events: string[] = [];
    let live = true;
    const artifacts = new FileTranscriptArtifactStore(directory!, {
      gzipBytes: async (bytes) => {
        events.push("gzip");
        return gzipAsync(bytes);
      },
    });

    const report = await repackLegacyTranscriptArtifacts(artifacts, {
      pause: async () => undefined,
      shouldBackOff: () => {
        events.push(live ? "live" : "idle");
        return live;
      },
      backoff: async () => {
        events.push("backoff");
        live = false;
      },
    } as Parameters<typeof repackLegacyTranscriptArtifacts>[1]);

    expect(report).toMatchObject({ repacked: 1, skipped: 0, aborted: false });
    expect(events).toEqual(["live", "backoff", "idle", "gzip"]);
  });

  it("cancels without touching a legacy artifact while waiting for idle", async () => {
    await store();
    const entry = referenceFor(artifact("quit while busy"));
    const plainPath = join(directory!, `${entry.reference.id.slice("sha256:".length)}.json`);
    await writeFile(plainPath, entry.bytes);
    const controller = new AbortController();
    const artifacts = new FileTranscriptArtifactStore(directory!, {
      gzipBytes: async () => {
        throw new Error("repack ran after cancellation");
      },
    });

    const report = await repackLegacyTranscriptArtifacts(artifacts, {
      signal: controller.signal,
      shouldBackOff: () => true,
      backoff: async () => controller.abort(),
    } as Parameters<typeof repackLegacyTranscriptArtifacts>[1]);

    expect(report).toMatchObject({ repacked: 0, skipped: 0, aborted: true });
    expect((await lstat(plainPath)).isFile()).toBe(true);
  });

  it("an interrupted repack leaves every artifact readable and resumes from siblings", async () => {
    const artifacts = await store();
    const entries = [referenceFor(artifact("alpha")), referenceFor(artifact("beta"))];
    for (const entry of entries) {
      await writeFile(
        join(directory!, `${entry.reference.id.slice("sha256:".length)}.json`),
        entry.bytes,
      );
    }
    const controller = new AbortController();

    const first = await repackLegacyTranscriptArtifacts(artifacts, {
      batchSize: 1,
      signal: controller.signal,
      pause: async () => controller.abort(),
    });

    expect(first).toMatchObject({ scanned: 2, repacked: 1, aborted: true });
    for (const entry of entries) {
      await expect(artifacts.read(entry.reference)).resolves.toEqual(
        JSON.parse(entry.bytes.toString("utf8")),
      );
    }
    const namesAfterInterruption = await readdir(directory!);
    expect(namesAfterInterruption.filter((name) => name.endsWith(".json.gz"))).toHaveLength(1);
    expect(namesAfterInterruption.filter((name) => name.endsWith(".json"))).toHaveLength(1);

    const resumed = await repackLegacyTranscriptArtifacts(artifacts, {
      batchSize: 1,
      pause: async () => undefined,
    });
    expect(resumed).toMatchObject({ scanned: 1, repacked: 1, skipped: 0, aborted: false });
    expect((await readdir(directory!)).filter((name) => name.endsWith(".json"))).toHaveLength(0);
  });
});
