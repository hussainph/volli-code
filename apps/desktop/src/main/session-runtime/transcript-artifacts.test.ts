import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";
import type { SessionTranscriptArtifact } from "@volli/session-engine";

import { createFileTranscriptArtifactStore } from "./transcript-artifacts";

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

describe("FileTranscriptArtifactStore", () => {
  it("writes canonical SHA-256-addressed bytes before returning a reference", async () => {
    const artifacts = await store();
    const value = artifact();
    const reference = await artifacts.write(value);

    expect(reference).toEqual({
      id: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      mediaType: "application/vnd.volli.ui-message+json",
    });
    const name = `${reference.id.slice("sha256:".length)}.json`;
    const bytes = await readFile(join(directory!, name));
    expect(`sha256:${createHash("sha256").update(bytes).digest("hex")}`).toBe(reference.id);
    await expect(artifacts.read(reference)).resolves.toEqual(value);
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
    await expect(
      readFile(join(directory!, `${first.id.slice("sha256:".length)}.json`), "utf8"),
    ).resolves.toBe(
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
    await writeFile(join(directory!, `${reference.id.slice("sha256:".length)}.json`), "corrupt");
    await expect(artifacts.read(reference)).rejects.toThrow("checksum verification");
  });

  it("rejects a digest filename replaced with a symlink", async () => {
    const artifacts = await store();
    const reference = await artifacts.write(artifact());
    const artifactPath = join(directory!, `${reference.id.slice("sha256:".length)}.json`);
    const externalPath = join(directory!, "outside.json");
    await writeFile(externalPath, await readFile(artifactPath));
    await rm(artifactPath);
    await symlink(externalPath, artifactPath);

    await expect(artifacts.read(reference)).rejects.toThrow("not a regular file");
  });
});
