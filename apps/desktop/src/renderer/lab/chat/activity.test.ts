import { ACTIVITY_METADATA_KEY, type ActivityDescriptor, type ActivityKind } from "@volli/shared";
import type { DynamicToolUIPart, UIMessage } from "ai";
import { describe, expect, it } from "vite-plus/test";

import {
  ACTIVITY_PRESENTERS,
  activityContext,
  activityStatus,
  bundleNeedsAttention,
  bundleSummary,
  compactSignature,
  describeActivity,
  diffStat,
  groupTurns,
  formatBytes,
  formatDuration,
  isBundleStreaming,
  notableDuration,
  NOTABLE_DURATION_MS,
  NAMED_SUBJECT_LIMIT,
  isAwaitingFirstOutput,
  parseDiff,
  parseMatches,
  projectSessionTodos,
  reasoningBody,
  reasoningStatus,
  segmentMessageParts,
  segmentTurn,
  splitPath,
  type BundleRow,
  type ChatSegment,
} from "./activity";

type MessagePart = UIMessage["parts"][number];

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

function message(
  id: string,
  parts: UIMessage["parts"],
  role: UIMessage["role"] = "assistant",
): UIMessage {
  return { id, role, parts };
}

/** A tool whose descriptor carries a real subject, so the summary can name it. */
function named(kind: ActivityKind, label: string): DynamicToolUIPart {
  return tool(kind, { descriptor: { subject: { label, path: label, lineRange: null } } });
}

function bundleOf(segments: readonly ChatSegment[]): BundleRow[] {
  const bundle = segments.find((segment) => segment.kind === "bundle");
  if (bundle?.kind !== "bundle") throw new Error("expected a bundle");
  return bundle.rows;
}

function summaryText(rows: readonly BundleRow[]): string[] {
  return bundleSummary(rows).map((segment) => segment.text);
}

describe("segmentMessageParts", () => {
  it("bundles every non-prose part between two things the agent said", () => {
    const parts: MessagePart[] = [
      { type: "reasoning", text: "plan" },
      tool("read-file"),
      tool("search"),
      tool("run-command"),
      tool("edit-file"),
      { type: "text", text: "done" },
    ];
    const segments = segmentMessageParts(parts, "m1");
    // One bundle, not a reasoning group beside a tool run: the split between
    // read-only and mutating work was invisible to the reader and cost the
    // transcript a second header on its own left edge.
    expect(segments.map((segment) => segment.kind)).toEqual(["bundle", "text"]);
    expect(bundleOf(segments)).toHaveLength(5);
  });

  it("hides plan activity from the transcript", () => {
    expect(segmentMessageParts([tool("plan")], "m2")).toEqual([]);
  });

  it("does not let a blank text part split one bundle into two", () => {
    for (const blank of ["", "   ", "\n\n", "​"]) {
      const segments = segmentMessageParts(
        [
          tool("search"),
          tool("search"),
          { type: "text", text: blank },
          { type: "reasoning", text: "**Reading project files**" },
        ],
        "m2b",
      );
      expect(segments.map((segment) => segment.kind)).toEqual(["bundle"]);
      expect(bundleOf(segments)).toHaveLength(3);
    }
  });

  it("keeps text that only looks blank", () => {
    const segments = segmentMessageParts([{ type: "text", text: "·" }], "m2d");
    expect(segments.map((segment) => segment.kind)).toEqual(["text"]);
  });

  it("drops a reasoning part that settled without ever getting words", () => {
    const segments = segmentMessageParts(
      [{ type: "reasoning", text: "  ", state: "done" }, tool("read-file")],
      "m2e",
    );
    expect(bundleOf(segments)).toHaveLength(1);
  });

  it("keeps a reasoning part that is still streaming, words or not", () => {
    // "Thinking..." is the sign of life; an empty streaming part is the only
    // thing holding the floor before the first token lands.
    const segments = segmentMessageParts(
      [{ type: "reasoning", text: "", state: "streaming" }],
      "m2f",
    );
    expect(bundleOf(segments)).toHaveLength(1);
  });

  it("breaks an approval request out of the bundle", () => {
    const segments = segmentMessageParts(
      [tool("read-file"), tool("run-command", { state: "approval-requested" })],
      "m3",
    );
    // The one thing that blocks the reader must not sit behind a disclosure.
    expect(segments.map((segment) => segment.kind)).toEqual(["bundle", "attention"]);
  });

  it("keeps failures and denials inside the bundle", () => {
    for (const state of ["output-error", "output-denied"] as const) {
      const segments = segmentMessageParts([tool("read-file"), tool("read-file", { state })], "m4");
      // The summary confesses these in red and the bundle opens itself, so
      // breaking them out would only cost the transcript another left edge.
      expect(segments.map((segment) => segment.kind)).toEqual(["bundle"]);
      expect(bundleNeedsAttention(bundleOf(segments))).toBe(true);
    }
  });

  it("degrades to a first-class 'other' row when no descriptor is stamped", () => {
    const part = tool(null, {
      toolName: "linear_create_issue",
      input: { query: "VC-12 chat seam" },
    });
    expect(segmentMessageParts([part], "m5").map((segment) => segment.kind)).toEqual(["bundle"]);
    const row = describeActivity(part);
    expect(row.kind).toBe("other");
    expect(row.verb).toBe("linear_create_issue");
    expect(row.object).toBe("VC-12 chat seam");
  });
});

describe("segmentTurn", () => {
  it("merges the messages a harness split one reply across", () => {
    const segments = segmentTurn([
      message("a1", [tool("read-file"), tool("run-command")]),
      message("a2", [tool("run-command"), tool("run-command")]),
    ]);
    // One bundle, not two stacked headers each summarizing half the work. The
    // step boundary is the harness's, and the reader cannot see it.
    expect(segments.map((segment) => segment.kind)).toEqual(["bundle"]);
    expect(summaryText(bundleOf(segments))).toEqual(["Read 1 file, ran 3 commands"]);
  });

  it("absorbs a step that only thought instead of leaving it stranded", () => {
    const segments = segmentTurn([
      message("a1", [tool("read-file")]),
      message("a2", [{ type: "reasoning", text: "**Planning the next probe**" }]),
      message("a3", [tool("run-command")]),
    ]);
    // Alone, the middle message was a bundle with nothing to count, so it
    // rendered as a bare reasoning row that split the run in two.
    expect(segments.map((segment) => segment.kind)).toEqual(["bundle"]);
    expect(bundleOf(segments).map((row) => row.kind)).toEqual(["tool", "reasoning", "tool"]);
  });

  it("still breaks a bundle where the agent actually spoke", () => {
    const segments = segmentTurn([
      message("a1", [tool("read-file")]),
      message("a2", [{ type: "text", text: "Found the seam." }]),
      message("a3", [tool("run-command")]),
    ]);
    // Prose is a real boundary; only the invisible ones are merged away.
    expect(segments.map((segment) => segment.kind)).toEqual(["bundle", "text", "bundle"]);
  });

  it("keys rows by their own message, so a merged turn has no collisions", () => {
    const segments = segmentTurn([
      message("a1", [tool("read-file")]),
      message("a2", [tool("read-file")]),
    ]);
    const keys = bundleOf(segments).map((row) => row.key);
    expect(keys).toEqual(["a1:0", "a2:0"]);
  });
});

describe("groupTurns", () => {
  it("runs consecutive assistant messages together and breaks at the user", () => {
    const grouped = groupTurns([
      message("u1", [{ type: "text", text: "go" }], "user"),
      message("a1", [tool("read-file")]),
      message("a2", [tool("run-command")]),
      message("u2", [{ type: "text", text: "again" }], "user"),
      message("a3", [tool("read-file")]),
    ]);
    expect(grouped.map((turn) => turn.map((entry) => entry.id))).toEqual([
      ["u1"],
      ["a1", "a2"],
      ["u2"],
      ["a3"],
    ]);
  });

  it("keeps user messages apart even when they arrive back to back", () => {
    const grouped = groupTurns([
      message("u1", [{ type: "text", text: "one" }], "user"),
      message("u2", [{ type: "text", text: "two" }], "user"),
    ]);
    expect(grouped).toHaveLength(2);
  });
});

describe("bundleSummary", () => {
  it("reads as one sentence, in the order the work happened", () => {
    const rows = bundleOf(
      segmentMessageParts(
        [tool("read-file"), tool("read-file"), tool("run-command"), tool("read-file")],
        "s1",
      ),
    );
    // Kinds group even when interleaved, but the phrase order is first
    // appearance -- the sentence tracks the work, not the alphabet.
    expect(summaryText(rows)).toEqual(["Read 3 files, ran 1 command"]);
  });

  it("names the files a turn changed instead of counting them", () => {
    const rows = bundleOf(
      segmentMessageParts(
        [
          tool("read-file"),
          named("edit-file", "src/renderer/lab/chat/activity.ts"),
          named("edit-file", "src/renderer/lab/chat/activity-ui.tsx"),
        ],
        "s2",
      ),
    );
    // The deliverable is the point of the row; `edited 2 files` makes you open
    // the bundle to find out what the turn was even for.
    expect(summaryText(rows)).toEqual(["Read 1 file, edited activity.ts and activity-ui.tsx"]);
  });

  it("counts once naming would become the list again", () => {
    const rows = bundleOf(
      segmentMessageParts(
        Array.from({ length: NAMED_SUBJECT_LIMIT + 1 }, (_, index) =>
          named("edit-file", `file-${index}.ts`),
        ),
        "s3",
      ),
    );
    expect(summaryText(rows)).toEqual([`Edited ${NAMED_SUBJECT_LIMIT + 1} files`]);
  });

  it("falls back to counting when a durable row has no subject", () => {
    const rows = bundleOf(
      segmentMessageParts([named("edit-file", "a.ts"), tool("edit-file")], "s4"),
    );
    expect(summaryText(rows)).toEqual(["Edited 2 files"]);
  });

  it("takes the present participle for work still in flight", () => {
    const rows = bundleOf(
      segmentMessageParts(
        [tool("read-file"), tool("read-file"), tool("run-command", { state: "input-available" })],
        "s5",
      ),
    );
    // Settled kinds stay in the past; only the kind still working moves. This
    // line is the whole report while a turn streams, so it has to say which.
    expect(summaryText(rows)).toEqual(["Read 2 files, running 1 command…"]);
  });

  it("says nothing for a bundle that only thought", () => {
    const rows = bundleOf(segmentMessageParts([{ type: "reasoning", text: "**Planning**" }], "s6"));
    // The reasoning row is its own summary; a header would say it twice.
    expect(summaryText(rows)).toEqual([]);
  });

  it("does not count reasoning among the tools", () => {
    const rows = bundleOf(
      segmentMessageParts([{ type: "reasoning", text: "**Planning**" }, tool("read-file")], "s7"),
    );
    expect(summaryText(rows)).toEqual(["Read 1 file"]);
  });

  it("confesses failures and denials in their own tone", () => {
    const rows = bundleOf(
      segmentMessageParts(
        [
          tool("run-command"),
          tool("run-command", { state: "output-error" }),
          tool("read-file", { state: "output-denied" }),
        ],
        "s8",
      ),
    );
    expect(bundleSummary(rows)).toEqual([
      { text: "Ran 2 commands, read 1 file", tone: "neutral" },
      { text: "1 failed", tone: "danger" },
      { text: "1 denied", tone: "danger" },
    ]);
  });
});

describe("bundle state", () => {
  it("is streaming while any row is unsettled", () => {
    const live = bundleOf(
      segmentMessageParts([tool("run-command", { state: "input-available" })], "b1"),
    );
    const settled = bundleOf(segmentMessageParts([tool("run-command")], "b2"));
    expect(isBundleStreaming(live)).toBe(true);
    expect(isBundleStreaming(settled)).toBe(false);
  });

  it("is streaming while reasoning is still being written", () => {
    const rows = bundleOf(
      segmentMessageParts([{ type: "reasoning", text: "half a th", state: "streaming" }], "b3"),
    );
    expect(isBundleStreaming(rows)).toBe(true);
  });

  it("needs attention only for an outcome the summary would otherwise bury", () => {
    const clean = bundleOf(segmentMessageParts([tool("read-file")], "b4"));
    expect(bundleNeedsAttention(clean)).toBe(false);
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

  it("withholds a duration that is not worth a column", () => {
    // Duration is the fallback meta. Sub-second work is instant, and printing
    // `3ms` beside a read leaves the eye hunting for the numbers that matter.
    expect(notableDuration(3)).toBeNull();
    expect(notableDuration(940)).toBeNull();
    expect(notableDuration(NOTABLE_DURATION_MS)).toBe("1.0s");
    expect(notableDuration(72_000)).toBe("1m12s");
    expect(notableDuration(null)).toBeNull();
  });

  it("drops a trivial duration from the row but keeps a real one", () => {
    const trivial = ACTIVITY_PRESENTERS["run-command"](
      activityContext(tool("run-command", { descriptor: { startedAt: 0, endedAt: 3 } })),
    );
    expect(trivial.meta).toBeNull();
    const real = ACTIVITY_PRESENTERS["run-command"](
      activityContext(tool("run-command", { descriptor: { startedAt: 0, endedAt: 2400 } })),
    );
    expect(real.meta).toBe("2.4s");
  });

  it("never thresholds a semantic meta — it says what happened, not how long", () => {
    const failed = ACTIVITY_PRESENTERS["run-command"](
      activityContext(
        tool("run-command", {
          descriptor: { startedAt: 0, endedAt: 3, outcome: { ...emptyOutcome, exitCode: 1 } },
        }),
      ),
    );
    expect(failed.meta).toBe("exit 1");
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

function assistant(parts: MessagePart[]): UIMessage {
  return { id: "a1", role: "assistant", parts };
}

describe("isAwaitingFirstOutput", () => {
  it("holds the floor until the assistant has something to show", () => {
    expect(isAwaitingFirstOutput([])).toBe(true);
    expect(isAwaitingFirstOutput([{ id: "u1", role: "user", parts: [] }])).toBe(true);
    expect(isAwaitingFirstOutput([assistant([])])).toBe(true);
  });

  it("stands down as soon as the turn renders anything", () => {
    expect(isAwaitingFirstOutput([assistant([{ type: "text", text: "Here" }])])).toBe(false);
    expect(isAwaitingFirstOutput([assistant([{ type: "reasoning", text: "**Checking**" }])])).toBe(
      false,
    );
  });

  it("keeps holding when the only part is one the transcript hides", () => {
    // A plan projects to the rail, not the feed — counting it would leave the
    // reader staring at an empty turn.
    expect(isAwaitingFirstOutput([assistant([tool("plan")])])).toBe(true);
  });
});

describe("reasoningStatus", () => {
  it("promotes the first bold line to the status verb", () => {
    expect(
      reasoningStatus("**Checking the reducer**\n\nmore text", {
        streaming: true,
        durationMs: 4000,
      }),
    ).toEqual({ verb: "Checking the reducer", meta: null });
    expect(
      reasoningStatus("**Checking the reducer**\n", { streaming: false, durationMs: 4000 }),
    ).toEqual({ verb: "Checking the reducer", meta: "4.0s" });
  });

  it("carries no duration while the thought is still live", () => {
    // The number is a receipt for a finished thought. Pinning a counter beside a
    // verb that is still being written is the layout fight every reference app
    // documents avoiding.
    expect(reasoningStatus("thinking out loud", { streaming: true, durationMs: 9000 })).toEqual({
      verb: "Thinking…",
      meta: null,
    });
  });

  it("only promotes a bold line that opens the part", () => {
    // A provider emits one summary per reasoning part, so the promotable header
    // is at position zero. A bold phrase opening a later line is body text.
    expect(
      reasoningStatus("First I check the reducer.\n\n**Not a header**", {
        streaming: false,
        durationMs: 4000,
      }),
    ).toEqual({ verb: "Thought for 4.0s", meta: null });
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
      meta: null,
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
