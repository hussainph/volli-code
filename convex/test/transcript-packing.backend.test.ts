/**
 * The production runner -> cloud store -> pinned backend -> HTTP object-store
 * path. Bodies originate in durable gzip artifacts, facts in the real SQLite
 * engine, and Pi files in an attachment's native recovery reference. No test
 * stages a body or constructs a spool/publisher directly.
 */
import { randomUUID } from "node:crypto";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync, zstdDecompressSync } from "node:zlib";

import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vite-plus/test";

import { sqliteDrainCursorStore } from "@volli/host-core/cloud-runner";
import { canonicalJson, type SessionTranscriptArtifact } from "@volli/session-engine";
import { LOCAL_RUNNER, type SessionAttachment, type SessionEventProvenance } from "@volli/shared";
import {
  TRANSCRIPT_PACK_INTERVAL_MS,
  piLogSegmentKey,
  transcriptPackKey,
  type SessionClaimFence,
} from "@volli/shared/cloud";

import { api, internal } from "../functions/_generated/api";
import type { Doc } from "../functions/_generated/dataModel.js";
import { connectBackend } from "../fixture/testing";
import {
  CANARY,
  historyWorld,
  linkHistoryRunner,
  sha256,
  startHistoryS3,
  until,
  type HistoryS3,
  type HistoryWorld,
} from "./transcript-packing-fixture";

const backend = connectBackend();
const user: SessionEventProvenance = {
  source: { kind: "user", id: "desktop", detail: { sessionOrigin: { kind: "user" } } },
  venue: LOCAL_RUNNER,
};
const pi: SessionEventProvenance = {
  source: { kind: "adapter", id: "pi", detail: null },
  venue: LOCAL_RUNNER,
};
let s3: HistoryS3;
let world: HistoryWorld | undefined;
beforeAll(async () => {
  s3 = await startHistoryS3();
});
afterEach(async () => {
  await world?.close();
  world = undefined;
  vi.restoreAllMocks();
});
afterAll(async () => {
  await s3?.close();
});

const envelope = (sessionId: string) => ({
  id: randomUUID(),
  sessionId,
  occurredAt: Date.now(),
  provenance: pi,
});
const fence = (w: HistoryWorld): SessionClaimFence => ({ runnerId: w.runner.id, generation: 1 });
const cursor = (w: HistoryWorld, sessionId: string) => sqliteDrainCursorStore(w.db).get(sessionId);

async function birth(w: HistoryWorld) {
  const sessionId = randomUUID();
  await w.cloud.engine.createSession({
    requestedSessionId: sessionId,
    commandId: randomUUID(),
    projectId: w.projectId,
    ticketId: null,
    role: "project",
    parentSessionId: null,
    title: "Packed history",
    provenance: user,
  });
  return sessionId;
}

async function attach(w: HistoryWorld, sessionId: string, path: string) {
  const start = await w.cloud.engine.submit({
    commandId: randomUUID(),
    sessionId,
    intent: { kind: "executor.start", adapterId: "pi", continuity: "fresh" },
    provenance: user,
  });
  const attachment: SessionAttachment = {
    id: randomUUID(),
    sessionId,
    adapterId: "pi",
    venue: LOCAL_RUNNER,
    continuity: "fresh",
    native: { id: null, detail: null },
    authority: null,
  };
  await w.cloud.engine.observe({
    ...envelope(sessionId),
    kind: "attachment.opened",
    commandId: start.command.id,
    attachment,
  });
  // Pi learns its session file after opening; discovery must fold this later
  // native reference, not just inspect attachment.opened or a live runtime.
  const nativeSessionId = randomUUID();
  await w.cloud.engine.observe({
    ...envelope(sessionId),
    kind: "attachment.native_referenced",
    attachmentId: attachment.id,
    native: {
      id: nativeSessionId,
      detail: {
        kind: "volli.native-binding.v1",
        directory: w.root,
        runtime: { path: "pi", version: "fixture", fingerprint: "fixture" },
        locator: { runtime: "pi", sessionId: nativeSessionId, sessionFilePath: path },
      },
    },
  });
  return attachment;
}

async function reply(w: HistoryWorld, attachment: SessionAttachment, text: string) {
  const { sessionId } = attachment;
  const turnId = randomUUID();
  await w.cloud.engine.observe({
    ...envelope(sessionId),
    kind: "turn.started",
    attachmentId: attachment.id,
    turnId,
  });
  const artifact: SessionTranscriptArtifact = {
    version: 1,
    threadId: sessionId,
    branchId: sessionId,
    attemptId: turnId,
    turnId,
    message: { id: randomUUID(), role: "assistant", parts: [{ type: "text", text }] },
  };
  const reference = await w.artifacts.write(artifact);
  await w.cloud.engine.observe({
    ...envelope(sessionId),
    kind: "transcript.referenced",
    attachmentId: attachment.id,
    turnId,
    reference,
    digest: { role: "assistant", reply: true },
  });
  return { turnId, reference, artifact };
}

async function end(
  w: HistoryWorld,
  attachment: SessionAttachment,
  turnId: string,
  interrupted = false,
) {
  return w.cloud.engine.observe({
    ...envelope(attachment.sessionId),
    kind: interrupted ? "turn.interrupted" : "turn.completed",
    attachmentId: attachment.id,
    turnId,
  });
}
async function closeAttachment(w: HistoryWorld, attachment: SessionAttachment) {
  return w.cloud.engine.observe({
    ...envelope(attachment.sessionId),
    kind: "attachment.closed",
    attachmentId: attachment.id,
    outcome: "completed",
  });
}
async function accepted(w: HistoryWorld, sessionId: string) {
  const sequence = await w.cloud.engine.latestEventSequence({ sessionId });
  await until(
    () => cursor(w, sessionId)?.acceptedThrough === sequence,
    `accept through ${sequence}`,
  );
  return sequence;
}
async function packed(
  w: HistoryWorld,
  sessionId: string,
  sequence: number,
  piFileId?: string,
  offset?: number,
) {
  await until(
    async () => {
      const head = await w.runner.http.query(api.transcripts.head, {
        sessionId,
        claim: fence(w),
        piFileIds: piFileId ? [piFileId] : [],
      });
      return head.transcriptThrough === sequence && (!piFileId || head.piLogs[piFileId] === offset);
    },
    `pack through ${sequence}${piFileId ? ` and Pi offset ${offset}` : ""}`,
  );
}

/** Fetch through the viewer's real signed read, then check against the index. */
async function readPacks(w: HistoryWorld, sessionId: string) {
  const manifest = await w.person.query(api.sessionTranscript.segments, { sessionId });
  const decoded: {
    header: {
      firstSequence: number;
      lastSequence: number;
      turnIds: string[];
      artifactCount: number;
      format: string;
    };
    entries: {
      digest: string;
      bytes: number;
      redacted?: boolean;
      body: SessionTranscriptArtifact;
    }[];
  }[] = [];
  let previous = 0;
  for (const segment of manifest.segments) {
    expect(segment.firstSequence).toBe(previous + 1);
    previous = segment.lastSequence;
    const grant = await w.person.action(api.sessionTranscript.presignGet, {
      sessionId,
      object: { kind: "pack", segmentId: segment.segmentId },
    });
    if (grant.status !== "sign") throw new Error("Committed pack has no signed read");
    const response = await fetch(grant.request.url, { headers: grant.request.headers });
    expect(response.status).toBe(200);
    const compressed = Buffer.from(await response.arrayBuffer());
    expect(compressed.length).toBe(segment.bytes);
    expect(sha256(compressed)).toBe(segment.sha256);
    expect(grant.bytes).toBe(segment.bytes);
    expect(grant.sha256).toBe(segment.sha256);
    const text = zstdDecompressSync(compressed).toString("utf8");
    expect(text.endsWith("\n")).toBe(true);
    expect(text).not.toContain("packing-canary-");
    const [header, ...entries] = text
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(header).toMatchObject({
      format: "volli.transcript-pack/1",
      sessionId,
      firstSequence: segment.firstSequence,
      lastSequence: segment.lastSequence,
      turnIds: segment.turnIds,
      artifactCount: segment.artifactCount,
    });
    for (const entry of entries)
      expect(entry.bytes).toBe(Buffer.byteLength(canonicalJson(entry.body)));
    decoded.push({ header, entries });
  }
  expect(previous).toBe(manifest.packedThrough);
  return { manifest, decoded };
}

function piObjects(w: HistoryWorld, sessionId: string, attachmentId: string, piFileId: string) {
  const prefix = piLogSegmentKey({
    projectId: w.projectId,
    sessionId,
    attachmentId,
    piFileId,
    offset: 0,
  }).replace(/0{15}\.jsonl\.zst$/u, "");
  return [...s3.objects.values()]
    .filter(({ key }) => key.startsWith(prefix))
    .toSorted((a, b) => a.key.localeCompare(b.key));
}

describe("transcript packing through the production cloud store", () => {
  test("packs multiple finished turns, redacts spills and Pi bytes, and resumes after reconnect and a disk reopen", async () => {
    const w = (world = await historyWorld());
    const sessionId = await birth(w);
    const piFileId = `first-${randomUUID()}`;
    const path = join(w.piDirectory, `${piFileId}.jsonl`);
    const firstLine = Buffer.from(`${JSON.stringify({ type: "message", text: `π ${CANARY}` })}\n`);
    const secondLine = Buffer.from(
      `${JSON.stringify({ type: "message", text: `résumé ${CANARY}` })}\n`,
    );
    const split = secondLine.indexOf(Buffer.from("é")) + 1; // half a multibyte codepoint, no newline
    await writeFile(path, Buffer.concat([firstLine, secondLine.subarray(0, split)]));
    const attachment = await attach(w, sessionId, path);
    const one = await reply(w, attachment, `First ${CANARY}`);
    await end(w, attachment, one.turnId);
    const two = await reply(w, attachment, `Second ${CANARY} ${"large body ".repeat(8_000)}`);
    await end(w, attachment, two.turnId, true);
    await closeAttachment(w, attachment);
    expect(cursor(w, sessionId)?.acceptedThrough).toBe(0); // offline birth + complete turns

    // The upload was persisted but its acknowledgement was lost. A real
    // reconnect retries it; no backend function or fetch is mocked.
    const lostBefore = s3.lostReplies;
    s3.loseNextPut(/\/tx\//u);
    await w.connect();
    await until(() => s3.lostReplies > lostBefore, "lost upload acknowledgement");
    const sockets = w.connections;
    w.link!.reconnectNow();
    await until(
      () => w.connections > sockets && w.link?.status.state === "connected",
      "replacement socket",
    );
    const through = await accepted(w, sessionId);
    await packed(w, sessionId, through, piFileId, firstLine.length);
    const { manifest, decoded } = await readPacks(w, sessionId);
    expect(decoded.flatMap(({ header }) => header.turnIds)).toEqual(
      expect.arrayContaining([one.turnId, two.turnId]),
    );
    const entries = decoded.flatMap((pack) => pack.entries);
    expect(entries.map(({ digest }) => digest).toSorted()).toEqual(
      [one.reference.id, two.reference.id].toSorted(),
    );
    expect(entries.every(({ redacted }) => redacted === true)).toBe(true);
    expect(canonicalJson(entries)).toContain("‹secret:PACKING_CANARY›");
    const prefix = `v1/p/${w.projectId}/s/${sessionId}/`;
    const packPuts = s3.puts.filter(({ key }) => key.startsWith(`${prefix}tx/`));
    expect(packPuts.length).toBeGreaterThan(manifest.segments.length);
    for (const object of packPuts) {
      expect(s3.objects.get(object.key)!.sha256).toBe(object.sha256); // byte-identical retry
    }
    const staged = await w.person.query(api.sessionTranscript.artifacts, {
      sessionId,
      digests: [one.reference.id, two.reference.id],
    });
    expect(staged[0]).toMatchObject({ status: "inline" });
    expect(staged[1]).toMatchObject({ status: "spilled" });
    const spill = await w.person.action(api.sessionTranscript.presignGet, {
      sessionId,
      object: { kind: "spill", digest: two.reference.id },
    });
    if (spill.status !== "sign") throw new Error("Large artifact was not spilled");
    const spillResponse = await fetch(spill.request.url, { headers: spill.request.headers });
    expect(spillResponse.status).toBe(200);
    const spillText = zstdDecompressSync(Buffer.from(await spillResponse.arrayBuffer())).toString(
      "utf8",
    );
    expect(spillText).toContain("‹secret:PACKING_CANARY›");
    expect(spillText).not.toContain("packing-canary-");
    expect(JSON.parse(spillText)).toEqual(
      entries.find(({ digest }) => digest === two.reference.id)!.body,
    );

    // Exercise the pinned backend's existing dashboard contract used by the
    // acceptance journey. Age ONLY rows whose bodies the HTTP reads above
    // verified in committed packs; do not inject or change any body.
    const adminKey = process.env.VOLLI_CONVEX_ADMIN_KEY;
    if (!adminKey) throw new Error("Missing throwaway fixture admin key");
    const admin = new ConvexHttpClient(backend.url);
    (admin as unknown as { setAdminAuth(key: string): void }).setAdminAuth(adminKey);
    const tableData = makeFunctionReference<
      "query",
      { table: string; order: "asc"; paginationOpts: { numItems: number; cursor: string | null } },
      { page: Doc<"transcriptArtifacts">[]; isDone: boolean; continueCursor: string }
    >("_system/cli/tableData:default");
    const packedRows: Doc<"transcriptArtifacts">[] = [];
    let tableCursor: string | null = null;
    for (let pageIndex = 0; pageIndex < 10; pageIndex += 1) {
      const page: { page: Doc<"transcriptArtifacts">[]; isDone: boolean; continueCursor: string } =
        await admin.query(tableData, {
          table: "transcriptArtifacts",
          order: "asc",
          paginationOpts: { numItems: 128, cursor: tableCursor },
        });
      packedRows.push(...page.page.filter((row) => row.sessionId === sessionId));
      if (page.isDone) break;
      if (pageIndex === 9) throw new Error("Fixture transcriptArtifacts exceeded ten admin pages");
      tableCursor = page.continueCursor;
    }
    expect(packedRows).toHaveLength(2);
    for (const row of packedRows) {
      expect(row.packedSegmentId).not.toBeNull();
      expect(row.expiresAt).toBeGreaterThan(0);
      const index = manifest.segments.findIndex(
        ({ segmentId }) => segmentId === row.packedSegmentId,
      );
      expect(index).toBeGreaterThanOrEqual(0);
      expect(decoded[index]!.entries.map(({ digest }) => digest)).toContain(row.digest);
    }
    const patchExpiry = makeFunctionReference<
      "mutation",
      { table: string; ids: string[]; fields: { expiresAt: number } },
      { success: boolean }
    >("_system/frontend/patchDocumentsFields:default");
    await expect(
      admin.mutation(patchExpiry, {
        table: "transcriptArtifacts",
        ids: packedRows.map(({ _id }) => _id),
        fields: { expiresAt: 0 },
      }),
    ).resolves.toMatchObject({ success: true });
    await admin.mutation(makeFunctionReference<"mutation">("transcripts:sweepPacked"), {});
    await expect(
      w.person.query(api.sessionTranscript.artifacts, {
        sessionId,
        digests: [one.reference.id, two.reference.id],
      }),
    ).resolves.toEqual([
      { digest: one.reference.id, status: "absent" },
      { digest: two.reference.id, status: "absent" },
    ]);
    expect(await readPacks(w, sessionId)).toEqual({ manifest, decoded });

    const initialPi = piObjects(w, sessionId, attachment.id, piFileId);
    expect(initialPi).toHaveLength(1);
    const piText = zstdDecompressSync(initialPi[0]!.body).toString("utf8");
    expect(JSON.parse(piText)).toEqual({ type: "message", text: "π ‹secret:PACKING_CANARY›" });
    expect(Buffer.byteLength(piText)).not.toBe(firstLine.length); // source offsets, not redacted lengths

    // Reopen SQLite, the gzip store, SecretStore and cloud-store. No Session
    // wake is replayed: connect must discover pending complete Pi lines even
    // on a closed attachment, and must not re-upload committed packs/ranges.
    const beforeRestart = s3.puts.length;
    await w.restart();
    await appendFile(path, secondLine.subarray(split));
    await w.connect();
    await packed(w, sessionId, through, piFileId, firstLine.length + secondLine.length);
    expect(await w.person.query(api.sessionTranscript.segments, { sessionId })).toEqual(manifest);
    const resumedPuts = s3.puts.slice(beforeRestart);
    expect(resumedPuts).toHaveLength(1);
    expect(resumedPuts[0]!.key).toBe(
      piLogSegmentKey({
        projectId: w.projectId,
        sessionId,
        attachmentId: attachment.id,
        piFileId,
        offset: firstLine.length,
      }),
    );
    const allPi = piObjects(w, sessionId, attachment.id, piFileId);
    expect(allPi).toHaveLength(2);
    expect(JSON.parse(zstdDecompressSync(allPi[1]!.body).toString("utf8"))).toEqual({
      type: "message",
      text: "résumé ‹secret:PACKING_CANARY›",
    });
    for (const original of [one, two]) {
      expect(await w.artifacts.read(original.reference)).toEqual(original.artifact);
      const local = await readFile(
        join(w.artifactPath, `${original.reference.id.slice(7)}.json.gz`),
      );
      expect([...local.subarray(0, 2)]).toEqual([0x1f, 0x8b]);
      expect(gunzipSync(local).toString("utf8")).toBe(canonicalJson(original.artifact));
    }
    expect(s3.failures).toEqual([]);
  }, 60_000);

  test("live turn ends, the four-MB/ten-minute long-turn bounds and attachment close pack through composition", async () => {
    const w = (world = await historyWorld());
    const sessionId = await birth(w);
    const piFileId = `live-${randomUUID()}`;
    const path = join(w.piDirectory, `${piFileId}.jsonl`);
    await writeFile(path, "");
    const intervals = vi.spyOn(globalThis, "setInterval");
    await w.connect();
    await accepted(w, sessionId);
    const attachment = await attach(w, sessionId, path);
    for (const interrupted of [false, true]) {
      const turn = await reply(w, attachment, `Live ${interrupted} ${CANARY}`);
      const completed = await end(w, attachment, turn.turnId, interrupted);
      await accepted(w, sessionId);
      await packed(w, sessionId, completed.sequence);
    }
    const long = await reply(w, attachment, `Still streaming ${CANARY}`);
    const activeThrough = await accepted(w, sessionId);
    const beforeInterval = await w.person.query(api.sessionTranscript.segments, { sessionId });
    expect(beforeInterval.packedThrough).toBeLessThan(activeThrough);
    // Invoke only the production ten-minute interval's callback. Advancing
    // global fake time would also run Convex/WebSocket/inbox timers 600 times.
    const timer = intervals.mock.calls.find(([, ms]) => ms === TRANSCRIPT_PACK_INTERVAL_MS);
    if (typeof timer?.[0] !== "function") throw new Error("No ten-minute packing interval");
    timer[0]();
    await packed(w, sessionId, activeThrough);
    expect((await w.cloud.engine.getSession({ sessionId }))?.turnActive).toBe(true);
    await end(w, attachment, long.turnId);
    await accepted(w, sessionId);
    // Create AFTER connect, with no terminal fact in this Session: neither
    // startup recovery nor the earlier Session's turn-end passes can pack it.
    const largeSessionId = await birth(w);
    const largePath = join(w.piDirectory, `large-${randomUUID()}.jsonl`);
    await writeFile(largePath, "");
    const largeAttachment = await attach(w, largeSessionId, largePath);
    const large = await reply(
      w,
      largeAttachment,
      `Four MB ${CANARY} ${"x".repeat(4 * 1024 * 1024)}`,
    );
    const largeThrough = await accepted(w, largeSessionId);
    // No turn end and no interval callback: accepted artifact bytes alone
    // must invoke the production worker through FileTranscriptArtifactStore.byteLength.
    await packed(w, largeSessionId, largeThrough);
    expect((await w.cloud.engine.getSession({ sessionId: largeSessionId }))?.turnActive).toBe(true);
    const largePacks = await readPacks(w, largeSessionId);
    expect(largePacks.decoded.flatMap((pack) => pack.entries).map(({ digest }) => digest)).toEqual([
      large.reference.id,
    ]);
    const tail = Buffer.from(`${JSON.stringify({ type: "close", text: CANARY })}\n`);
    await appendFile(path, tail);
    const closed = await closeAttachment(w, attachment);
    await accepted(w, sessionId);
    await packed(w, sessionId, closed.sequence, piFileId, tail.length);
    const { decoded } = await readPacks(w, sessionId);
    expect(decoded.flatMap((pack) => pack.entries)).toHaveLength(3);
    expect(piObjects(w, sessionId, attachment.id, piFileId)).toHaveLength(1);
    expect(s3.failures).toEqual([]);
  }, 60_000);

  test("a claim transfer during a real PUT fences the old commit, later accepts and presigns", async () => {
    const w = (world = await historyWorld());
    const sessionId = await birth(w);
    const path = join(w.piDirectory, `fenced-${randomUUID()}.jsonl`);
    await writeFile(path, `${JSON.stringify({ text: CANARY })}\n`);
    const attachment = await attach(w, sessionId, path);
    const turn = await reply(w, attachment, `Before handoff ${CANARY}`);
    await end(w, attachment, turn.turnId);
    const held = s3.holdNextPut(new RegExp(`/s/${sessionId}/tx/`, "u"));
    let uploaded: Awaited<typeof held.uploaded> | undefined;
    void held.uploaded.then((object) => {
      uploaded = object;
    });
    try {
      await w.connect();
      await until(() => uploaded !== undefined, "in-flight pack PUT");
      const through = await accepted(w, sessionId);
      const next = await linkHistoryRunner(w.person);
      await expect(
        backend.admin(internal.sessions.transferClaim, {
          sessionId,
          toRunnerId: next.id,
          headSequence: through,
        }),
      ).resolves.toEqual({ generation: 2 });
      held.release();
      const stale = { sessionId, claim: fence(w) };
      await expect(
        w.runner.http.action(api.files.presignPut, {
          ...stale,
          key: uploaded!.key,
          bytes: uploaded!.body.length,
          sha256: uploaded!.sha256,
        }),
      ).rejects.toMatchObject({ data: { code: "stale_claim" } });
      await expect(
        w.runner.http.mutation(api.transcripts.commitSegment, {
          ...stale,
          segmentId: randomUUID(),
          firstSequence: 1,
          lastSequence: through,
          key: transcriptPackKey({
            projectId: w.projectId,
            sessionId,
            firstSequence: 1,
            lastSequence: through,
          }),
          bytes: uploaded!.body.length,
          sha256: uploaded!.sha256,
          turnIds: [turn.turnId],
          artifactCount: 1,
          digests: [turn.reference.id],
        }),
      ).rejects.toMatchObject({ data: { code: "stale_claim" } });
      await expect(
        w.runner.http.mutation(api.transcripts.commitPiLogSegment, {
          ...stale,
          attachmentId: attachment.id,
          piFileId: "fenced",
          startOffset: 0,
          endOffset: 1,
          key: piLogSegmentKey({
            projectId: w.projectId,
            sessionId,
            attachmentId: attachment.id,
            piFileId: "fenced",
            offset: 0,
          }),
          bytes: 1,
          sha256: "a".repeat(64),
        }),
      ).rejects.toMatchObject({ data: { code: "stale_claim" } });
      // The real store is still running on generation 1: a subsequent event
      // must hit the drain's durable fence, not create another upload.
      const later = await reply(w, attachment, "Old runner must stop");
      await end(w, attachment, later.turnId);
      await until(() => cursor(w, sessionId)?.blocked?.code === "fenced", "durable claim fence");
      expect(cursor(w, sessionId)?.acceptedThrough).toBe(through);
      expect(
        await next.http.query(api.transcripts.head, {
          sessionId,
          claim: { runnerId: next.id, generation: 2 },
          piFileIds: [],
        }),
      ).toEqual({ transcriptThrough: 0, piLogs: {} });
      const manifest = await w.person.query(api.sessionTranscript.segments, { sessionId });
      expect(manifest.segments).toEqual([]); // uploaded object never became visible history
      expect(s3.puts.filter(({ key }) => key.includes(`/s/${sessionId}/`))).toHaveLength(1);
      expect(s3.failures).toEqual([]);
    } finally {
      held.release();
    }
  }, 60_000);
});
