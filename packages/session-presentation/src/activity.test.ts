import { ACTIVITY_METADATA_KEY, type ActivityDescriptor, type ActivityKind } from "@volli/shared";
import type { DynamicToolUIPart, UIMessage } from "ai";
import { describe, expect, it } from "vite-plus/test";

import {
  ACTIVITY_PRESENTERS,
  activityContext,
  activityStatus,
  gatedToolCallId,
  bestEffortSubject,
  bundleNeedsAttention,
  gatedToolCallIds,
  bundleSummary,
  compactSignature,
  describeActivity,
  detailText,
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
    preliminary?: boolean;
    errorText?: string;
    approved?: boolean;
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
  if (state === "approval-responded") {
    return {
      ...base,
      state: "approval-responded",
      input: overrides.input ?? null,
      approval: { id: "approval-1", approved: overrides.approved ?? true },
    };
  }
  return {
    ...base,
    state: "output-available",
    input: overrides.input ?? null,
    output: overrides.output ?? null,
    ...(overrides.preliminary === undefined ? {} : { preliminary: overrides.preliminary }),
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

/** The same part, counting how many times anything reads its payload at all. */
function countingOutput(part: DynamicToolUIPart): { part: DynamicToolUIPart; reads(): number } {
  const value = "output" in part ? part.output : undefined;
  let reads = 0;
  const spied = { ...part } as DynamicToolUIPart;
  Object.defineProperty(spied, "output", {
    enumerable: true,
    configurable: true,
    get: () => {
      reads += 1;
      return value;
    },
  });
  return { part: spied, reads: () => reads };
}

function bundleOf(segments: readonly ChatSegment[]): BundleRow[] {
  const bundle = segments.find((segment) => segment.kind === "bundle");
  if (bundle?.kind !== "bundle") throw new Error("expected a bundle");
  return bundle.rows;
}

/** Which thoughts in a bundle still claim to be running, in order. */
function thoughts(rows: readonly BundleRow[]): boolean[] {
  return rows.filter((row) => row.kind === "reasoning").map((row) => row.streaming);
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

  it("keeps plan activity in the transcript once there is no synthesized dock", () => {
    expect(segmentMessageParts([tool("plan")], "m2").map((segment) => segment.kind)).toEqual([
      "bundle",
    ]);
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

  it("breaks a gated call out of the bundle", () => {
    const segments = segmentMessageParts(
      [tool("read-file"), tool("run-command", { state: "approval-requested" })],
      "m3",
    );
    // The one thing that leaves. It blocks the reader and it needs controls, so
    // it must not sit behind a disclosure — and its decision draws under it,
    // beside the command it is about.
    expect(segments.map((segment) => segment.kind)).toEqual(["bundle", "attention"]);
    expect(bundleOf(segments)).toHaveLength(1);
  });

  it("closes the bundle around it rather than reordering the turn", () => {
    const segments = segmentMessageParts(
      [tool("read-file"), tool("run-command", { state: "approval-requested" }), tool("search")],
      "m3b",
    );
    expect(segments.map((segment) => segment.kind)).toEqual(["bundle", "attention", "bundle"]);
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

  it("ignores a part that is neither prose, thought, nor tool", () => {
    // A step boundary some harnesses emit between messages; it carries nothing
    // for the transcript to show and must not open or break a bundle.
    const segments = segmentMessageParts(
      [tool("read-file"), { type: "step-start" }, tool("run-command")],
      "m6",
    );
    expect(segments.map((segment) => segment.kind)).toEqual(["bundle"]);
    expect(bundleOf(segments)).toHaveLength(2);
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

  it("names a single file without a joining word", () => {
    const rows = bundleOf(segmentMessageParts([named("edit-file", "activity.ts")], "s9"));
    expect(summaryText(rows)).toEqual(["Edited activity.ts"]);
  });

  it("falls back to the full label when trimming to a basename empties it", () => {
    // `splitPath` on a trailing slash yields an empty basename; the whole
    // label reads better than nothing.
    const rows = bundleOf(segmentMessageParts([named("edit-file", "src/generated/")], "s10"));
    expect(summaryText(rows)).toEqual(["Edited src/generated/"]);
  });
});

describe("thought settlement", () => {
  const live = {
    type: "reasoning" as const,
    text: "**Tracing the seam**",
    state: "streaming" as const,
  };

  it("stops a thought the moment a tool call follows it", () => {
    const rows = bundleOf(segmentMessageParts([live, tool("read-file")], "t1"));
    // The part still says `streaming` — OpenCode never flips it back — but the
    // model plainly finished thinking, or it could not have called a tool.
    expect(thoughts(rows)).toEqual([false]);
  });

  it("stops a thought when the agent starts speaking", () => {
    const segments = segmentMessageParts([live, { type: "text", text: "Found it." }], "t2");
    expect(thoughts(bundleOf(segments))).toEqual([false]);
  });

  it("leaves only the last of several thoughts running", () => {
    const rows = bundleOf(segmentMessageParts([live, live, live], "t3"));
    expect(thoughts(rows)).toEqual([false, false, true]);
  });

  it("keeps the final thought running while it is genuinely the last row", () => {
    const rows = bundleOf(segmentMessageParts([tool("read-file"), live], "t4"));
    expect(thoughts(rows)).toEqual([true]);
  });

  it("settles a thought that a later message overtook", () => {
    // The whole point of merging the turn: the tool arrives in its own message,
    // and per-message segmentation could never have seen it.
    const rows = bundleOf(segmentTurn([message("a1", [live]), message("a2", [tool("read-file")])]));
    expect(thoughts(rows)).toEqual([false]);
  });

  it("drops a wordless thought that nothing will ever fill", () => {
    const rows = bundleOf(
      segmentMessageParts(
        [{ type: "reasoning", text: "", state: "streaming" }, tool("read-file")],
        "t6",
      ),
    );
    expect(rows.map((row) => row.kind)).toEqual(["tool"]);
  });

  it("drops an entire bundle that turns out to hold only wordless thoughts", () => {
    // Nothing else was ever pushed into it, so once the one settled reasoning
    // row is filtered out the bundle itself has nothing left to summarize.
    const segments = segmentMessageParts([{ type: "reasoning", text: "  ", state: "done" }], "t9");
    expect(segments).toEqual([]);
  });

  it("keeps a wordless thought that is still being written", () => {
    const rows = bundleOf(
      segmentMessageParts([{ type: "reasoning", text: "", state: "streaming" }], "t7"),
    );
    // Before the first token there is nothing else holding the floor.
    expect(thoughts(rows)).toEqual([true]);
  });

  it("does not report a settled thought as live work", () => {
    const rows = bundleOf(segmentMessageParts([live, { type: "text", text: "x" }], "t8"));
    expect(isBundleStreaming(rows)).toBe(false);
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

describe("the decision a call is gated on", () => {
  it("reads the tool call id off the gated state and nowhere else", () => {
    const gated = tool("run-command", { state: "approval-requested" });
    expect(gatedToolCallId(gated)).toBe(gated.toolCallId);
    expect(gatedToolCallId(tool("run-command", { state: "output-denied" }))).toBe(null);
    expect(gatedToolCallId(tool("run-command"))).toBe(null);
  });

  it("collects every gate the transcript is already showing", () => {
    // What the foot slot subtracts. An interaction drawn on its row and again
    // under the composer is one question asked twice.
    const gated = tool("run-command", { state: "approval-requested" });
    const messages = [
      message("m1", [tool("read-file"), gated]),
      message("m2", [{ type: "text", text: "waiting" }]),
    ];
    expect([...gatedToolCallIds(messages)]).toEqual([gated.toolCallId]);
    expect(gatedToolCallIds([message("m3", [tool("read-file")])]).size).toBe(0);
  });
});

describe("activityStatus", () => {
  it("separates approval from running", () => {
    expect(activityStatus(tool("run-command", { state: "input-available" }))).toBe("running");
    expect(activityStatus(tool("run-command", { state: "approval-requested" }))).toBe("approval");
    expect(activityStatus(tool("run-command", { state: "input-streaming" }))).toBe("pending");
    expect(activityStatus(tool("run-command", { state: "output-error" }))).toBe("failed");
  });

  it("resumes running once a gated call is approved, or stays denied", () => {
    expect(
      activityStatus(tool("run-command", { state: "approval-responded", approved: true })),
    ).toBe("running");
    expect(
      activityStatus(tool("run-command", { state: "approval-responded", approved: false })),
    ).toBe("denied");
  });

  it("keeps a generic preliminary result running without inspecting its native name", () => {
    expect(
      activityStatus(
        tool("read-file", {
          state: "output-available",
          preliminary: true,
          toolName: "volli.activity",
          descriptor: { nativeToolName: "read" },
        }),
      ),
    ).toBe("running");
  });

  it("settles a final result when preliminary is false or absent", () => {
    expect(
      activityStatus(tool("read-file", { state: "output-available", preliminary: false })),
    ).toBe("done");
    expect(activityStatus(tool("read-file", { state: "output-available" }))).toBe("done");
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

  it("keeps bash's actual command and content-block output together", () => {
    const command = "pnpm run typecheck &&\npnpm run test";
    const row = describeActivity(
      tool("run-command", {
        input: { command },
        output: { content: [{ type: "text", text: "Typecheck passed\nTests passed" }] },
        // A descriptor is a summary of the activity, not a second source of
        // truth for the command a runtime actually received.
        descriptor: {
          subject: { label: "validation", path: null, lineRange: null },
        },
      }),
    );

    expect(row.object).toBe(command);
    expect(row.command).toBe(command);
    expect(row.detail).toEqual({ view: "output", text: "Typecheck passed\nTests passed" });
  });

  it("falls back to the durable command when the call has no command text", () => {
    const row = describeActivity(
      tool("run-command", {
        input: { command: "   " },
        descriptor: { subject: { label: "pnpm test", path: null, lineRange: null } },
      }),
    );

    expect(row.object).toBe("pnpm test");
    expect(row.command).toBe("pnpm test");
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

  it("carries the harness's error text on a failed row", () => {
    const row = describeActivity(
      tool("run-command", { state: "output-error", errorText: "exit 127: not found" }),
    );
    expect(row.errorText).toBe("exit 127: not found");
    expect(describeActivity(tool("run-command")).errorText).toBeNull();
  });

  it("shows a pending row before the harness has sent any input at all", () => {
    // `input?: unknown` — a harness may open a call before it has streamed a
    // single argument, so the part carries no `input` key at all rather than an
    // explicit null one.
    const part: DynamicToolUIPart = {
      type: "dynamic-tool",
      toolName: "native-other",
      toolCallId: "call-raw-1",
      state: "input-streaming",
    };
    const row = describeActivity(part);
    expect(row.status).toBe("pending");
    expect(row.object).toBeNull();
  });

  it("keeps legacy plan contents readable inline after removing the synthesized dock", () => {
    const row = describeActivity(
      tool("plan", {
        input: {
          todos: [
            { content: "Read the seam", status: "completed" },
            { content: "Ship the slice", status: "in_progress" },
          ],
        },
      }),
    );
    expect(row.verb).toBe("Planned");
    expect(row.meta).toBeNull();
    expect(row.detail).toEqual({ view: "output", text: "✓ Read the seam\n→ Ship the slice" });
    expect(
      describeActivity(
        tool("plan", {
          output: JSON.stringify([{ content: "Read JSON history", status: "pending" }]),
        }),
      ).detail,
    ).toEqual({ view: "output", text: "○ Read JSON history" });
    expect(
      describeActivity(
        tool("plan", { input: [{ content: "Read array history", status: "cancelled" }] }),
      ).detail,
    ).toEqual({ view: "output", text: "× Read array history" });
    expect(describeActivity(tool("plan", { input: [{ content: "No status" }] })).detail).toEqual({
      view: "output",
      text: "○ No status",
    });
    expect(
      describeActivity(tool("plan", { input: [null, { status: "pending" }, { content: "" }] }))
        .detail,
    ).toBeNull();
    expect(describeActivity(tool("plan", { output: "not json" })).detail).toBeNull();
    expect(describeActivity(tool("plan", { input: { todos: [] } })).detail).toBeNull();
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

  it("edit-file shows the real diff when the harness sends one", () => {
    const row = describeActivity(
      tool("edit-file", {
        descriptor: { outcome: { ...emptyOutcome, diff: "@@ -1 +1 @@\n-old\n+new" } },
      }),
    );
    expect(row.detail).toEqual({
      view: "diff",
      lines: [
        { id: 0, kind: "hunk", text: "@@ -1 +1 @@" },
        { id: 1, kind: "remove", text: "-old" },
        { id: 2, kind: "add", text: "+new" },
      ],
    });
  });

  it("edit-file falls back to plain output when the harness sends no diff", () => {
    const row = describeActivity(tool("edit-file", { output: "patched" }));
    expect(row.detail).toEqual({ view: "output", text: "patched" });
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

  it("numbers a partial read starting from where it began", () => {
    const row = describeActivity(
      tool("read-file", {
        output: "first\nsecond\nthird",
        descriptor: { subject: { label: null, path: null, lineRange: { start: 10, end: 12 } } },
      }),
    );
    expect(row.detail).toEqual({
      view: "numbered",
      lines: [
        { number: 10, text: "first" },
        { number: 11, text: "second" },
        { number: 12, text: "third" },
      ],
    });
  });

  it("numbers a full read from line one when no range is given", () => {
    const row = describeActivity(tool("read-file", { output: "only line" }));
    expect(row.detail).toEqual({ view: "numbered", lines: [{ number: 1, text: "only line" }] });
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

  it("search shows no meta while the grep is still running", () => {
    expect(describeActivity(tool("search", { state: "input-available" })).meta).toBeNull();
  });

  it("search counts matches even when the harness reports no file count", () => {
    const row = describeActivity(
      tool("search", { descriptor: { outcome: { ...emptyOutcome, matchCount: 5 } } }),
    );
    expect(row.meta).toBe("5");
  });

  it("search says 'file' in the singular", () => {
    const row = describeActivity(
      tool("search", { descriptor: { outcome: { ...emptyOutcome, matchCount: 3, fileCount: 1 } } }),
    );
    expect(row.meta).toBe("3 in 1 file");
  });

  it("search detail groups real matches by file", () => {
    const row = describeActivity(tool("search", { output: "src/a.ts:1:one\nsrc/a.ts:2:two" }));
    expect(row.detail).toEqual({
      view: "matches",
      groups: [{ file: "src/a.ts", lines: ["1  one", "2  two"], hidden: 0 }],
    });
  });

  it("search detail falls back to plain output when nothing parses as a match", () => {
    const row = describeActivity(tool("search", { output: "no structure here" }));
    expect(row.detail).toEqual({ view: "output", text: "no structure here" });
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

  it("list-directory uses the singular for one entry", () => {
    expect(
      describeActivity(
        tool("list-directory", { descriptor: { outcome: { ...emptyOutcome, fileCount: 1 } } }),
      ).meta,
    ).toBe("1 entry");
  });

  it("write-file counts total lines when nothing marks them added", () => {
    // Some harnesses report only how long the file is, not how many lines were
    // newly written; total length is the honest number to show as "added".
    expect(
      describeActivity(
        tool("write-file", { descriptor: { outcome: { ...emptyOutcome, lineCount: 20 } } }),
      ).meta,
    ).toBe("+20");
  });

  it("write-file has no count to show when the harness reports none", () => {
    expect(describeActivity(tool("write-file")).meta).toBeNull();
  });

  it("write-file shows no count before the write settles", () => {
    expect(
      describeActivity(
        tool("write-file", {
          state: "input-available",
          descriptor: { outcome: { ...emptyOutcome, addedLines: 41 } },
        }),
      ).meta,
    ).toBeNull();
  });

  it("write-file shows the content it wrote", () => {
    const row = describeActivity(tool("write-file", { input: "line one\nline two" }));
    expect(row.detail).toEqual({ view: "output", text: "line one\nline two" });
  });

  it("fetch-url falls back to duration when the harness reports no size", () => {
    const row = describeActivity(
      tool("fetch-url", { descriptor: { startedAt: 0, endedAt: 2400 } }),
    );
    expect(row.meta).toBe("2.4s");
  });

  it("fetch-url shows no meta before the fetch settles", () => {
    expect(describeActivity(tool("fetch-url", { state: "input-available" })).meta).toBeNull();
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

  it("delegate reports nothing extra when the child leaves no summary", () => {
    const row = describeActivity(
      tool("delegate", { descriptor: { nativeToolName: "explore", startedAt: 0, endedAt: 3 } }),
    );
    expect(row.meta).toBeNull();
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

  it("shows nothing in the detail when 'other' has no input and no output", () => {
    const row = describeActivity(tool(null, { toolName: "noop" }));
    expect(row.detail).toBeNull();
  });

  it("reads output text from any of the harness's common field names", () => {
    const row = describeActivity(tool("run-command", { output: { text: "   ", stdout: "ok\n" } }));
    expect(row.detail).toEqual({ view: "output", text: "ok\n" });
  });

  it("drops non-text and blank content blocks", () => {
    const row = describeActivity(
      tool("run-command", {
        output: {
          content: [
            null,
            { type: "image", text: "ignored" },
            { type: "text" },
            { type: "text", text: "  " },
          ],
        },
      }),
    );

    expect(row.detail).toBeNull();
  });

  it("treats blank output as no output at all", () => {
    expect(describeActivity(tool("run-command", { output: "   " })).detail).toBeNull();
  });
});

/**
 * The transcript repaints on every streamed token, and both of these run the
 * whole detail budget — or a `JSON.parse` of a plan — when they run at all.
 * Identity is the contract the UI memoizes on, so it is asserted rather than
 * inferred: a stable part must come back as the *same* row, not an equal one.
 */
describe("memoization", () => {
  it("describes a part once, however often the transcript asks", () => {
    const output = Array.from({ length: 900 }, (_, index) => `line ${index}`).join("\n");
    const { part, reads } = countingOutput(tool("run-command", { output }));

    const first = describeActivity(part);
    expect(describeActivity(part)).toBe(first);
    expect(describeActivity(part)).toBe(first);
    expect(reads()).toBe(1);
    // Still the clamped window it always was — this changes when work happens,
    // never what the work produced.
    expect(first.detail).toEqual({
      view: "output",
      text: `${output.split("\n").slice(0, 400).join("\n")}\n…`,
    });
  });

  it("re-describes the next snapshot of the same call", () => {
    // A harness that changes a call commits a new part rather than editing the
    // old one, so a new object is the only signal a row moved — and it must not
    // be answered from the previous snapshot's cache.
    const running = tool("run-command", { state: "input-available" });
    const settled = tool("run-command", { output: "done" });
    expect(describeActivity(running).status).toBe("running");
    expect(describeActivity(settled).status).toBe("done");
    expect(describeActivity(settled)).not.toBe(describeActivity(running));
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
    expect(formatBytes(null)).toBeNull();
    expect(diffStat(descriptor("edit-file"))).toBeNull();
  });

  it("diff stats zero out the side the harness never reported", () => {
    expect(diffStat(descriptor("edit-file", { outcome: { ...emptyOutcome, addedLines: 5 } }))).toBe(
      "+5 −0",
    );
    expect(
      diffStat(descriptor("edit-file", { outcome: { ...emptyOutcome, removedLines: 3 } })),
    ).toBe("+0 −3");
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

  it("compacts a bare string input inline", () => {
    expect(compactSignature("find the seam")).toBe("(find the seam)");
    expect(compactSignature(42)).toBeNull();
  });

  it("compacts every value shape a tool call carries", () => {
    expect(
      compactSignature({ count: 3, ok: true, missing: null, tags: ["a", "b"], nested: { x: 1 } }),
    ).toBe('({"count":3,"ok":true,"missing":null,"tags":[2],"nested":{…}})');
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

describe("detailText", () => {
  it("surfaces the plain-text views and hides the structured ones", () => {
    // Cards show text, not views — the detail's own presentation stays inside.
    expect(detailText(null)).toBeNull();
    expect(detailText({ view: "output", text: "hello" })).toBe("hello");
    expect(detailText({ view: "signature", text: "(x)" })).toBe("(x)");
    expect(detailText({ view: "diff", lines: [] })).toBeNull();
    expect(detailText({ view: "numbered", lines: [] })).toBeNull();
    expect(detailText({ view: "matches", groups: [] })).toBeNull();
  });
});

describe("bestEffortSubject", () => {
  it("trims a bare string input", () => {
    expect(bestEffortSubject("  git status  ")).toBe("git status");
    expect(bestEffortSubject("   ")).toBeNull();
  });

  it("returns null for input that carries no usable shape", () => {
    expect(bestEffortSubject(42)).toBeNull();
    expect(bestEffortSubject(null)).toBeNull();
  });

  it("skips fields that cannot be a usable label", () => {
    expect(
      bestEffortSubject({ count: 3, blank: "   ", blob: "x".repeat(241), note: "the real one" }),
    ).toBe("the real one");
  });

  it("finds nothing when every field is unusable", () => {
    expect(bestEffortSubject({ count: 3, blank: "   ", blob: "x".repeat(241) })).toBeNull();
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

  it("stops holding when plan activity appears inline", () => {
    expect(isAwaitingFirstOutput([assistant([tool("plan")])])).toBe(false);
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
