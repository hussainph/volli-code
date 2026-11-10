import type { DynamicToolUIPart, UIMessage } from "ai";
import {
  ACTIVITY_METADATA_KEY,
  scrubSessionEvent,
  sessionHostNoticeMetadata,
  type SessionEvent,
} from "@volli/shared";
import { expect, it } from "vite-plus/test";
import { groupTurns } from "./activity";
import {
  appendFrames,
  EMPTY_TRANSCRIPT,
  prependTranscriptHistory,
  type ChatSessionFrame,
  type ChatTranscriptState,
} from "./transcript";
import { chatSessionFrame, chatSessionOverlay } from "./wire";
import { projectTranscriptRows } from "./transcript-rows";
import { transcriptMessageOrigins } from "./transcript-message-origin";
import { projectWorkWindows, transcriptMessageTimes, workDurationLabel } from "./work-windows";

function tool(id: string, began: number | null, end: number | null) {
  const base = {
    type: "dynamic-tool" as const,
    toolCallId: id,
    toolName: "fixture",
    input: {},
    toolMetadata: {
      [ACTIVITY_METADATA_KEY]: {
        kind: "other",
        nativeToolName: "fixture",
        subject: { label: null, path: null, lineRange: null },
        outcome: null,
        startedAt: began,
        endedAt: end,
      },
    },
  };
  return end === null
    ? { ...base, state: "input-available" as const }
    : { ...base, state: "output-available" as const, output: "done" };
}
const text = (id: string, role: UIMessage["role"], words: string): UIMessage => ({
  id,
  role,
  parts: [{ type: "text", text: words }],
});
function frame(sequence: number, time: number, message: UIMessage): ChatSessionFrame {
  const event: SessionEvent = {
    id: `event-${sequence}`,
    sessionId: "session",
    sequence,
    occurredAt: time,
    recordedAt: time,
    provenance: { source: { kind: "system", id: "fixture", detail: null }, venue: null },
    payload: {
      kind: "transcript.referenced",
      attachmentId: "attachment",
      turnId: "turn",
      reference: { id: `artifact-${sequence}`, mediaType: null, digest: null },
    },
  };
  const result = chatSessionFrame(
    JSON.parse(
      JSON.stringify({
        sessionId: "session",
        sequence,
        event: scrubSessionEvent(event),
        transcript: { message },
      }),
    ),
  );
  if (result === null) throw new Error("Expected decoded production frame");
  return result;
}
function start(state: ChatTranscriptState, id: string, at: number | null) {
  const overlay = chatSessionOverlay(
    JSON.parse(
      JSON.stringify({
        kind: "overlay",
        sessionId: "session",
        throughSequence: state.throughSequence,
        messageId: id,
        delta: {
          op: "reset",
          message: { id, role: "assistant", parts: [{ key: id, part: tool(id, at, null) }] },
        },
      }),
    ),
  );
  if (overlay === null) throw new Error("Expected decoded production overlay");
  return appendFrames(state, [], [overlay]);
}
function settle(sequence: number, id: string, at: number, end: number) {
  return frame(sequence, end, { id, role: "assistant", parts: [tool(id, at, end)] });
}
function project(state: ChatTranscriptState) {
  return projectWorkWindows(
    projectTranscriptRows(
      groupTurns(state.messages),
      state.compactions,
      state.reasoningDrops,
      state.toolRefreshes,
      transcriptMessageOrigins(state.frames),
    ),
    transcriptMessageTimes(state.frames),
    state.turnActive,
    state,
  );
}
function windows(state: ChatTranscriptState) {
  return project(state)
    .filter((row) => row.kind === "work")
    .map((row) => row.work);
}
function ids(state: ChatTranscriptState) {
  return windows(state).map((work) =>
    work.rows.map((row) => (row.kind === "tool" ? row.part.toolCallId : "reasoning")),
  );
}
const prompt = frame(1, 0, text("prompt", "user", "Start"));
function noticeFrame(sequence: number, time: number) {
  const base = frame(sequence, time, {
    ...text("notice", "user", "Browser hold changed"),
    metadata: sessionHostNoticeMetadata({
      kind: "browser-hold",
      tabId: "tab",
      tabTitle: "Page",
      tabHostname: "example.org",
      action: "person-took",
    }),
  });
  const decoded = chatSessionFrame(
    JSON.parse(
      JSON.stringify({
        ...base,
        event: {
          ...base.event,
          provenance: {
            source: {
              kind: "user",
              id: "session-client",
              detail: { sessionOrigin: { kind: "volli", reason: "browser-notice" } },
            },
            venue: null,
          },
          payload: {
            kind: "command.recorded",
            command: {
              id: `notice-${sequence}`,
              sessionId: "session",
              createdAt: time,
              route: null,
              intent: {
                kind: "message.submit",
                reference: { id: `notice-artifact-${sequence}`, mediaType: null, digest: null },
              },
            },
          },
        },
      }),
    ),
  );
  if (decoded === null) throw new Error("Expected decoded host submission");
  return decoded;
}
const notice = noticeFrame(2, 2500);

it("owns the real overlay before a later durable notice and retains it through settlement and replay", () => {
  let state = start(appendFrames(EMPTY_TRANSCRIPT, [prompt]), "long", 1000);
  const initialKey = windows(state)[0]!.key;
  state = appendFrames(state, [notice]);
  // The canonical fold really appends the overlay after the durable notice.
  expect(state.messages.map((message) => message.id)).toEqual(["prompt", "notice", "long"]);
  expect(project(state).map((row) => row.kind)).toEqual(["turn", "work", "host-notice"]);
  expect(windows(state)[0]!.key).toBe(initialKey);
  const result = settle(3, "long", 1000, 7000);
  state = appendFrames(state, [result]);
  expect(state.overlay.size).toBe(0);
  expect(ids(state)).toEqual([["long"]]);
  expect(windows(state)[0]!.key).toBe(initialKey);
  expect(windows(state)[0]!.endedAt).toBe(2500);
  expect(windows(state)[0]!.rows[0]!.part.state).toBe("output-available");
  const replay = appendFrames(EMPTY_TRANSCRIPT, [prompt, notice, result]);
  expect(replay.activityFirstOverlaySequence.size).toBe(0);
  expect(ids(replay)).toEqual([["long"]]);
  expect(project(replay).map((row) => row.kind)).toEqual(["turn", "work", "host-notice"]);
  expect(windows(replay)[0]!.key).toBe(initialKey);
  // No canonical event, message role, body or order has been rewritten.
  expect(replay.messages.map((message) => message.id)).toEqual(["prompt", "notice", "long"]);
  expect(replay.frames).toEqual([prompt, notice, result]);
});

it("freezes a real turn's receipt at the durable boundary without hiding its running call", () => {
  const turn = chatSessionFrame(
    JSON.parse(
      JSON.stringify({
        ...prompt,
        sequence: 2,
        transcript: null,
        event: {
          ...prompt.event,
          id: "turn-start",
          sequence: 2,
          occurredAt: 500,
          recordedAt: 500,
          payload: { kind: "turn.started", attachmentId: "attachment", turnId: "turn" },
        },
      }),
    ),
  );
  if (turn === null) throw new Error("Expected decoded turn start");
  let state = start(appendFrames(EMPTY_TRANSCRIPT, [prompt, turn]), "live", 1000);
  expect(state.turnActive).toBe(true);
  expect(workDurationLabel(windows(state)[0]!)).toBe("Working");
  const delivery = noticeFrame(3, 2500);
  state = appendFrames(state, [delivery]);
  expect(windows(state)[0]!.state).toBe("complete");
  expect(windows(state)[0]!.endedAt).toBe(2500);
  expect(windows(state)[0]!.rows[0]!.part.state).toBe("input-available");
  expect(workDurationLabel(windows(state)[0]!)).toBe("Work details");
  state = appendFrames(state, [settle(4, "live", 1000, 8000)]);
  expect(windows(state)[0]!.endedAt).toBe(2500);
  expect(windows(state)[0]!.rows[0]!.part.state).toBe("output-available");
});

it("does not let reverse parallel settlement overlap ownership or count a spanning call twice", () => {
  let state = start(start(appendFrames(EMPTY_TRANSCRIPT, [prompt]), "a", 1000), "b", 2000);
  state = start(appendFrames(state, [notice]), "c", 3000);
  const endings = [
    settle(3, "b", 2000, 4500),
    settle(4, "c", 3000, 5000),
    settle(5, "a", 1000, 5500),
    frame(6, 6000, text("final", "assistant", "Done")),
  ];
  for (const ending of endings) {
    state = appendFrames(state, [ending]);
    const flat = ids(state).flat();
    expect(new Set(flat).size).toBe(flat.length);
  }
  const replay = appendFrames(EMPTY_TRANSCRIPT, [prompt, notice, ...endings]);
  for (const candidate of [state, replay]) {
    expect(ids(candidate)).toEqual([["a", "b"], ["c"]]);
    const work = windows(candidate);
    expect(work.map((window) => [window.startedAt, window.endedAt])).toEqual([
      [1000, 2500],
      [3000, 6000],
    ]);
    expect(work[0]!.endedAt!).toBeLessThanOrEqual(work[1]!.startedAt!);
    expect(work.map(workDurationLabel)).toEqual(["Work details", "Work details"]);
  }
});

it("retains actual live position with unknown clocks through settlement and history prepend", () => {
  let state = start(appendFrames({ ...EMPTY_TRANSCRIPT, before: 1 }, [prompt]), "untimed", null);
  state = appendFrames(state, [notice]);
  const completed: DynamicToolUIPart = {
    ...tool("untimed", null, null),
    state: "output-available",
    output: "done",
  };
  state = appendFrames(state, [
    frame(3, 7000, { id: "untimed", role: "assistant", parts: [completed] }),
  ]);
  expect(project(state).map((row) => row.kind)).toEqual(["turn", "work", "host-notice"]);
  expect(windows(state)[0]!.startedAt).toBeNull();
  expect(windows(state)[0]!.endedAt).toBeNull();
  expect(workDurationLabel(windows(state)[0]!)).toBe("Work details");
  const paged = prependTranscriptHistory(
    { ...state, frames: state.frames.filter((held) => held.sequence >= 2), before: 2 },
    2,
    { before: null, frames: [prompt] },
  );
  expect(paged.activityFirstOverlaySequence).toBe(state.activityFirstOverlaySequence);
  expect(ids(paged)).toEqual([["untimed"]]);
  // Replay without start/overlay evidence cannot recover that missing order.
  const replay = appendFrames(EMPTY_TRANSCRIPT, state.frames);
  expect(workDurationLabel(windows(replay)[0]!)).toBe("Work details");
});

it("uses retained ledger order for equal-millisecond starts and preserves placement without it", () => {
  let before = start(appendFrames(EMPTY_TRANSCRIPT, [prompt]), "tie", 2500);
  before = appendFrames(before, [notice]);
  expect(project(before).map((row) => row.kind)).toEqual(["turn", "work", "host-notice"]);
  const result = settle(3, "tie", 2500, 7000);
  before = appendFrames(before, [result]);
  expect(project(before).map((row) => row.kind)).toEqual(["turn", "work", "host-notice"]);
  const after = start(appendFrames(EMPTY_TRANSCRIPT, [prompt, notice]), "tie-after", 2500);
  expect(project(after).map((row) => row.kind)).toEqual(["turn", "host-notice", "work"]);
  // Cold history has no retained overlay sequence; a tied clock alone cannot
  // recover which side the call began on. Keep its recorded position.
  const cold = appendFrames(EMPTY_TRANSCRIPT, [prompt, notice, result]);
  expect(project(cold).map((row) => row.kind)).toEqual(["turn", "host-notice", "work"]);
});

it("selects the latest update independently from a message's first position", () => {
  const first = frame(1, 1100, {
    id: "A",
    role: "assistant",
    parts: [{ ...tool("shared", 1000, 1100), state: "output-available", output: "A at 1" }],
  });
  const repeated = frame(3, 3000, {
    id: "B",
    role: "assistant",
    parts: [{ ...tool("shared", 1000, 3000), state: "output-available", output: "B at 3" }],
  });
  const revised = frame(4, 4000, {
    id: "A",
    role: "assistant",
    parts: [{ ...tool("shared", 1000, 4000), state: "output-available", output: "A at 4" }],
  });
  const frames = [first, notice, repeated, revised];
  const original = JSON.stringify(frames);
  const state = appendFrames(EMPTY_TRANSCRIPT, frames);
  expect(state.messages.map((message) => message.id)).toEqual(["A", "notice", "B"]);
  const rows = windows(state)[0]!.rows;
  expect(rows).toHaveLength(1);
  const part = rows[0]!.part;
  expect("output" in part ? part.output : null).toBe("A at 4");
  expect(project(state).map((row) => row.kind)).toEqual(["work", "host-notice"]);
  expect(JSON.stringify(frames)).toBe(original);
});

it("uses a recorded start rather than a later reconnect baseline as replay-equivalent ownership evidence", () => {
  const state = start(appendFrames(EMPTY_TRANSCRIPT, [prompt, notice]), "late-baseline", 1000);
  expect(state.activityFirstOverlaySequence.get("tool:late-baseline")).toBe(2);
  expect(project(state).map((row) => row.kind)).toEqual(["turn", "work", "host-notice"]);
});

it("requires endpoint coverage for every terminal row, not the maximum of a timed subset", () => {
  const untimed: DynamicToolUIPart = {
    ...tool("untimed-end", 2000, null),
    state: "output-available",
    output: "done",
  };
  const state = appendFrames(EMPTY_TRANSCRIPT, [
    prompt,
    frame(2, 8000, { id: "mixed", role: "assistant", parts: [tool("timed", 1000, 1500), untimed] }),
  ]);
  expect(windows(state)[0]!.startedAt).toBe(1000);
  expect(windows(state)[0]!.endedAt).toBeNull();
  expect(workDurationLabel(windows(state)[0]!)).toBe("Work details");
});

it("places context facts at their exact message anchor inside a grouped assistant turn", () => {
  const messages: UIMessage[] = [
    { id: "a", role: "assistant", parts: [tool("a", 1000, 1100)] },
    { id: "b", role: "assistant", parts: [tool("b", 2000, 2100)] },
    { id: "c", role: "assistant", parts: [tool("c", 3000, 3100)] },
    text("comment", "assistant", "Checking the result"),
  ];
  const original = JSON.stringify(messages);
  const rows = projectTranscriptRows(
    groupTurns(messages),
    [
      {
        sequence: 2,
        afterMessageId: "a",
        outcome: "compacted",
        reason: "manual",
        tokensBefore: 100,
      },
    ],
    [{ sequence: 6, afterMessageId: "c", turnId: "turn", count: 1, causes: [] }],
    [{ sequence: 4, afterMessageId: "b", trigger: "cold-turn", added: ["read"], changed: [] }],
  );
  expect(rows.map((row) => row.kind)).toEqual([
    "turn",
    "compaction",
    "turn",
    "tool-refresh",
    "turn",
    "reasoning-drop",
    "turn",
  ]);
  expect(projectWorkWindows(rows, new Map(), false).map((row) => row.kind)).toEqual([
    "work",
    "compaction",
    "work",
    "tool-refresh",
    "work",
    "reasoning-drop",
    "turn",
  ]);
  expect(JSON.stringify(messages)).toBe(original);
});
