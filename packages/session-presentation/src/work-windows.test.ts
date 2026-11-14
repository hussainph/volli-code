import { describe, expect, it } from "vite-plus/test";
import type { DynamicToolUIPart, UIMessage } from "ai";
import { ACTIVITY_METADATA_KEY } from "@volli/shared";
import { groupTurns } from "./activity";
import { projectTranscriptRows } from "./transcript-rows";
import {
  projectWorkWindows,
  workDurationLabel,
  type TranscriptWorkWindow,
  type WorkTranscriptRow,
} from "./work-windows";

function tool(
  id: string,
  start: number | null,
  state: "input-available" | "output-available" = "output-available",
  end: number | null = state === "input-available" || start === null ? null : start + 500,
): DynamicToolUIPart {
  const metadata = {
    [ACTIVITY_METADATA_KEY]: {
      kind: "other",
      nativeToolName: "fixture",
      subject: { label: null, path: null, lineRange: null },
      outcome: null,
      startedAt: start,
      endedAt: end,
    },
  };
  return state === "input-available"
    ? {
        type: "dynamic-tool",
        toolCallId: id,
        toolName: "fixture",
        state,
        input: {},
        toolMetadata: metadata,
      }
    : {
        type: "dynamic-tool",
        toolCallId: id,
        toolName: "fixture",
        state,
        input: {},
        output: "done",
        toolMetadata: metadata,
      };
}
function msg(id: string, role: UIMessage["role"], parts: UIMessage["parts"]): UIMessage {
  return { id, role, parts };
}
const text = (value: string): UIMessage["parts"] => [{ type: "text", text: value }];

it("owns work before every author boundary, without empty receipts or role changes", () => {
  const messages = [
    msg("prompt", "user", text("Start")),
    msg("work1", "assistant", [tool("a", 1000)]),
    msg("comment", "assistant", text("Checking")),
    msg("work2", "assistant", [tool("b", 3000)]),
    msg("steer", "user", text("Check dark")),
    msg("work3", "assistant", [tool("c", 5000)]),
    msg("answer", "assistant", text("Done")),
  ];
  const original = JSON.stringify(messages);
  const rows = projectWorkWindows(
    projectTranscriptRows(groupTurns(messages), [], []),
    new Map([
      ["comment", 2500],
      ["steer", 4500],
      ["answer", 9000],
    ]),
    false,
  );
  expect(rows.map((row) => row.kind)).toEqual([
    "turn",
    "work",
    "turn",
    "work",
    "turn",
    "work",
    "turn",
  ]);
  expect(
    rows.filter((row) => row.kind === "work").map((row) => workDurationLabel(row.work)),
  ).toEqual(["Used 1 tool", "Used 1 tool", "Used 1 tool"]);
  expect(
    rows.flatMap((row) =>
      row.kind === "turn" ? row.messages.map((message) => [message.id, message.role]) : [],
    ),
  ).toEqual([
    ["prompt", "user"],
    ["comment", "assistant"],
    ["steer", "user"],
    ["answer", "assistant"],
  ]);
  expect(JSON.stringify(messages)).toBe(original);
});

it("updates a spanning call at its original owner, without cloning it at an async delivery", () => {
  const messages = [
    msg("start", "assistant", [tool("long", 1000, "input-available")]),
    msg("arrival", "user", text("Child answered")),
    msg("result", "assistant", [tool("long", 1000), tool("later", 5000)]),
    msg("final", "assistant", text("Read answer")),
  ];
  const rows = projectWorkWindows(
    projectTranscriptRows(groupTurns(messages), [], []),
    new Map([
      ["arrival", 2000],
      ["final", 9000],
    ]),
    false,
  );
  const windows = rows.filter((row) => row.kind === "work");
  expect(
    windows.map((row) =>
      row.work.rows.map((activity) =>
        activity.kind === "tool" ? activity.part.toolCallId : "thought",
      ),
    ),
  ).toEqual([["long"], ["later"]]);
  expect(windows[0]!.work.rows[0]!.part.state).toBe("output-available");
  expect(windows[0]!.work.endedAt).toBe(2000);
});

it("keeps host notices and context notices as visible boundaries in sequence", () => {
  const source = projectTranscriptRows(
    [[msg("work", "assistant", [tool("a", 1000)])], [msg("plain", "user", text("Hello"))]],
    [
      {
        sequence: 4,
        afterMessageId: "work",
        outcome: "compacted",
        reason: "manual",
        tokensBefore: 100,
      },
    ],
    [],
  );
  const rows = projectWorkWindows(source, new Map(), false);
  expect(rows.map((row) => row.kind)).toEqual(["work", "compaction", "turn"]);
  const host = {
    kind: "host-notice" as const,
    messageId: "notice",
    notice: { kind: "unknown" as const, text: "Delivered" },
  };
  expect(
    projectWorkWindows([source[0]!, host], new Map([["notice", 3000]]), true).map(
      (row) => row.kind,
    ),
  ).toEqual(["work", "host-notice"]);
});

it("does not revive historical progress, invent reasoning clocks, or draw blank text", () => {
  const source = projectTranscriptRows(
    [
      [
        msg("tail", "assistant", [
          { type: "text", text: " " },
          { type: "reasoning", text: "**Checking**", state: "streaming" },
          tool("a", 1000),
        ]),
      ],
    ],
    [],
    [],
  );
  const replay = projectWorkWindows(source, new Map(), false);
  const live = projectWorkWindows(source, new Map(), true);
  expect(replay).toHaveLength(1);
  expect(replay[0]!.kind === "work" && replay[0]!.work.startedAt).toBeNull();
  expect(replay[0]!.kind === "work" && workDurationLabel(replay[0]!.work)).toBe("Used 1 tool");
  expect(live[0]!.kind === "work" && workDurationLabel(live[0]!.work)).toBe("Used 1 tool");
});

it("preserves text/tool order inside one message even with a stepped-back tool clock", () => {
  const source = projectTranscriptRows(
    [
      [
        msg("same-message", "assistant", [
          tool("a", 1000),
          { type: "text", text: "Checking" },
          tool("b", 500),
          { type: "text", text: "Done" },
        ]),
      ],
    ],
    [],
    [],
  );
  const rows = projectWorkWindows(source, new Map([["same-message", 3000]]), false, {
    // Unknown newer frame: position survives without an event clock.
    frames: [{ sessionId: "session", sequence: 1, event: null, transcript: null }],
    activityFirstOverlaySequence: new Map(),
  });
  expect(rows.map((row) => row.kind)).toEqual(["work", "turn", "work", "turn"]);
  expect(
    rows.flatMap((row) => (row.kind === "work" ? row.work.rows.map((entry) => entry.key) : [])),
  ).toEqual(["tool:a", "tool:b"]);
});

it("never lets a stale running overlay replace a settled result of the same call", () => {
  const source = projectTranscriptRows(
    [
      [
        msg("settled", "assistant", [tool("same", 1000)]),
        msg("stale-overlay", "assistant", [tool("same", 1000, "input-available")]),
      ],
    ],
    [],
    [],
  );
  const rows = projectWorkWindows(source, new Map(), false);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.kind === "work" && rows[0]!.work.rows).toHaveLength(1);
  expect(rows[0]!.kind === "work" && rows[0]!.work.rows[0]!.part.state).toBe("output-available");
});

/** Where the work window holding one activity sits among the rows. */
function owner(rows: readonly WorkTranscriptRow[], key: string): number {
  return rows.findIndex(
    (row) => row.kind === "work" && row.work.rows.some((entry) => entry.key === key),
  );
}

// The search skips whole blocks of boundaries that cannot follow a call
// (VC-1145); placement across many of them must match asking every boundary.
it("places work across a long transcript exactly as a boundary-by-boundary search would", () => {
  const filler = Array.from({ length: 150 }, (_, index) =>
    msg(`said-${index}`, "assistant", text(`Line ${index}`)),
  );
  const messages = [
    msg("prompt", "user", text("Start")),
    // Started after every line below was said: it moves down to the answer.
    msg("late", "assistant", [tool("late", 9000)]),
    ...filler,
    // Started before the first line was said: it moves up to the prompt.
    msg("early", "assistant", [tool("early", 50)]),
    msg("answer", "assistant", text("Done")),
  ];
  const source = projectTranscriptRows(groupTurns(messages), [], []);
  const timed = projectWorkWindows(
    source,
    new Map<string, number>([
      ["prompt", 0],
      ...filler.map((message, index): [string, number] => [message.id, 100 + index]),
      ["answer", 10000],
    ]),
    false,
  );
  expect(timed).toHaveLength(154);
  expect(owner(timed, "tool:early")).toBe(1);
  expect(owner(timed, "tool:late")).toBe(152);
  expect(timed[153]!.kind === "turn" && timed[153]!.messages[0]!.id).toBe("answer");

  // With the lines' clocks unknown, nothing between orders either call, so
  // both keep the places they were recorded in.
  const unknown = projectWorkWindows(
    source,
    new Map([
      ["prompt", 0],
      ["answer", 10000],
    ]),
    false,
  );
  expect(owner(unknown, "tool:late")).toBe(1);
  expect(owner(unknown, "tool:early")).toBe(152);
});

describe("never deriving execution duration from boundary clocks", () => {
  it.each([[0], [12000], [68000], [3720000]])(
    "does not call %i milliseconds of wall time active work",
    (elapsed) => {
      const work: TranscriptWorkWindow = {
        key: "view",
        rows: [],
        startedAt: 0,
        endedAt: elapsed,
        state: "complete",
      };
      expect(workDurationLabel(work)).toBe("Thought");
      expect(workDurationLabel({ ...work, startedAt: null })).toBe("Thought");
      expect(workDurationLabel({ ...work, endedAt: -1 })).toBe("Thought");
    },
  );
});
