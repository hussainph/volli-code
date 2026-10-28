import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";

import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";

import type { SessionTranscriptArtifact } from "@volli/session-engine";
import {
  ExactValueByteRedactor,
  LOCAL_RUNNER,
  type CredentialStreamStepper,
  type SessionAttachment,
  type TranscriptReference,
} from "@volli/shared";
import { piLogSegmentKey, transcriptPackKey } from "@volli/shared/cloud";

import { createFileTranscriptArtifactStore } from "../session-runtime/transcript-artifacts";
import type { SpoolEvent } from "../transcript-spool/transcript-spool";
import { createMoveHistoryUploader, type MoveBackend } from "./move-history";
import { piLogFilesOf } from "./pi-log-files";

const MOVE = "44444444-4444-4444-8444-444444444444";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";
const RUNNER = "33333333-3333-4333-8333-333333333333";
const SECRET = "sk-move-0123456789";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "volli-move-history-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/**
 * The import's doors as the backend answers them (`projectImportHistory.ts`
 * over `transcripts.ts`'s rules), and a write-once object store behind
 * `projectImports.presignPut`.
 */
function fakeBackend() {
  const calls: { kind: string; path: string; args: Record<string, unknown> }[] = [];
  const segments: Record<string, unknown>[] = [];
  const pi: Record<string, unknown>[] = [];
  const objects = new Map<string, Buffer>();
  let failNextCommit = false;
  let failNextPiCommit = false;
  const backend: MoveBackend = {
    async query(path, args) {
      calls.push({ kind: "query", path, args });
      if (path !== "projectImportHistory:uploadHead") throw new Error(path);
      const piLogs: Record<string, number> = {};
      for (const id of args.piFileIds as string[]) {
        piLogs[id] = Math.max(
          0,
          ...pi.filter((s) => s.piFileId === id).map((s) => s.endOffset as number),
        );
      }
      return {
        transcriptThrough: (segments.at(-1)?.lastSequence as number | undefined) ?? 0,
        piLogs,
      };
    },
    async mutation(path, args) {
      calls.push({ kind: "mutation", path, args });
      if (path === "projectImportHistory:commitSegment") {
        if (failNextCommit) {
          failNextCommit = false;
          throw new Error("network");
        }
        segments.push(args);
      } else if (path === "projectImportHistory:commitPiLogSegment") {
        if (failNextPiCommit) {
          failNextPiCommit = false;
          throw new Error("network");
        }
        pi.push(args);
      } else throw new Error(path);
      return { status: "committed" };
    },
    async action(path, args) {
      calls.push({ kind: "action", path, args });
      if (path !== "projectImportHistory:presignPut") throw new Error(path);
      // The runner's rule: replaceable until a row commits the key.
      const committed = [...segments, ...pi].some((row) => row.key === args.key);
      if (committed) return { status: "committed" };
      return {
        status: "sign",
        request: {
          url: `https://store.test/${args.key as string}`,
          headers: { "x-amz-checksum-sha256": args.sha256 as string },
        },
      };
    },
  };
  const fetch = (async (url: string, init: RequestInit) => {
    const key = url.slice("https://store.test/".length);
    objects.set(key, Buffer.from(init.body as Uint8Array));
    return new Response(null, { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  return {
    backend,
    fetch,
    calls,
    segments,
    pi,
    objects,
    failNextCommit() {
      failNextCommit = true;
    },
    failNextPiCommit() {
      failNextPiCommit = true;
    },
  };
}

const redaction = {
  step: ((window, from, final) =>
    new ExactValueByteRedactor([[SECRET, "‹secret:KEY›"]]).step(
      window,
      from,
      final,
    )) as CredentialStreamStepper,
  complete: () => true,
};

function artifact(text: string): SessionTranscriptArtifact {
  return {
    version: 1,
    threadId: "thread",
    branchId: "branch",
    attemptId: "attempt",
    turnId: "turn-1",
    message: { id: `m-${text.length}`, role: "assistant", parts: [{ type: "text", text }] },
  } as SessionTranscriptArtifact;
}

async function history() {
  const store = createFileTranscriptArtifactStore(join(root, "transcripts"));
  const references: TranscriptReference[] = [
    await store.write(artifact("first reply")),
    await store.write(artifact("second reply")),
  ];
  // What the person sent: named by its command, not by a `transcript.referenced`.
  const asked = await store.write(artifact("the question asked"));
  // A body this machine no longer has.
  const lost: TranscriptReference = {
    id: `sha256:${"d".repeat(64)}`,
    digest: `sha256:${"d".repeat(64)}`,
    mediaType: references[0]!.mediaType,
  };
  const events: SpoolEvent[] = [
    { sequence: 1, recordedAt: 1, payload: { kind: "session.archived" } as never },
    {
      sequence: 2,
      recordedAt: 2,
      payload: {
        kind: "command.recorded",
        command: { intent: { kind: "message.submit", reference: asked } },
      } as never,
    },
    ...[...references, lost].map((reference, index): SpoolEvent => ({
      sequence: index + 3,
      recordedAt: index + 3,
      payload: { kind: "transcript.referenced", turnId: "turn-1", reference } as never,
    })),
  ];
  return { store, references, asked, lost, events };
}

describe("a moved Session's history, uploaded through the import's doors", () => {
  test("packs its transcript and Pi log the runner's way, names what is missing, and resumes", async () => {
    const fake = fakeBackend();
    const { store, references, asked, lost, events } = await history();
    const piDirectory = join(root, "pi-sessions");
    const piFile = join(piDirectory, "--workspace--", "2026-01-01_pi.jsonl");
    await mkdir(join(piDirectory, "--workspace--"), { recursive: true });
    const lines = `${JSON.stringify({ type: "message", text: `key ${SECRET}` })}\n{"type":"end"}\n`;
    await writeFile(piFile, lines);
    const attachments = [
      {
        id: "attachment-1",
        sessionId: SESSION,
        adapterId: "pi",
        venue: LOCAL_RUNNER,
        continuity: "fresh",
        native: {
          id: "pi-1",
          detail: {
            kind: "volli.native-binding.v1",
            locator: { runtime: "pi", sessionId: "pi-1", sessionFilePath: piFile },
          },
        },
        authority: null,
      },
    ] as unknown as SessionAttachment[];
    const piFiles = await piLogFilesOf(attachments, { runnerId: RUNNER, piDirectory });
    expect(piFiles).toEqual([{ attachmentId: "attachment-1", path: piFile }]);

    const uploader = createMoveHistoryUploader({
      moveId: MOVE,
      runnerId: RUNNER,
      backend: fake.backend,
      artifacts: store,
      redaction,
      fetch: fake.fetch,
    });
    const moved = {
      sessionId: SESSION,
      projectId: PROJECT,
      lastSequence: events.length,
      generation: 1,
      eventsAfter: (after: number, limit: number) =>
        events.filter((event) => event.sequence > after).slice(0, limit),
      piFiles,
    };
    // A commit lost on the way: the object is in place, the segment is not.
    fake.failNextCommit();
    await expect(uploader.upload(moved)).rejects.toThrow("network");
    // Then the Pi range's commit is lost, and the log grows before the retry:
    // the retry replaces the uncommitted object and commits what it holds.
    fake.failNextPiCommit();
    await expect(uploader.upload(moved)).rejects.toThrow("network");
    const piKeyAt0 = piLogSegmentKey({
      projectId: PROJECT,
      sessionId: SESSION,
      attachmentId: "attachment-1",
      piFileId: "2026-01-01_pi",
      offset: 0,
    });
    const shorter = fake.objects.get(piKeyAt0)!;
    await appendFile(piFile, '{"type":"later"}\n');
    const grown = `${lines}{"type":"later"}\n`;
    const report = await uploader.upload(moved);

    // The pack committed on the second attempt; this one finds it covered.
    expect(report.transcript).toEqual([]);
    expect(fake.segments).toHaveLength(1);
    expect(fake.segments[0]).toMatchObject({
      firstSequence: 1,
      lastSequence: events.length,
      artifactCount: 3,
    });
    const packKey = transcriptPackKey({
      projectId: PROJECT,
      sessionId: SESSION,
      firstSequence: 1,
      lastSequence: events.length,
    });
    expect(fake.segments).toMatchObject([
      {
        moveId: MOVE,
        sessionId: SESSION,
        claim: { runnerId: RUNNER, generation: 1 },
        key: packKey,
        digests: [asked, ...references].map((reference) => reference.id),
      },
    ]);
    const pack = zstdDecompressSync(fake.objects.get(packKey)!).toString("utf8");
    expect(pack).toContain("first reply");
    expect(pack).toContain("the question asked");
    expect(pack).toContain(lost.id);
    expect(fake.segments[0]!.sha256).toBe(sha256(fake.objects.get(packKey)!));

    expect(report.piLogs.segments).toMatchObject([
      { piFileId: "2026-01-01_pi", startOffset: 0, endOffset: Buffer.byteLength(grown) },
    ]);
    const stored = fake.objects.get(piKeyAt0)!;
    expect(stored.equals(shorter)).toBe(false);
    const uploadedLog = zstdDecompressSync(stored).toString("utf8");
    expect(uploadedLog).toContain("later");
    expect(uploadedLog).not.toContain(SECRET);
    expect(fake.pi).toMatchObject([
      { moveId: MOVE, key: piKeyAt0, startOffset: 0, sha256: sha256(stored) },
    ]);

    // Nothing is presigned outside the move, and a re-run packs nothing again.
    expect(
      fake.calls.filter(({ kind }) => kind === "action").every(({ args }) => args.moveId === MOVE),
    ).toBe(true);
    const again = await uploader.upload(moved);
    expect(again).toEqual({
      transcript: [],
      piLogs: { segments: [], missing: [], truncated: [], oversized: [] },
      missing: [],
    });
  });

  test("names a body this machine no longer has, and packs the rest", async () => {
    const fake = fakeBackend();
    const { store, lost, events } = await history();
    const report = await createMoveHistoryUploader({
      moveId: MOVE,
      runnerId: RUNNER,
      backend: fake.backend,
      artifacts: store,
      redaction,
      fetch: fake.fetch,
    }).upload({
      sessionId: SESSION,
      projectId: PROJECT,
      lastSequence: events.length,
      generation: 1,
      eventsAfter: (after, limit) =>
        events.filter((event) => event.sequence > after).slice(0, limit),
      piFiles: [],
    });
    expect(report.missing).toEqual([lost.id]);
    expect(report.transcript).toMatchObject([
      { firstSequence: 1, lastSequence: events.length, artifactCount: 3, status: "committed" },
    ]);
  });

  test("refuses a Session already uploading, and a body that fails to read", async () => {
    const fake = fakeBackend();
    const { events } = await history();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const uploader = createMoveHistoryUploader({
      moveId: MOVE,
      runnerId: RUNNER,
      backend: fake.backend,
      artifacts: {
        async readCanonicalBytes() {
          await held;
          throw new Error("corrupt body");
        },
      },
      redaction,
      fetch: fake.fetch,
    });
    const moved = {
      sessionId: SESSION,
      projectId: PROJECT,
      lastSequence: events.length,
      generation: 1,
      eventsAfter: (after: number, limit: number) =>
        events.filter((event) => event.sequence > after).slice(0, limit),
      piFiles: [],
    };
    const first = uploader.upload(moved);
    await expect(uploader.upload(moved)).rejects.toThrow("already uploading");
    release();
    await expect(first).rejects.toThrow("corrupt body");
    expect(fake.segments).toEqual([]);
  });
});
