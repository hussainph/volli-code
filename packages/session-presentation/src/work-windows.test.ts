import { describe, expect, it } from "vite-plus/test";
import type { DynamicToolUIPart, UIMessage } from "ai";
import { ACTIVITY_METADATA_KEY } from "@volli/shared";
import { groupTurns } from "./activity";
import { projectTranscriptRows } from "./transcript-rows";
import { projectWorkWindows, workDurationLabel, type TranscriptWorkWindow } from "./work-windows";

function tool(
  id: string,
  start: number,
  state: "input-available" | "output-available" = "output-available",
): DynamicToolUIPart {
  const metadata = {
    [ACTIVITY_METADATA_KEY]: {
      kind: "other",
      nativeToolName: "fixture",
      subject: { label: null, path: null, lineRange: null },
      outcome: null,
      startedAt: start,
      endedAt: start + 500,
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
  ).toEqual(["Worked for 1s", "Worked for 1s", "Worked for 4s"]);
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
  expect(replay[0]!.kind === "work" && workDurationLabel(replay[0]!.work)).toBe("Work details");
  expect(live[0]!.kind === "work" && workDurationLabel(live[0]!.work)).toBe("Working");
});

describe("recorded duration labels", () => {
  it.each([
    [0, "<1s"],
    [12000, "12s"],
    [68000, "1m 08s"],
    [3720000, "1h 02m"],
  ])("formats %i milliseconds", (elapsed, expected) => {
    const work: TranscriptWorkWindow = {
      key: "view",
      rows: [],
      startedAt: 0,
      endedAt: elapsed,
      state: "complete",
    };
    expect(workDurationLabel(work)).toBe(`Worked for ${expected}`);
    expect(workDurationLabel({ ...work, startedAt: null })).toBe("Work details");
    expect(workDurationLabel({ ...work, endedAt: -1 })).toBe("Work details");
  });
});
