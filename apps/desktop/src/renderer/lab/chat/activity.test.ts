import { ACTIVITY_METADATA_KEY, type ActivityDescriptor, type ActivityKind } from "@volli/shared";
import type { DynamicToolUIPart, UIMessage } from "ai";
import { describe, expect, it } from "vite-plus/test";

import {
  ACTIVITY_PRESENTERS,
  activityContext,
  activityStatus,
  activitySummary,
  compactSignature,
  describeActivity,
  diffStat,
  formatBytes,
  formatDuration,
  groupMessageParts,
  parseDiff,
  parseMatches,
  projectSessionTodos,
  reasoningBody,
  reasoningStatus,
  rollingTail,
  runSummary,
  splitPath,
  TAIL_LIMIT,
} from "./activity";

type MessagePart = UIMessage["parts"][number];

function descriptor(
  kind: ActivityKind,
  overrides: Partial<ActivityDescriptor> = {},
): ActivityDescriptor {
  return {
    kind,
    nativeToolName: overrides.nativeToolName ?? `native-${kind}`,
    subject: { label: null, path: null, lineRange: null, ...overrides.subject },
    outcome: overrides.outcome ?? null,
    startedAt: overrides.startedAt ?? null,
    endedAt: overrides.endedAt ?? null,
  };
}

/** The SDK types `toolMetadata` as `JSONObject`; a descriptor is one structurally. */
function metadata(value: ActivityDescriptor): DynamicToolUIPart["toolMetadata"] {
  return { [ACTIVITY_METADATA_KEY]: value } as DynamicToolUIPart["toolMetadata"];
}

function tool(
  kind: ActivityKind | null,
  overrides: {
    input?: unknown;
    output?: unknown;
    title?: string;
    toolName?: string;
    state?: DynamicToolUIPart["state"];
    errorText?: string;
    descriptor?: Partial<ActivityDescriptor>;
  } = {},
): DynamicToolUIPart {
  const state = overrides.state ?? "output-available";
  const base = {
    type: "dynamic-tool" as const,
    toolName: overrides.toolName ?? `native-${kind ?? "unknown"}`,
    toolCallId: `call-${kind}-${Math.random().toString(36).slice(2, 8)}`,
    ...(overrides.title === undefined ? {} : { title: overrides.title }),
    ...(kind === null ? {} : { toolMetadata: metadata(descriptor(kind, overrides.descriptor)) }),
  };
  if (state === "output-error") {
    return {
      ...base,
      state: "output-error",
      input: overrides.input ?? null,
      errorText: overrides.errorText ?? "boom",
    };
  }
  if (state === "output-denied") {
    return {
      ...base,
      state: "output-denied",
      input: overrides.input ?? null,
      approval: { id: "approval-1", approved: false, reason: "not this time" },
    };
  }
  if (state === "input-streaming") {
    return { ...base, state: "input-streaming", input: overrides.input ?? null };
  }
  if (state === "input-available") {
    return { ...base, state: "input-available", input: overrides.input ?? null };
  }
  if (state === "approval-requested") {
    return {
      ...base,
      state: "approval-requested",
      input: overrides.input ?? null,
      approval: { id: "approval-1" },
    };
  }
  return {
    ...base,
    state: "output-available",
    input: overrides.input ?? null,
    output: overrides.output ?? null,
  };
}

describe("groupMessageParts", () => {
  it("folds reasoning + read-only activity into one block and keeps mutations first-class", () => {
    const parts: MessagePart[] = [
      { type: "reasoning", text: "plan" },
      tool("read-file"),
      tool("search"),
      tool("run-command"),
      tool("edit-file"),
      { type: "text", text: "done" },
    ];
    const blocks = groupMessageParts(parts, "m1");
    expect(blocks.map((block) => block.kind)).toEqual(["activity", "tool-run", "text"]);
    expect(blocks[0]?.kind === "activity" && blocks[0].items).toHaveLength(3);
    expect(blocks[1]?.kind === "tool-run" && blocks[1].items).toHaveLength(2);
  });

  it("hides plan activity from the transcript", () => {
    expect(groupMessageParts([tool("plan")], "m2")).toEqual([]);
  });

  it("escapes errors, denials and approval requests to their own block", () => {
    for (const state of ["output-error", "output-denied", "approval-requested"] as const) {
      const blocks = groupMessageParts([tool("read-file", { state })], "m3");
      expect(blocks.map((block) => block.kind)).toEqual(["attention"]);
    }
  });

  it("keeps a failed read counted by the group it broke out of", () => {
    const parts: MessagePart[] = [
      tool("read-file"),
      tool("read-file"),
      tool("read-file"),
      tool("read-file", { state: "output-error" }),
    ];
    const blocks = groupMessageParts(parts, "m4");
    expect(blocks.map((block) => block.kind)).toEqual(["activity", "attention"]);
    const activity = blocks[0];
    if (activity?.kind !== "activity") throw new Error("expected activity");
    expect(activitySummary(activity.items)).toEqual([
      { text: "Explored 4 reads", tone: "neutral" },
      { text: "1 failed", tone: "danger" },
    ]);
    expect(blocks[1]?.kind === "attention" && blocks[1].part.state).toBe("output-error");
  });

  it("degrades to a first-class 'other' row when no descriptor is stamped", () => {
    const blocks = groupMessageParts(
      [tool(null, { toolName: "linear_create_issue", input: { query: "VC-12 chat seam" } })],
      "m5",
    );
    expect(blocks.map((block) => block.kind)).toEqual(["tool-run"]);
    const row = describeActivity(
      tool(null, { toolName: "linear_create_issue", input: { query: "VC-12 chat seam" } }),
    );
    expect(row.kind).toBe("other");
    expect(row.verb).toBe("linear_create_issue");
    expect(row.object).toBe("VC-12 chat seam");
  });
});

describe("activitySummary", () => {
  it("counts by kind, not by tool name", () => {
    const items = groupMessageParts(
      [
        { type: "reasoning", text: "x", state: "done" },
        tool("search"),
        tool("search"),
        tool("read-file"),
      ],
      "m",
    )[0];
    if (items?.kind !== "activity") throw new Error("expected activity");
    expect(activitySummary(items.items)).toEqual([
      { text: "Explored 2 searches, 1 read", tone: "neutral" },
    ]);
  });

  it("says nothing when the group is reasoning only — the status line speaks", () => {
    const items = groupMessageParts([{ type: "reasoning", text: "x", state: "done" }], "m")[0];
    if (items?.kind !== "activity") throw new Error("expected activity");
    expect(activitySummary(items.items)).toEqual([]);
  });

  it("reports live work while streaming", () => {
    const items = groupMessageParts([tool("read-file", { state: "input-available" })], "m")[0];
    if (items?.kind !== "activity") throw new Error("expected activity");
    expect(activitySummary(items.items)).toEqual([{ text: "Exploring 1 read", tone: "neutral" }]);
  });
});

describe("runSummary", () => {
  it("names the run by kind so the header can tick", () => {
    const run = groupMessageParts([tool("edit-file"), tool("edit-file")], "m")[0];
    if (run?.kind !== "tool-run") throw new Error("expected tool-run");
    expect(runSummary(run.items)).toEqual([{ text: "2 edits", tone: "neutral" }]);
  });
});

describe("rollingTail", () => {
  const rows = [1, 2, 3, 4, 5, 6];

  it("keeps the limit when nothing is active", () => {
    expect(rollingTail(rows, () => false)).toEqual({ hidden: 3, visible: [4, 5, 6] });
  });

  it("pins the active row and keeps the limit above it", () => {
    expect(rollingTail(rows, (row) => row === 6)).toEqual({ hidden: 2, visible: [3, 4, 5, 6] });
  });

  it("hides nothing under the budget", () => {
    expect(rollingTail([1, 2], () => false)).toEqual({ hidden: 0, visible: [1, 2] });
    expect(TAIL_LIMIT).toBe(3);
  });
});

describe("activityStatus", () => {
  it("separates approval from running", () => {
    expect(activityStatus(tool("run-command", { state: "input-available" }))).toBe("running");
    expect(activityStatus(tool("run-command", { state: "approval-requested" }))).toBe("approval");
    expect(activityStatus(tool("run-command", { state: "input-streaming" }))).toBe("pending");
    expect(activityStatus(tool("run-command", { state: "output-error" }))).toBe("failed");
  });
});

describe("presenters", () => {
  it("derives the verb from the kind and never echoes the result sentence", () => {
    const row = describeActivity(
      tool("run-command", {
        title: "Success. Updated the following files: A CONTRIBUTING.md",
        descriptor: {
          subject: { label: "git status --short", path: null, lineRange: null },
          startedAt: 0,
          endedAt: 2400,
        },
      }),
    );
    expect(row.verb).toBe("Ran");
    expect(row.object).toBe("git status --short");
    expect(row.meta).toBe("2.4s");
  });

  it("run-command reports a non-zero exit in the danger tone", () => {
    const row = describeActivity(
      tool("run-command", {
        descriptor: {
          subject: { label: "pnpm test", path: null, lineRange: null },
          outcome: {
            exitCode: 1,
            matchCount: null,
            fileCount: null,
            lineCount: null,
            bytes: null,
            addedLines: null,
            removedLines: null,
            diff: null,
            summary: null,
          },
        },
      }),
    );
    expect(row.meta).toBe("exit 1");
    expect(row.metaTone).toBe("danger");
  });

  it("edit-file shows the change counts only once settled", () => {
    const outcome = {
      exitCode: null,
      matchCount: null,
      fileCount: null,
      lineCount: null,
      bytes: null,
      addedLines: 49,
      removedLines: 12,
      diff: null,
      summary: null,
    };
    expect(describeActivity(tool("edit-file", { descriptor: { outcome } })).meta).toBe("+49 −12");
    expect(
      describeActivity(tool("edit-file", { state: "input-available", descriptor: { outcome } }))
        .meta,
    ).toBeNull();
  });

  it("read-file shows a line range only for a partial read", () => {
    expect(
      describeActivity(
        tool("read-file", {
          descriptor: {
            subject: {
              label: "src/index.ts",
              path: "src/index.ts",
              lineRange: { start: 1, end: 48 },
            },
          },
        }),
      ).meta,
    ).toBe("1–48");
    expect(describeActivity(tool("read-file")).meta).toBeNull();
  });

  it("search says 'no matches' without an error tone", () => {
    const row = describeActivity(
      tool("search", {
        descriptor: {
          outcome: {
            exitCode: null,
            matchCount: 0,
            fileCount: null,
            lineCount: null,
            bytes: null,
            addedLines: null,
            removedLines: null,
            diff: null,
            summary: null,
          },
        },
      }),
    );
    expect(row.meta).toBe("no matches");
    expect(row.metaTone).toBe("muted");
  });

  it("search counts matches across files", () => {
    const context = activityContext(
      tool("search", {
        descriptor: {
          subject: { label: "useSession", path: null, lineRange: null },
          outcome: {
            exitCode: null,
            matchCount: 14,
            fileCount: 6,
            lineCount: null,
            bytes: null,
            addedLines: null,
            removedLines: null,
            diff: null,
            summary: null,
          },
        },
      }),
    );
    expect(ACTIVITY_PRESENTERS.search(context)).toMatchObject({
      verb: "Grepped",
      object: "useSession",
      meta: "14 in 6 files",
    });
  });

  it("list-directory and fetch-url carry their own numbers", () => {
    const emptyOutcome = {
      exitCode: null,
      matchCount: null,
      fileCount: null,
      lineCount: null,
      bytes: null,
      addedLines: null,
      removedLines: null,
      diff: null,
      summary: null,
    };
    expect(
      describeActivity(
        tool("list-directory", { descriptor: { outcome: { ...emptyOutcome, fileCount: 12 } } }),
      ).meta,
    ).toBe("12 entries");
    expect(
      describeActivity(
        tool("fetch-url", { descriptor: { outcome: { ...emptyOutcome, bytes: 4300 } } }),
      ).meta,
    ).toBe("4.2 KB");
    expect(
      describeActivity(
        tool("write-file", { descriptor: { outcome: { ...emptyOutcome, addedLines: 41 } } }),
      ).meta,
    ).toBe("+41");
  });

  it("delegate names the subagent and joins its summary with the duration", () => {
    const row = describeActivity(
      tool("delegate", {
        descriptor: {
          nativeToolName: "explore",
          subject: { label: "Find the streaming seam", path: null, lineRange: null },
          startedAt: 0,
          endedAt: 72_000,
          outcome: {
            exitCode: null,
            matchCount: null,
            fileCount: null,
            lineCount: null,
            bytes: null,
            addedLines: null,
            removedLines: null,
            diff: null,
            summary: "4 tools",
          },
        },
      }),
    );
    expect(row.verb).toBe("explore");
    expect(row.object).toBe("Find the streaming seam");
    expect(row.meta).toBe("4 tools · 1m12s");
  });

  it("shows raw JSON only for 'other', and only in the detail", () => {
    const other = describeActivity(
      tool(null, { toolName: "linear_create_issue", input: { query: "seam", limit: 3 } }),
    );
    expect(other.detail).toEqual({ view: "signature", text: '({"query":"seam","limit":3})' });
    for (const kind of ["run-command", "read-file", "search", "list-directory"] as const) {
      const row = describeActivity(tool(kind, { output: { unknown: { shape: 1 } } }));
      expect(row.detail?.view === "signature").toBe(false);
    }
  });
});

describe("formatters", () => {
  it("formats durations across the three registers", () => {
    expect(formatDuration(940)).toBe("940ms");
    expect(formatDuration(2400)).toBe("2.4s");
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(72_000)).toBe("1m12s");
    expect(formatDuration(null)).toBeNull();
  });

  it("formats bytes and diff stats", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(4300)).toBe("4.2 KB");
    expect(formatBytes(5_000_000)).toBe("4.8 MB");
    expect(diffStat(descriptor("edit-file"))).toBeNull();
  });

  it("splits paths into directory and basename", () => {
    expect(splitPath("apps/desktop/src/index.ts")).toEqual({
      directory: "apps/desktop/src/",
      basename: "index.ts",
    });
    expect(splitPath("README.md")).toEqual({ directory: "", basename: "README.md" });
  });

  it("compacts a tool signature instead of dumping it", () => {
    expect(compactSignature({ query: "a".repeat(80), limit: 3 })).toBe(
      `({"query":"${"a".repeat(39)}…","limit":3})`,
    );
    expect(compactSignature({})).toBeNull();
  });
});

describe("detail parsers", () => {
  it("keeps diff line kinds and drops git headers", () => {
    expect(
      parseDiff(
        ["diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -1 +1 @@", "-old", "+new", " ctx"].join(
          "\n",
        ),
      ),
    ).toEqual([
      { id: 0, kind: "hunk", text: "@@ -1 +1 @@" },
      { id: 1, kind: "remove", text: "-old" },
      { id: 2, kind: "add", text: "+new" },
      { id: 3, kind: "context", text: " ctx" },
    ]);
  });

  it("groups matches by file and caps the lines it shows", () => {
    const output = [
      "src/a.ts:1:one",
      "src/a.ts:2:two",
      "src/a.ts:3:three",
      "src/a.ts:4:four",
      "src/b.ts:9:nine",
    ].join("\n");
    expect(parseMatches(output)).toEqual([
      { file: "src/a.ts", lines: ["1  one", "2  two", "3  three"], hidden: 1 },
      { file: "src/b.ts", lines: ["9  nine"], hidden: 0 },
    ]);
    expect(parseMatches("no structure here")).toEqual([]);
  });
});

describe("reasoningStatus", () => {
  it("promotes the first bold line to the status verb", () => {
    expect(
      reasoningStatus("**Checking the reducer**\n\nmore text", {
        streaming: true,
        durationMs: 4000,
      }),
    ).toEqual({ verb: "Checking the reducer", meta: "4.0s" });
    expect(
      reasoningStatus("**Checking the reducer**\n", { streaming: false, durationMs: 4000 }),
    ).toEqual({ verb: "Checking the reducer", meta: "4.0s" });
  });

  it("strips the promoted header from the body so it is not said twice", () => {
    expect(reasoningBody("**Running tests**\n\nChecking the reducer path.")).toBe(
      "Checking the reducer path.",
    );
    expect(reasoningBody("**Running tests**")).toBe(null);
    expect(reasoningBody("plain thought")).toBe("plain thought");
    expect(reasoningBody("   ")).toBe(null);
  });

  it("treats a blank bold capture as no header at all", () => {
    // `**  **` trims to "", which `??` would keep — rendering a status line
    // carrying a duration and no words.
    expect(reasoningStatus("**  **\nrest", { streaming: true, durationMs: 4000 })).toEqual({
      verb: "Thinking…",
      meta: "4.0s",
    });
    expect(reasoningStatus("**  **\nrest", { streaming: false, durationMs: 23000 })).toEqual({
      verb: "Thought for 23s",
      meta: null,
    });
  });

  it("falls back to a duration sentence when nothing is bold", () => {
    expect(reasoningStatus("plain thought", { streaming: false, durationMs: 8000 })).toEqual({
      verb: "Thought for 8.0s",
      meta: null,
    });
    expect(reasoningStatus("plain thought", { streaming: false })).toEqual({
      verb: "Thought",
      meta: null,
    });
    expect(reasoningStatus("plain", { streaming: true })).toEqual({
      verb: "Thinking…",
      meta: null,
    });
  });
});

describe("projectSessionTodos", () => {
  it("reads the latest plan activity", () => {
    const todos = projectSessionTodos([
      {
        id: "a1",
        role: "assistant",
        parts: [
          tool("plan", {
            input: {
              todos: [
                { id: "t1", content: "First", status: "completed", priority: "high" },
                { id: "t2", content: "Second", status: "in_progress", priority: "medium" },
              ],
            },
          }),
        ],
      },
    ]);
    expect(todos).toEqual([
      { id: "t1", content: "First", status: "completed", priority: "high" },
      { id: "t2", content: "Second", status: "in_progress", priority: "medium" },
    ]);
  });

  it("accepts todos without ids and JSON-string tool output", () => {
    const fromLegacyShape = projectSessionTodos([
      {
        id: "a2",
        role: "assistant",
        parts: [
          tool("plan", {
            input: {
              todos: [
                { content: "Ship it", status: "in_progress", priority: "high" },
                { content: "Verify", status: "pending", priority: "medium" },
              ],
            },
          }),
        ],
      },
    ]);
    expect(fromLegacyShape?.map((todo) => todo.content)).toEqual(["Ship it", "Verify"]);
    expect(fromLegacyShape?.every((todo) => todo.id.length > 0)).toBe(true);

    const fromJsonOutput = projectSessionTodos([
      {
        id: "a3",
        role: "assistant",
        parts: [
          tool("plan", {
            output: JSON.stringify([
              { content: "Only output", status: "pending", priority: "low" },
            ]),
          }),
        ],
      },
    ]);
    expect(fromJsonOutput).toEqual([
      expect.objectContaining({ content: "Only output", status: "pending", priority: "low" }),
    ]);
  });

  it("ignores messages with no plan activity", () => {
    expect(
      projectSessionTodos([{ id: "a4", role: "assistant", parts: [tool("read-file")] }]),
    ).toBeNull();
  });
});
