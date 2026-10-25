import { replyText } from "@volli/session-engine";
import type { RendererSessionEvent } from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";

import {
  CHUNK_STREAMS_MAX,
  CloudChunkFold,
  cloudFrames,
  cloudLatestReply,
  cloudProjection,
  cloudSnapshotSettled,
  readCloudHistory,
  readCloudSnapshot,
  readTranscriptMessage,
  transcriptReferenceOf,
} from "./cloud-session-view";
import {
  SESSION_ID,
  appendOp,
  attachmentEndedEvent,
  artifactOf,
  chunksAnswer,
  digestOf,
  historyAnswer,
  messageOf,
  referencedEvent,
  resetOp,
  snapshotAnswer,
  turnEvent,
  viewJson,
} from "./cloud-session.test-support";

/** The reply location a snapshot whose state names `latestReply` reads. */
function replyAt(latestReply: unknown) {
  return readCloudSnapshot(snapshotAnswer(3, viewJson({ latestReply }))).latestReply;
}

/** A `command.recorded` event carrying `intent`, as far as the reference rule reads it. */
function recorded(intent: Record<string, unknown>): RendererSessionEvent {
  return {
    payload: { kind: "command.recorded", command: { intent } },
  } as unknown as RendererSessionEvent;
}

describe("readCloudSnapshot", () => {
  it("reads the bounded fold as the chat core's projection", () => {
    const read = readCloudSnapshot(
      snapshotAnswer(
        7,
        viewJson({
          turnActive: true,
          liveAttachment: { id: "attach-1", status: "open", native: null },
          todoList: { items: [] },
          latestReply: {
            sequence: 6,
            reference: { id: "artifact-6", mediaType: null, digest: digestOf(6) },
          },
        }),
      ),
    );
    expect(read.throughSequence).toBe(7);
    expect(read.projection).toMatchObject({
      session: { id: SESSION_ID },
      status: "open",
      turnActive: true,
      liveExecutor: { id: "attach-1" },
      attention: { active: [], primary: null },
      interactions: { active: [], resolved: [] },
      scheduledResume: null,
      todoList: { items: [] },
      bornTicketless: true,
    });
    // Only `{ id }` of the attachment crosses into the projection.
    expect(read.projection.liveExecutor).toEqual({ id: "attach-1" });
    expect("modelAuto" in read.projection).toBe(false);
    expect(read.latestReply).toEqual({
      sequence: 6,
      reference: { id: "artifact-6", mediaType: null, digest: digestOf(6) },
    });
  });

  it("refuses a Session with nothing folded yet, and malformed answers", () => {
    expect(() => readCloudSnapshot(snapshotAnswer(0, null))).toThrow(/still arriving/u);
    expect(() => readCloudSnapshot({ foldedThrough: -1, state: null })).toThrow(/malformed/u);
    expect(() => readCloudSnapshot({ foldedThrough: 1, state: "{" })).toThrow(/malformed/u);
    expect(() => cloudProjection(viewJson({ turnActive: "yes" }))).toThrow(/turnActive/u);
    expect(() => cloudProjection(viewJson({ attention: { active: [1] } }))).toThrow(/attention/u);
    expect(() => cloudProjection(viewJson({ liveAttachment: { id: 3 } }))).toThrow(
      /liveAttachment/u,
    );
  });
});

describe("readCloudHistory", () => {
  it("orders the facts, names their bodies, and keeps unreadable ones as cursor-only entries", () => {
    const read = readCloudHistory(
      historyAnswer(
        [
          { sequence: 3, event: referencedEvent(3) },
          { sequence: 2, status: "unknown_kind", event: null },
          { sequence: 1, event: turnEvent(1, "turn.started") },
        ],
        true,
      ),
    );
    expect(read.hasMore).toBe(true);
    expect(read.entries.map((entry) => entry.sequence)).toEqual([1, 2, 3]);
    expect(read.entries[0]!.reference).toBeNull();
    expect(read.entries[1]!.event).toBeNull();
    expect(read.entries[2]!.reference).toEqual({
      id: "artifact-3",
      mediaType: null,
      digest: digestOf(3),
    });
  });

  it("fails loudly on a malformed page", () => {
    expect(() => readCloudHistory({ events: "nope", hasMore: false })).toThrow(/malformed/u);
    expect(() => readCloudHistory({ events: [{ sequence: 0 }], hasMore: false })).toThrow(
      /malformed/u,
    );
    expect(() =>
      readCloudHistory({ events: [{ sequence: 1, status: "ok", event: "{" }], hasMore: false }),
    ).toThrow(/event 1/u);
  });

  it("builds frames with their bodies inlined and no frame for an unreadable fact", () => {
    const read = readCloudHistory(
      historyAnswer([
        { sequence: 1, event: referencedEvent(1) },
        { sequence: 2, status: "quarantined", event: null },
      ]),
    );
    const message = messageOf("m1", "hello");
    expect(cloudFrames(SESSION_ID, read.entries, new Map([[1, message]]))).toEqual([
      { sessionId: SESSION_ID, sequence: 1, event: referencedEvent(1), transcript: { message } },
    ]);
  });
});

describe("readTranscriptMessage", () => {
  it("reads an artifact or a bare message, and nothing malformed", () => {
    const message = messageOf("m1", "hello");
    expect(readTranscriptMessage(artifactOf(message))).toEqual(message);
    expect(readTranscriptMessage(message)).toEqual(message);
    expect(readTranscriptMessage({ message: { id: "m1", role: "tool", parts: [] } })).toBeNull();
    expect(readTranscriptMessage({ id: "m1", role: "user", parts: [null] })).toBeNull();
  });

  it("gives the snapshot's reply baseline only when the body is at hand", () => {
    const location = {
      sequence: 4,
      reference: { id: "artifact-4", mediaType: null, digest: digestOf(4) },
    };
    expect(cloudLatestReply(location, messageOf("m4", "the answer"), replyText)).toEqual({
      sequence: 4,
      text: "the answer",
    });
    expect(cloudLatestReply(location, undefined, replyText)).toBeNull();
    expect(cloudLatestReply(null, messageOf("m4", "x"), replyText)).toBeNull();
  });
});

describe("CloudChunkFold", () => {
  it("starts at a baseline, folds the next chunks in order, and moves its cursor", () => {
    const fold = new CloudChunkFold(SESSION_ID);
    const first = fold.read(
      chunksAnswer([
        {
          messageId: "m1",
          chunks: [
            { seq: 3, baseline: true, throughSequence: 4, ops: [resetOp("m1", "Hel")] },
            { seq: 4, throughSequence: 4, ops: [appendOp("lo")] },
          ],
        },
      ]),
      0,
    );
    expect(first.moved).toBe(true);
    expect(first.overlays).toEqual([
      {
        kind: "overlay",
        sessionId: SESSION_ID,
        throughSequence: 4,
        messageId: "m1",
        delta: resetOp("m1", "Hel"),
      },
      {
        kind: "overlay",
        sessionId: SESSION_ID,
        throughSequence: 4,
        messageId: "m1",
        delta: appendOp("lo"),
      },
    ]);
    expect(fold.cursors()).toEqual([{ messageId: "m1", seq: 4 }]);
    // The same answer again folds nothing.
    expect(
      fold.read(
        chunksAnswer([{ messageId: "m1", chunks: [{ seq: 4, ops: [appendOp("lo")] }] }]),
        0,
      ),
    ).toEqual({ overlays: [], moved: false });
  });

  it("ignores a stream after a gap until its next baseline", () => {
    const fold = new CloudChunkFold(SESSION_ID);
    fold.read(
      chunksAnswer([
        { messageId: "m1", chunks: [{ seq: 0, baseline: true, ops: [resetOp("m1", "a")] }] },
      ]),
      0,
    );
    const gapped = fold.read(
      chunksAnswer([
        {
          messageId: "m1",
          chunks: [
            { seq: 2, ops: [appendOp("c")] },
            { seq: 3, ops: [appendOp("d")] },
          ],
        },
      ]),
      0,
    );
    expect(gapped).toEqual({ overlays: [], moved: false });
    const healed = fold.read(
      chunksAnswer([
        {
          messageId: "m1",
          chunks: [
            { seq: 5, baseline: true, ops: [resetOp("m1", "abcde")] },
            { seq: 6, ops: [appendOp("f")] },
          ],
        },
      ]),
      0,
    );
    expect(healed.overlays.map((overlay) => overlay.delta.op)).toEqual(["reset", "part.append"]);
    expect(fold.cursors()).toEqual([{ messageId: "m1", seq: 6 }]);
  });

  it("does not start a stream without a baseline, and treats an unreadable chunk as a gap", () => {
    const fold = new CloudChunkFold(SESSION_ID);
    expect(
      fold.read(chunksAnswer([{ messageId: "m1", chunks: [{ seq: 1, ops: [appendOp("x")] }] }]), 0),
    ).toEqual({ overlays: [], moved: false });
    fold.read(
      chunksAnswer([
        { messageId: "m2", chunks: [{ seq: 0, baseline: true, ops: [resetOp("m2", "a")] }] },
      ]),
      0,
    );
    // A non-baseline chunk that starts with a reset is refused by the shared check.
    const refused = fold.read(
      chunksAnswer([
        {
          messageId: "m2",
          chunks: [
            { seq: 1, ops: [resetOp("m2", "b")] },
            { seq: 2, ops: [appendOp("c")] },
          ],
        },
      ]),
      0,
    );
    expect(refused).toEqual({ overlays: [], moved: false });
    expect(fold.cursors()).toEqual([{ messageId: "m2", seq: 0 }]);
  });

  it("keeps at most the backend's stream limit of cursors, newest first, removing what it drops", () => {
    const fold = new CloudChunkFold(SESSION_ID);
    const removed: string[] = [];
    for (let index = 0; index < CHUNK_STREAMS_MAX + 3; index += 1) {
      const { overlays } = fold.read(
        chunksAnswer([
          {
            messageId: `m${index}`,
            chunks: [{ seq: 0, baseline: true, ops: [resetOp(`m${index}`, "x")] }],
          },
        ]),
        0,
      );
      for (const overlay of overlays) {
        if (overlay.delta.op === "message.remove") removed.push(overlay.messageId);
      }
    }
    expect(removed).toEqual(["m0", "m1", "m2"]);
    const cursors = fold.cursors();
    expect(cursors).toHaveLength(CHUNK_STREAMS_MAX);
    expect(cursors[0]!.messageId).toBe(`m${CHUNK_STREAMS_MAX + 2}`);
    expect(cursors.some((cursor) => cursor.messageId === "m0")).toBe(false);
  });

  it("fails on a malformed answer", () => {
    const fold = new CloudChunkFold(SESSION_ID);
    expect(() => fold.read({ streams: [{ messageId: "m1", chunks: [{ seq: "1" }] }] }, 0)).toThrow(
      /malformed/u,
    );
  });
});

describe("the cloud reads' remaining shapes", () => {
  it.each([
    ["a non-object view", null, /Session state is malformed/u],
    ["a session without ids", { session: { id: 1 } }, /session/u],
    ["an unknown status", { status: "gone" }, /status/u],
    ["a non-boolean bornTicketless", { bornTicketless: 1 }, /bornTicketless/u],
    ["a negative lastActivityAt", { lastActivityAt: -1 }, /lastActivityAt/u],
    ["attention that is not an object", { attention: [] }, /attention/u],
    ["a malformed primary attention", { attention: { active: [], primary: 3 } }, /attention/u],
    ["interactions that are not an object", { interactions: null }, /interactions/u],
    ["malformed active interactions", { interactions: { active: {} } }, /interactions/u],
    ["a malformed signal", { signal: "done" }, /signal/u],
    ["a malformed model selection", { modelSelection: [] }, /modelSelection/u],
    ["a malformed model tier", { modelTier: 5 }, /modelTier/u],
    ["a malformed auto pick", { modelAuto: "x" }, /modelAuto/u],
    ["a malformed plan", { todoList: 1 }, /todoList/u],
  ])("refuses %s", (_name, overrides, error) => {
    const view = overrides === null ? null : viewJson(overrides as Record<string, unknown>);
    expect(() => cloudProjection(view)).toThrow(error);
  });

  it("keeps an auto pick, and reads an absent tier as none", () => {
    const projection = cloudProjection(
      viewJson({ modelAuto: { reason: "first message" }, modelTier: undefined }),
    );
    expect(projection.modelAuto).toEqual({ reason: "first message" });
    expect(projection.modelTier).toBeNull();
    expect("todoList" in projection).toBe(false);
  });

  it("settles a snapshot only once it is folded, caught up, and through what was seen", () => {
    expect(cloudSnapshotSettled(snapshotAnswer(0, null), 0)).toBe(false);
    expect(cloudSnapshotSettled({ ...(snapshotAnswer(4) as object), catchingUp: true }, 0)).toBe(
      false,
    );
    expect(cloudSnapshotSettled(snapshotAnswer(4), 5)).toBe(false);
    expect(cloudSnapshotSettled(snapshotAnswer(4), 4)).toBe(true);
    expect(cloudSnapshotSettled({ state: "{}" }, 9)).toBe(true);
    // Not a snapshot: settled, so its reading refuses it.
    expect(cloudSnapshotSettled(null, 0)).toBe(true);
  });

  it("refuses a snapshot that is not one", () => {
    expect(() => readCloudSnapshot(null)).toThrow(/snapshot is malformed/u);
    expect(() => readCloudSnapshot({ foldedThrough: 1, state: 5 })).toThrow(
      /snapshot is malformed/u,
    );
  });

  it("reads a reply location only when it names a fact and a body", () => {
    expect(replyAt({ sequence: 0, reference: { id: "a" } })).toBeNull();
    expect(replyAt({ sequence: 2, reference: null })).toBeNull();
    expect(replyAt({ sequence: 2, reference: { id: "a", mediaType: "x", digest: 9 } })).toEqual({
      sequence: 2,
      reference: { id: "a", mediaType: "x", digest: null },
    });
  });

  it("keeps an event of a kind this build does not know, and refuses a malformed known one", () => {
    const future = { ...turnEvent(1, "turn.started"), payload: { kind: "future.kind" } };
    const read = readCloudHistory(historyAnswer([{ sequence: 1, event: future }]));
    expect(read.entries[0]).toEqual({
      sequence: 1,
      event: future,
      reference: null,
      endsTurn: null,
      endsAttachment: false,
    });
    const broken = { ...turnEvent(2, "turn.started"), payload: { kind: "turn.started" } };
    expect(() => readCloudHistory(historyAnswer([{ sequence: 2, event: broken }]))).toThrow(
      /Session event 2 is malformed/u,
    );
  });

  it("marks the facts that end the attachment", () => {
    const read = readCloudHistory(
      historyAnswer([
        { sequence: 1, event: turnEvent(1, "turn.started") },
        { sequence: 2, event: attachmentEndedEvent(2, "attachment.closed") },
        { sequence: 3, event: attachmentEndedEvent(3, "attachment.failed") },
        { sequence: 4, status: "unknown_kind", event: null },
      ]),
    );
    expect(read.entries.map((entry) => entry.endsAttachment)).toEqual([false, true, true, false]);
    expect(read.entries.map((entry) => entry.endsTurn)).toEqual([null, null, null, null]);
  });

  it("names the turn a fact ends", () => {
    const interrupted = {
      ...turnEvent(3, "turn.started"),
      payload: { kind: "turn.interrupted", attachmentId: "attach-1", turnId: "turn-9" },
    };
    const read = readCloudHistory(
      historyAnswer([
        { sequence: 1, event: turnEvent(1, "turn.started") },
        { sequence: 2, event: turnEvent(2, "turn.completed") },
        { sequence: 3, event: interrupted },
      ]),
    );
    expect(read.entries.map((entry) => entry.endsTurn)).toEqual([null, "turn-1", "turn-9"]);
  });

  it("names the body a submitted message or an answered question records", () => {
    const reference = { id: "artifact-1", mediaType: null, digest: digestOf(1) };
    expect(transcriptReferenceOf(recorded({ kind: "message.submit", reference }))).toBe(reference);
    expect(transcriptReferenceOf(recorded({ kind: "interaction.resolve", reference }))).toBe(
      reference,
    );
    expect(transcriptReferenceOf(recorded({ kind: "model.select" }))).toBeNull();
    expect(
      transcriptReferenceOf({
        payload: { kind: "turn.started" },
      } as unknown as RendererSessionEvent),
    ).toBeNull();
  });

  it("builds a frame with no body when the body was not read", () => {
    const read = readCloudHistory(historyAnswer([{ sequence: 1, event: referencedEvent(1) }]));
    expect(cloudFrames(SESSION_ID, read.entries, new Map())).toEqual([
      { sessionId: SESSION_ID, sequence: 1, event: referencedEvent(1), transcript: null },
    ]);
  });

  it("gives no reply baseline for a message that says nothing", () => {
    const location = { sequence: 4, reference: { id: "a", mediaType: null, digest: null } };
    expect(
      cloudLatestReply(location, { id: "m4", role: "assistant", parts: [] }, replyText),
    ).toBeNull();
  });

  it("treats a chunk whose op the overlay reader refuses as a gap", () => {
    const fold = new CloudChunkFold(SESSION_ID);
    fold.read(
      chunksAnswer([
        { messageId: "m1", chunks: [{ seq: 0, baseline: true, ops: [resetOp("m1", "a")] }] },
      ]),
      0,
    );
    const refused = fold.read(
      chunksAnswer([
        {
          messageId: "m1",
          chunks: [
            { seq: 1, ops: [{ op: "part.append", key: "text-0" }] },
            { seq: 2, ops: [appendOp("c")] },
          ],
        },
      ]),
      0,
    );
    expect(refused).toEqual({ overlays: [], moved: false });
    // A first chunk that cannot be read starts nothing.
    expect(
      fold.read(
        chunksAnswer([
          { messageId: "m2", chunks: [{ seq: 0, baseline: true, ops: [appendOp("x")] }] },
        ]),
        0,
      ),
    ).toEqual({ overlays: [], moved: false });
    expect(fold.cursors()).toEqual([{ messageId: "m1", seq: 0 }]);
  });

  it("fails on answers that are not chunk streams", () => {
    const fold = new CloudChunkFold(SESSION_ID);
    expect(() => fold.read(null, 0)).toThrow(/stream chunk answer is malformed/u);
    expect(() => fold.read({ streams: [{ messageId: 1, chunks: [] }] }, 0)).toThrow(
      /stream chunk answer is malformed/u,
    );
  });
});

/* Fixtures for the stream-ending tests. */
function removal(messageId: string, throughSequence: number) {
  return {
    kind: "overlay",
    sessionId: SESSION_ID,
    throughSequence,
    messageId,
    delta: { op: "message.remove" },
  };
}

function started(turnId = "turn-1") {
  const fold = new CloudChunkFold(SESSION_ID);
  for (const messageId of ["s1", "s2"]) {
    fold.read(
      {
        streams: [
          {
            messageId,
            turnId: messageId === "s2" ? null : turnId,
            chunks: [
              {
                seq: 0,
                baseline: true,
                throughSequence: 4,
                ops: JSON.stringify([resetOp(messageId, "x")]),
              },
            ],
          },
        ],
      },
      4,
    );
  }
  return fold;
}

/** A `since` answer holding one baseline chunk of a stream with no turn. */
function baselineAnswer(messageId: string, seq: number, throughSequence: number) {
  return {
    streams: [
      {
        messageId,
        turnId: null,
        chunks: [
          { seq, baseline: true, throughSequence, ops: JSON.stringify([resetOp(messageId, "x")]) },
        ],
      },
    ],
  };
}

describe("CloudChunkFold ends streams", () => {
  it("removes a retired stream once the history reaches its replacing fact", () => {
    const fold = started();
    const read = fold.read({ streams: [], retired: [{ messageId: "s1", throughSequence: 7 }] }, 5);
    expect(read).toEqual({ overlays: [], moved: true });
    expect(fold.cursors().map((cursor) => cursor.messageId)).toEqual(["s2"]);
    expect(fold.due(6)).toEqual([]);
    expect(fold.due(7)).toEqual([removal("s1", 7)]);
    expect(fold.due(9)).toEqual([]);
    // Already caught up: removed in the same answer.
    expect(
      fold.read({ streams: [], retired: [{ messageId: "s2", throughSequence: 7 }] }, 8).overlays,
    ).toEqual([removal("s2", 7)]);
  });

  it("ignores a retirement of a stream it holds no cursor for, or that started again", () => {
    const fold = started();
    expect(
      fold.read({ streams: [], retired: [{ messageId: "other", throughSequence: 1 }] }, 9),
    ).toEqual({ overlays: [], moved: false });
    fold.read({ streams: [], retired: [{ messageId: "s1", throughSequence: 7 }] }, 5);
    fold.read(
      chunksAnswer([
        {
          messageId: "s1",
          chunks: [{ seq: 3, baseline: true, throughSequence: 7, ops: [resetOp("s1", "again")] }],
        },
      ]),
      5,
    );
    expect(fold.due(7)).toEqual([]);
  });

  it("refuses a malformed retirement list", () => {
    const fold = new CloudChunkFold(SESSION_ID);
    expect(() => fold.read({ streams: [], retired: {} }, 0)).toThrow(/malformed/u);
    expect(() => fold.read({ streams: [], retired: [{ messageId: "m" }] }, 0)).toThrow(
      /malformed/u,
    );
  });

  it("still removes a message past a gap", () => {
    const fold = started();
    const read = fold.read(
      chunksAnswer([
        {
          messageId: "s1",
          chunks: [
            { seq: 2, throughSequence: 6, ops: [{ op: "message.remove" }] },
            { seq: 3, ops: [appendOp("late")] },
          ],
        },
      ]),
      6,
    );
    expect(read).toEqual({ overlays: [removal("s1", 6)], moved: true });
    expect(fold.cursors()).toContainEqual({ messageId: "s1", seq: 2 });
  });

  it("removes an ended turn's streams and ignores its late chunks", () => {
    const fold = started();
    expect(fold.turnEnded("turn-1", 9)).toEqual({ overlays: [removal("s1", 9)], moved: true });
    expect(fold.cursors().map((cursor) => cursor.messageId)).toEqual(["s2"]);
    expect(fold.turnEnded("turn-1", 10)).toEqual({ overlays: [], moved: false });
    const late = fold.read(
      {
        streams: [
          {
            messageId: "s1",
            turnId: "turn-1",
            chunks: [
              {
                seq: 4,
                baseline: true,
                throughSequence: 8,
                ops: JSON.stringify([resetOp("s1", "x")]),
              },
            ],
          },
        ],
      },
      9,
    );
    expect(late).toEqual({ overlays: [], moved: false });
  });

  it("ignores a delayed chunk of an ended stream, and draws one written after it", () => {
    const fold = started();
    fold.read({ streams: [], retired: [{ messageId: "s1", throughSequence: 7 }] }, 8);
    // A stale baseline a late read still serves: not drawn again.
    expect(fold.read(baselineAnswer("s1", 5, 4), 8)).toEqual({ overlays: [], moved: false });
    // Written at the watermark: the stream started again.
    expect(fold.read(baselineAnswer("s1", 6, 7), 8).moved).toBe(true);
  });

  it("remembers only the most recent ended streams", () => {
    const fold = new CloudChunkFold(SESSION_ID);
    for (let index = 0; index <= 256; index += 1) {
      fold.read(baselineAnswer(`r${index}`, 0, 0), 0);
      fold.read({ streams: [], retired: [{ messageId: `r${index}`, throughSequence: 9 }] }, 9);
    }
    // r0's watermark was forgotten: its delayed baseline draws; r1's is still remembered.
    expect(fold.read(baselineAnswer("r0", 0, 1), 9).moved).toBe(true);
    expect(fold.read(baselineAnswer("r1", 0, 1), 9).moved).toBe(false);
  });

  it("removes every stream when the attachment ends, and suppresses their delayed baselines", () => {
    const fold = started();
    expect(fold.allEnded(9)).toEqual({
      overlays: [removal("s1", 9), removal("s2", 9)],
      moved: true,
    });
    expect(fold.cursors()).toEqual([]);
    expect(fold.read(baselineAnswer("s2", 5, 4), 9)).toEqual({ overlays: [], moved: false });
    expect(fold.allEnded(10)).toEqual({ overlays: [], moved: false });
    // A stream started by a later attachment is drawn.
    expect(fold.read(baselineAnswer("s2", 6, 10), 10).moved).toBe(true);
  });

  it("remembers only the most recent ended turns", () => {
    const fold = new CloudChunkFold(SESSION_ID);
    for (let index = 0; index <= 64; index += 1) fold.turnEnded(`turn-${index}`, index);
    // turn-0 was forgotten: its chunks are read again.
    const read = fold.read(
      {
        streams: [
          {
            messageId: "s1",
            turnId: "turn-0",
            chunks: [
              {
                seq: 0,
                baseline: true,
                throughSequence: 1,
                ops: JSON.stringify([resetOp("s1", "x")]),
              },
            ],
          },
        ],
      },
      70,
    );
    expect(read.moved).toBe(true);
  });
});
