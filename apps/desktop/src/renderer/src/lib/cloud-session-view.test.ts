import { replyText } from "@volli/session-engine";
import type { RendererSessionEvent } from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";

import {
  CHUNK_STREAMS_MAX,
  CloudChunkFold,
  cloudFrames,
  cloudLatestReply,
  cloudProjection,
  cloudSnapshotUnfolded,
  readCloudHistory,
  readCloudSnapshot,
  readTranscriptMessage,
  transcriptReferenceOf,
} from "./cloud-session-view";
import {
  SESSION_ID,
  appendOp,
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
      fold.read(chunksAnswer([{ messageId: "m1", chunks: [{ seq: 4, ops: [appendOp("lo")] }] }])),
    ).toEqual({ overlays: [], moved: false });
  });

  it("ignores a stream after a gap until its next baseline", () => {
    const fold = new CloudChunkFold(SESSION_ID);
    fold.read(
      chunksAnswer([
        { messageId: "m1", chunks: [{ seq: 0, baseline: true, ops: [resetOp("m1", "a")] }] },
      ]),
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
    );
    expect(healed.overlays.map((overlay) => overlay.delta.op)).toEqual(["reset", "part.append"]);
    expect(fold.cursors()).toEqual([{ messageId: "m1", seq: 6 }]);
  });

  it("does not start a stream without a baseline, and treats an unreadable chunk as a gap", () => {
    const fold = new CloudChunkFold(SESSION_ID);
    expect(
      fold.read(chunksAnswer([{ messageId: "m1", chunks: [{ seq: 1, ops: [appendOp("x")] }] }])),
    ).toEqual({ overlays: [], moved: false });
    fold.read(
      chunksAnswer([
        { messageId: "m2", chunks: [{ seq: 0, baseline: true, ops: [resetOp("m2", "a")] }] },
      ]),
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
    );
    expect(refused).toEqual({ overlays: [], moved: false });
    expect(fold.cursors()).toEqual([{ messageId: "m2", seq: 0 }]);
  });

  it("keeps at most the backend's stream limit of cursors, newest first", () => {
    const fold = new CloudChunkFold(SESSION_ID);
    for (let index = 0; index < CHUNK_STREAMS_MAX + 3; index += 1) {
      fold.read(
        chunksAnswer([
          {
            messageId: `m${index}`,
            chunks: [{ seq: 0, baseline: true, ops: [resetOp(`m${index}`, "x")] }],
          },
        ]),
      );
    }
    const cursors = fold.cursors();
    expect(cursors).toHaveLength(CHUNK_STREAMS_MAX);
    expect(cursors[0]!.messageId).toBe(`m${CHUNK_STREAMS_MAX + 2}`);
    expect(cursors.some((cursor) => cursor.messageId === "m0")).toBe(false);
  });

  it("fails on a malformed answer", () => {
    const fold = new CloudChunkFold(SESSION_ID);
    expect(() => fold.read({ streams: [{ messageId: "m1", chunks: [{ seq: "1" }] }] })).toThrow(
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

  it("tells a snapshot before the first fold from one with a state", () => {
    expect(cloudSnapshotUnfolded(snapshotAnswer(0, null))).toBe(true);
    expect(cloudSnapshotUnfolded(snapshotAnswer(1))).toBe(false);
    expect(cloudSnapshotUnfolded(null)).toBe(false);
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

  it("names no body for an event the renderer codec refuses", () => {
    const read = readCloudHistory(
      historyAnswer([{ sequence: 1, event: { payload: { kind: "x" } } }]),
    );
    expect(read.entries[0]).toMatchObject({ sequence: 1, reference: null });
    expect(read.entries[0]!.event).not.toBeNull();
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
    );
    expect(refused).toEqual({ overlays: [], moved: false });
    // A first chunk that cannot be read starts nothing.
    expect(
      fold.read(
        chunksAnswer([
          { messageId: "m2", chunks: [{ seq: 0, baseline: true, ops: [appendOp("x")] }] },
        ]),
      ),
    ).toEqual({ overlays: [], moved: false });
    expect(fold.cursors()).toEqual([{ messageId: "m1", seq: 0 }]);
  });

  it("fails on answers that are not chunk streams", () => {
    const fold = new CloudChunkFold(SESSION_ID);
    expect(() => fold.read(null)).toThrow(/stream chunk answer is malformed/u);
    expect(() => fold.read({ streams: [{ messageId: 1, chunks: [] }] })).toThrow(
      /stream chunk answer is malformed/u,
    );
  });
});
