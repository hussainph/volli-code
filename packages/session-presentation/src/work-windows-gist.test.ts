import { describe, expect, it } from "vite-plus/test";
import { ACTIVITY_METADATA_KEY, type ActivityDescriptor, type ActivityKind } from "@volli/shared";
import type { DynamicToolUIPart } from "ai";
import type { BundleRow } from "./activity";
import { workDurationLabel, workGist } from "./work-windows";

let next = 0;
function tool(
  kind: ActivityKind = "other",
  options: {
    path?: string | null;
    label?: string | null;
    start?: number | null;
    end?: number | null;
    state?: DynamicToolUIPart["state"];
    input?: unknown;
    toolName?: string;
    output?: unknown;
  } = {},
): BundleRow {
  const id = `${next++}`;
  const descriptor: ActivityDescriptor = {
    kind,
    nativeToolName: options.toolName ?? "fixture",
    subject: { path: options.path ?? null, label: options.label ?? null, lineRange: null },
    startedAt: options.start ?? null,
    endedAt: options.end ?? null,
    outcome: null,
  };
  const base = {
    type: "dynamic-tool" as const,
    toolCallId: id,
    toolName: options.toolName ?? "fixture",
    input: options.input,
    toolMetadata: { [ACTIVITY_METADATA_KEY]: descriptor },
  };
  const state = options.state ?? "output-available";
  let part: DynamicToolUIPart;
  switch (state) {
    case "output-available":
      part = { ...base, state, output: options.output ?? "done" };
      break;
    case "output-error":
      part = { ...base, state, errorText: "failed" };
      break;
    case "output-denied":
      part = { ...base, state, approval: { id, approved: false } };
      break;
    case "approval-requested":
      part = { ...base, state, approval: { id } };
      break;
    case "approval-responded":
      part = { ...base, state, approval: { id, approved: true } };
      break;
    default:
      part = { ...base, state };
  }
  return { kind: "tool", key: id, part };
}
const thought: BundleRow = {
  kind: "reasoning",
  key: "thought",
  streaming: false,
  part: { type: "reasoning", text: "Checking", state: "done" },
};

it("shares the receipt API with legacy/lab bundles without trusting window clocks", () => {
  const rows = [
    tool("edit-file", { path: "a.ts", start: 0, end: 12_000 }),
    tool("edit-file", { path: "b.ts", start: 12_000, end: 24_000 }),
    ...Array.from({ length: 6 }, (_, index) =>
      tool("run-command", {
        input: { command: "vp test" },
        start: 24_000 + index * 8000,
        end: 32_000 + index * 8000,
      }),
    ),
  ];
  const expected = "Worked for 1m 12s · edited 2 files · ran 6 commands";
  expect(workGist(rows)).toBe(expected);
  for (const state of ["open", "complete"] as const)
    expect(workDurationLabel({ key: "x", rows, startedAt: -999, endedAt: 999_999, state })).toBe(
      expected,
    );
});

it("unions nested and overlapping execution intervals without counting gaps or thought", () => {
  const rows = [
    tool("read-file", { path: "a", start: 5000, end: 9000 }),
    tool("edit-file", { path: "b", start: 1000, end: 6000 }),
    tool("fetch-url", { label: "url", start: 2000, end: 3000 }),
    tool("run-command", { label: "build", start: 60_000, end: 64_000 }),
    thought,
  ];
  const original = JSON.stringify(rows);
  expect(workGist(rows)).toBe(
    "Worked for 12s · read 1 file · edited 1 file · fetched 1 page · ran 1 command",
  );
  expect(JSON.stringify(rows)).toBe(original);
});

it("excludes delegate waits, generic programs, explicit waits, browser activity and shell observation", () => {
  expect(
    workGist([
      tool("edit-file", { path: "a", start: 1000, end: 4000 }),
      tool("delegate", { start: 0, end: 300_000 }),
      tool("other", { start: 0, end: 300_000 }),
      tool("browse", { start: 0, end: 300_000 }),
      tool("plan", { start: 0, end: 300_000 }),
      tool("run-command", { input: { command: "build; sleep 60" }, start: 0, end: 300_000 }),
      tool("run-command", { label: "wait for children", start: 0, end: 300_000 }),
      tool("run-command", { label: "poll process", start: 0, end: 300_000 }),
      tool("run-command", { label: "test (background · read)", start: 0, end: 300_000 }),
      tool("run-command", { label: "test (background · killed)", start: 0, end: 300_000 }),
    ]),
  ).toBe(
    "Worked for 3s · edited 1 file · delegated 1 task · used 1 tool · browsed 1 time · updated 1 plan · ran 3 commands",
  );
});

it.each([
  { start: null, end: 2000 },
  { start: 0, end: null },
  { start: NaN, end: 2000 },
  { start: 0, end: Infinity },
  { start: 5000, end: 4999 },
  { start: 0, end: 3_600_001 },
  { start: 0, end: 2000, state: "input-available" as const },
  { start: 0, end: 2000, state: "output-denied" as const },
])("omits the duration for the whole measured set when any call is untrustworthy: %j", (bad) => {
  const gist = workGist([
    tool("edit-file", { path: "a", start: 0, end: 3000 }),
    tool("read-file", { path: "b", ...bad }),
  ]);
  expect(gist).not.toContain("Worked for");
});

it("omits sub-second durations, but includes failed execution time, and normalizes minute rollover", () => {
  expect(workGist([tool("edit-file", { path: "a", start: 0, end: 0 })])).toBe("Edited 1 file");
  expect(workGist([tool("edit-file", { path: "a", start: 0, end: 999 })])).toBe("Edited 1 file");
  expect(
    workGist([tool("edit-file", { path: "a", start: 0, end: 1000, state: "output-error" })]),
  ).toBe("Worked for 1s · 1 failed");
  expect(workGist([tool("run-command", { label: "build", start: 0, end: 60_000 })])).toBe(
    "Worked for 1m 0s · ran 1 command",
  );
  expect(workGist([tool("run-command", { label: "build", start: 0, end: 3_600_000 })])).toBe(
    "Worked for 60m 0s · ran 1 command",
  );
});

it("does not invent clocks from a command label or an unknown command input", () => {
  expect(workGist([tool("run-command", { start: 0, end: 10_000 })])).toBe("Ran 1 command");
  expect(workGist([tool("run-command", { input: { command: 42 }, start: 0, end: 10_000 })])).toBe(
    "Ran 1 command",
  );
  expect(
    workGist([tool("run-command", { input: "build", label: "build", start: 0, end: 1000 })]),
  ).toBe("Worked for 1s · ran 1 command");
});

it("counts distinct known file paths, not repeated reads, edits or basename collisions", () => {
  expect(
    workGist([
      tool("edit-file", { path: "one/a.ts" }),
      tool("edit-file", { path: "one/a.ts" }),
      tool("edit-file", { label: "two/a.ts" }),
      tool("write-file", { label: "new.ts" }),
    ]),
  ).toBe("Edited 2 files · created 1 file");
  expect(
    workGist([
      ...Array.from({ length: 9 }, (_, index) => tool("read-file", { path: `${index}.ts` })),
      tool("read-file", { path: "0.ts" }),
      tool("search"),
      tool("list-directory"),
      thought,
    ]),
  ).toBe("Explored 9 files");
});

it("does not add search result counts or directory counts to a distinct file count", () => {
  expect(workGist([tool("read-file", { path: "a", start: 0, end: 72_000 })])).toBe(
    "Explored 1 file",
  );
  expect(workGist([tool("read-file", { path: "a", state: "input-available" })])).toBe(
    "Exploring 1 file",
  );
  expect(workGist([tool("search"), tool("list-directory")])).toBe("Explored");
  expect(workGist([tool("read-file", { path: "known" }), tool("read-file")])).toBe("Explored");
  expect(workGist([tool("read-file", { path: " " })])).toBe("Explored");
  expect(workGist([tool("read-file", { state: "output-error" })])).toBe("1 failed");
});

it("uses operation counts when a file identity is unavailable instead of inventing distinct files", () => {
  expect(workGist([tool("edit-file")])).toBe("Made 1 file edit");
  expect(workGist([tool("write-file"), tool("write-file")])).toBe("Made 2 file writes");
  expect(workGist([tool("read-file"), tool("other")])).toBe("Made 1 file read · used 1 tool");
  expect(workGist([tool("edit-file", { state: "input-available" })])).toBe("Making 1 file edit");
});

it("keeps observed progress and outcomes honest without making failed edits successful", () => {
  expect(
    workGist([
      tool("edit-file", { path: "a" }),
      tool("run-command", { state: "input-available" }),
      tool("edit-file", { path: "b", state: "output-error" }),
      tool("edit-file", { path: "c", state: "output-error" }),
      tool("other", { state: "output-denied" }),
      tool("other", { state: "approval-requested" }),
    ]),
  ).toBe("Editing 1 file · running 1 command · 2 failed · 1 denied · 1 not run");
  expect(workGist([tool("search", { state: "input-streaming" })])).toBe("Exploring");
  expect(
    workGist([
      tool("read-file", { path: "a" }),
      tool("read-file", { path: "b", state: "input-available" }),
    ]),
  ).toBe("Exploring 2 files");
});

it("totals raw and specialized-envelope failures without claiming successful work", () => {
  const webFailure =
    "404 Not Found for https://example.org/missing, and nothing was fetched.\nThe page was not found.\nReported as response.http. This is what the request met, not a Volli policy: correct the URL, try again later, or read another source, with web_fetch.";
  const rows = [
    tool("edit-file", { path: "a.ts", state: "output-error" }),
    tool("other", { toolName: "web_search", output: webFailure }),
  ];
  expect(workGist(rows)).toBe("2 failed");
  expect(
    workDurationLabel({ key: "failures", rows, startedAt: null, endedAt: null, state: "complete" }),
  ).toBe("2 failed");
});

it("keeps interruption visible and does not revive unfinished replay rows as live progress", () => {
  expect(
    workGist([tool("edit-file", { path: "a", state: "input-available" })], "interrupted"),
  ).toBe("Work interrupted · 1 unfinished");
  expect(workGist([tool("search", { state: "input-available" })], "interrupted")).toBe(
    "Work interrupted · 1 unfinished",
  );
  expect(workGist([tool("other")], "interrupted")).toBe("Work interrupted · used 1 tool");
  expect(workGist([thought])).toBe("Thought");
  expect(workGist([{ ...thought, streaming: true }])).toBe("Thinking");
  expect(workGist([])).toBe("Thought");
  expect(workGist([], "open")).toBe("Thinking");
  expect(workGist([], "interrupted")).toBe("Work interrupted");
});

describe("compact counts for every activity kind", () => {
  it.each([
    ["run-command", "Ran 2 commands"],
    ["fetch-url", "Fetched 2 pages"],
    ["plan", "Updated 2 plans"],
    ["delegate", "Delegated 2 tasks"],
    ["browse", "Browsed 2 times"],
    ["other", "Used 2 tools"],
  ] as const)("counts %s without naming every row", (kind, expected) => {
    expect(workGist([tool(kind), tool(kind)])).toBe(expected);
  });
  it("counts searches and directory listings in mixed groups", () => {
    expect(workGist([tool("search"), tool("list-directory"), tool("other")])).toBe(
      "Searched 1 time · listed 1 directory · used 1 tool",
    );
  });
});
