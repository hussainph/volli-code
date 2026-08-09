/**
 * The transcript's component gallery.
 *
 * Every shape the chat surface can render, against fixture parts, with no
 * OpenCode process and no Electron. That is the point: the transcript's hard
 * cases are streaming states, failure states and the rolling tail, and those
 * are exactly the ones you cannot summon on demand from a live adapter — you
 * wait for a tool to fail, or you never see the row you changed.
 *
 * Fixtures are built the same way the adapter builds real ones: a descriptor
 * stamped into `toolMetadata` under `ACTIVITY_METADATA_KEY`. Nothing here knows
 * a harness tool name, so a row that reads correctly here reads correctly for
 * any adapter that fills the same descriptor.
 *
 * The composer at the bottom is live and fully controlled — type into it, open
 * the model pill, and exercise its keystrokes: ⏎ sends or queues depending on
 * the state toggle, ⌘⏎ steers, ⌫ on an empty box takes the queued message back.
 *
 * Plan activity stays in the transcript like every other structured activity;
 * there is no synthesized rail projection.
 */
import * as React from "react";
import {
  ACTIVITY_KINDS,
  ACTIVITY_METADATA_KEY,
  type ActivityDescriptor,
  type ActivityKind,
  type ActivityOutcome,
  type SessionInteraction,
} from "@volli/shared";
import type { DynamicToolUIPart, ReasoningUIPart } from "ai";

import { type BundleRow } from "@renderer/chat/activity";
import { enqueueMessage, type QueuedMessage } from "@renderer/chat/session-model";
import { ActivityBundle, AttentionReceipt, ToolRow } from "@renderer/components/chat/activity-ui";
import {
  SessionComposer,
  type ComposerModel,
  type ComposerModelSelection,
} from "@renderer/components/chat/composer-ui";
import { InteractionCard, InteractionReceiptLine } from "@renderer/components/chat/interaction-ui";
import { ContentColumn } from "@renderer/components/layout/content-column";
import { Button } from "@renderer/components/ui/button";

export const title = "Chat activity · fixtures";
export const note = "Every transcript row, state and composer mode without a live Session";
export const viewport = "stage" as const;

/* ----------------------------------------------------------------- builders */

function outcome(patch: Partial<ActivityOutcome>): ActivityOutcome {
  return {
    exitCode: null,
    matchCount: null,
    fileCount: null,
    lineCount: null,
    bytes: null,
    addedLines: null,
    removedLines: null,
    diff: null,
    summary: null,
    ...patch,
  };
}

function descriptor(
  kind: ActivityKind,
  patch: Partial<ActivityDescriptor> = {},
): ActivityDescriptor {
  return {
    kind,
    nativeToolName: patch.nativeToolName ?? kind,
    subject: { label: null, path: null, lineRange: null, ...patch.subject },
    outcome: patch.outcome ?? null,
    startedAt: patch.startedAt ?? 0,
    endedAt: patch.endedAt ?? 2400,
  };
}

/** The SDK types `toolMetadata` as `JSONObject`; a descriptor is one structurally. */
function metadata(value: ActivityDescriptor): DynamicToolUIPart["toolMetadata"] {
  return { [ACTIVITY_METADATA_KEY]: value } as DynamicToolUIPart["toolMetadata"];
}

let toolSeq = 0;

function tool(
  activity: ActivityDescriptor,
  options: {
    state?: DynamicToolUIPart["state"];
    input?: unknown;
    output?: unknown;
    errorText?: string;
  } = {},
): DynamicToolUIPart {
  toolSeq += 1;
  const base = {
    type: "dynamic-tool" as const,
    toolName: activity.nativeToolName,
    toolCallId: `fixture-${toolSeq}`,
    toolMetadata: metadata(activity),
  };
  const state = options.state ?? "output-available";
  const input = options.input ?? null;
  switch (state) {
    case "input-streaming":
      return { ...base, state: "input-streaming", input };
    case "input-available":
      return { ...base, state: "input-available", input };
    case "approval-requested":
      return { ...base, state: "approval-requested", input, approval: { id: "ask-1" } };
    case "output-denied":
      return {
        ...base,
        state: "output-denied",
        input,
        approval: { id: "ask-1", approved: false, reason: "not this time" },
      };
    case "output-error":
      return {
        ...base,
        state: "output-error",
        input,
        errorText: options.errorText ?? "ENOENT: no such file or directory",
      };
    default:
      return { ...base, state: "output-available", input, output: options.output ?? null };
  }
}

function reasoning(text: string, state: ReasoningUIPart["state"] = "done"): ReasoningUIPart {
  return { type: "reasoning", text, state };
}

/* ----------------------------------------------------------------- fixtures */

const DIFF = `@@ -12,7 +12,9 @@ export function greeting(name: string) {
-  return "Hello!";
+  if (!name) return "Hello!";
+  return \`Hello, \${name}!\`;
 }
   // unchanged trailer`;

const GREP_OUTPUT = [
  "src/renderer/lab/chat/activity.ts:77:export function groupMessageParts(",
  "src/renderer/lab/chat/activity.ts:141:  return blocks;",
  "src/renderer/lab/chat/activity.ts:174:export function isActivityStreaming(",
  "src/renderer/lab/chat/activity.ts:203:  const failed = tools.filter(",
  "packages/shared/src/session-activity.ts:92:export function readActivityDescriptor(",
].join("\n");

/** One settled row per kind, each carrying the meta its presenter earns. */
const KIND_ROWS: Record<ActivityKind, DynamicToolUIPart> = {
  "run-command": tool(
    descriptor("run-command", {
      subject: { label: "pnpm test", path: null, lineRange: null },
      outcome: outcome({ exitCode: 0 }),
    }),
    { output: "Test Files  12 passed (12)\nTests  184 passed (184)" },
  ),
  "read-file": tool(
    descriptor("read-file", {
      subject: {
        label: "packages/shared/src/session-activity.ts",
        path: "packages/shared/src/session-activity.ts",
        lineRange: { start: 17, end: 30 },
      },
    }),
    { output: 'export const ACTIVITY_KINDS = [\n  "run-command",\n  "read-file",\n] as const;' },
  ),
  "edit-file": tool(
    descriptor("edit-file", {
      subject: {
        label: "src/greeting.ts",
        path: "src/greeting.ts",
        lineRange: null,
      },
      outcome: outcome({ addedLines: 49, removedLines: 12, diff: DIFF }),
    }),
  ),
  "write-file": tool(
    descriptor("write-file", {
      subject: { label: "src/hello.test.ts", path: "src/hello.test.ts", lineRange: null },
      outcome: outcome({ addedLines: 41 }),
    }),
    { input: 'import { expect, it } from "vite-plus/test";\n\nit("greets", () => {});' },
  ),
  search: tool(
    descriptor("search", {
      subject: { label: "groupMessageParts", path: null, lineRange: null },
      outcome: outcome({ matchCount: 14, fileCount: 6 }),
    }),
    { output: GREP_OUTPUT },
  ),
  "list-directory": tool(
    descriptor("list-directory", {
      subject: { label: "src/renderer/lab/chat/", path: null, lineRange: null },
      outcome: outcome({ fileCount: 12 }),
    }),
    { output: "activity.ts\nactivity-ui.tsx\ncomposer-ui.tsx\nsession-model.ts" },
  ),
  "fetch-url": tool(
    descriptor("fetch-url", {
      subject: { label: "example.com/spec", path: null, lineRange: null },
      outcome: outcome({ bytes: 4300 }),
    }),
    { output: "<!doctype html>…" },
  ),
  plan: tool(descriptor("plan", { subject: { label: "3 steps", path: null, lineRange: null } })),
  delegate: tool(
    descriptor("delegate", {
      nativeToolName: "explore",
      subject: { label: "Find the streaming seam", path: null, lineRange: null },
      outcome: outcome({ summary: "4 tools" }),
      endedAt: 72_000,
    }),
    { output: "The seam is `projectTranscriptMessages` in session-controller.ts." },
  ),
  other: tool(
    descriptor("other", {
      nativeToolName: "linear_create_issue",
      subject: { label: "VC-12 chat seam", path: null, lineRange: null },
    }),
    { input: { title: "VC-12 chat seam", teamId: "VC", labels: ["chat", "ui"] } },
  ),
};

const EXPLORE_RUN: DynamicToolUIPart[] = [
  tool(
    descriptor("read-file", {
      subject: { label: "apps/desktop/src/main/index.ts", path: "a.ts", lineRange: null },
    }),
    { output: "app.whenReady()" },
  ),
  tool(
    descriptor("search", {
      subject: { label: "createWindow", path: null, lineRange: null },
      outcome: outcome({ matchCount: 3, fileCount: 2 }),
    }),
    { output: GREP_OUTPUT },
  ),
  tool(
    descriptor("list-directory", {
      subject: { label: "apps/desktop/src/preload/", path: null, lineRange: null },
      outcome: outcome({ fileCount: 4 }),
    }),
    { output: "index.ts\napi.ts" },
  ),
  tool(
    descriptor("read-file", {
      subject: { label: "apps/desktop/src/preload/api.ts", path: "b.ts", lineRange: null },
    }),
    { output: "contextBridge.exposeInMainWorld" },
  ),
  tool(
    descriptor("read-file", {
      subject: { label: "packages/session-engine/src/index.ts", path: "c.ts", lineRange: null },
    }),
    { output: "export * from './session'" },
  ),
  tool(
    descriptor("search", {
      subject: { label: "SessionProjection", path: null, lineRange: null },
      outcome: outcome({ matchCount: 0 }),
    }),
    { output: "" },
  ),
  tool(
    descriptor("read-file", {
      subject: { label: "packages/session-rpc/src/router.ts", path: "d.ts", lineRange: null },
    }),
    { state: "input-available" },
  ),
];

/**
 * A finished run. Nothing here is active, which is the whole point: a live run
 * shows its rolling tail, and this is what is left once it settles.
 */
const CHECK_RUN: DynamicToolUIPart[] = [
  tool(
    descriptor("run-command", {
      subject: { label: "pnpm run -r typecheck", path: null, lineRange: null },
      outcome: outcome({ exitCode: 0 }),
    }),
    { output: "0 errors" },
  ),
  tool(
    descriptor("run-command", {
      subject: { label: "pnpm run -r test", path: null, lineRange: null },
      outcome: outcome({ exitCode: 0 }),
    }),
    { output: "Test Files  186 passed (186)\nTests  3068 passed (3068)" },
  ),
  tool(
    descriptor("run-command", {
      subject: { label: "vp check", path: null, lineRange: null },
      outcome: outcome({ exitCode: 0 }),
    }),
    { output: "818 files formatted\n786 files linted" },
  ),
];

const SETTLED_RUN: DynamicToolUIPart[] = [
  ...CHECK_RUN,
  tool(
    descriptor("edit-file", {
      subject: {
        label: "src/renderer/lab/chat/activity.ts",
        path: "src/renderer/lab/chat/activity.ts",
        lineRange: null,
      },
      outcome: outcome({ addedLines: 24, removedLines: 3, diff: DIFF }),
    }),
  ),
  tool(
    descriptor("write-file", {
      subject: {
        label: "src/renderer/lab/chat/fold.test.ts",
        path: "src/renderer/lab/chat/fold.test.ts",
        lineRange: null,
      },
      outcome: outcome({ addedLines: 41 }),
    }),
    { input: 'import { expect, it } from "vite-plus/test";\n\nit("folds", () => {});' },
  ),
];

/**
 * The one-off rows, hoisted for the same reason every fixture above already is
 * a module constant: `tool()` mints a fresh `toolCallId` per call, so building
 * these inside the JSX handed each row a *different* call on every render of
 * the gallery. A gallery whose rows cannot hold their own identity cannot show
 * whether a row holds its open disclosure — or whether a memo on one works.
 */
const LONG_OUTPUT_ROW = tool(
  descriptor("run-command", {
    subject: { label: "pnpm run -r test", path: null, lineRange: null },
  }),
  {
    output: Array.from(
      { length: 60 },
      (_, index) => `  ✓ src/renderer/lab/chat/activity.test.ts:${index + 1}  passed`,
    ).join("\n"),
  },
);

const PENDING_ROW = tool(
  descriptor("run-command", {
    subject: { label: "pnpm run -r typecheck", path: null, lineRange: null },
  }),
  { state: "input-streaming" },
);

const EDITING_ROW = tool(
  descriptor("edit-file", {
    subject: { label: "src/renderer/lab/chat/activity.ts", path: "x.ts", lineRange: null },
  }),
  { state: "input-available" },
);

const FAILED_RUN_ROW = tool(
  descriptor("run-command", {
    subject: { label: "pnpm run -r test", path: null, lineRange: null },
    outcome: outcome({ exitCode: 1 }),
  }),
  { output: "1 failed | 183 passed" },
);

/** Two of them, because the gallery draws the gated row in two sections. */
const gatedRow = () =>
  tool(
    descriptor("run-command", {
      subject: { label: "rm -rf node_modules", path: null, lineRange: null },
    }),
    { state: "approval-requested" },
  );
const GATED_ROW = gatedRow();
const GATED_CARD_ROW = gatedRow();

const LIVE_TEST_ROW = tool(
  descriptor("run-command", { subject: { label: "vp run -r test", path: null, lineRange: null } }),
  { state: "input-available" },
);

const MISSING_FILE_ROW = tool(
  descriptor("read-file", {
    subject: { label: "packages/gone.ts", path: "packages/gone.ts", lineRange: null },
  }),
  { state: "output-error" },
);

const ALLOWED_ROW = tool(
  descriptor("run-command", {
    subject: { label: "rm -rf node_modules", path: null, lineRange: null },
  }),
  { state: "output-available" },
);

const DENIED_ROW = tool(
  descriptor("run-command", {
    subject: { label: "git push --force", path: null, lineRange: null },
  }),
  { state: "output-denied" },
);

function toolRows(parts: readonly DynamicToolUIPart[], prefix: string): BundleRow[] {
  return parts.map((part, index) => ({ kind: "tool", key: `${prefix}-${index}`, part }));
}

const SETTLED_BUNDLE: BundleRow[] = [
  {
    kind: "reasoning",
    key: "r1",
    streaming: false,
    part: reasoning("**Checking the reducer**\n\nThe queue drains one message at a time."),
  },
  ...toolRows(SETTLED_RUN, "b1"),
];

const THOUGHT_BUNDLE: BundleRow[] = [
  {
    kind: "reasoning",
    key: "r2",
    streaming: false,
    part: reasoning("Plain thinking, no bold line."),
  },
];

const LIVE_THOUGHT_BUNDLE: BundleRow[] = [
  {
    kind: "reasoning",
    key: "r3",
    streaming: true,
    part: reasoning("**Tracing the seam**", "streaming"),
  },
];

const LIVE_BUNDLE: BundleRow[] = [
  ...toolRows(EXPLORE_RUN.slice(0, 3), "b4"),
  { kind: "tool", key: "b4-live", part: LIVE_TEST_ROW },
];

const FAILED_BUNDLE: BundleRow[] = [
  ...toolRows(EXPLORE_RUN.slice(0, 2), "b5"),
  { kind: "tool", key: "b5-fail", part: MISSING_FILE_ROW },
];

const TALL_BUNDLE: BundleRow[] = toolRows([...CHECK_RUN, ...EXPLORE_RUN, ...SETTLED_RUN], "b6");

/**
 * A permission: one prompt, three declared options, correlated to a call. The
 * card draws every option the harness stated rather than three buttons of its
 * own, so `always` — a standing grant — is here and reads secondary.
 */
const PERMISSION: SessionInteraction = {
  id: "permission:perm-1",
  attachmentId: "attach-1",
  kind: "permission",
  title: "Run a command outside the worktree",
  detail: "rm -rf node_modules",
  options: [
    { id: "once", label: "Allow once", description: null },
    { id: "always", label: "Allow always", description: null },
    { id: "reject", label: "Reject", description: null },
  ],
  multiple: false,
  prompts: [
    {
      id: "prompt:0",
      label: "Run a command outside the worktree",
      detail: "rm -rf node_modules",
      options: [
        { id: "once", label: "Allow once", description: null },
        { id: "always", label: "Allow always", description: null },
        { id: "reject", label: "Reject", description: null },
      ],
      multiple: false,
      custom: false,
    },
  ],
  native: { id: "perm-1", detail: null },
};

/**
 * A question: two prompts with their own answer rules, and no tool call to hang
 * either on. The second declares `multiple` and `custom`, so it takes
 * checkboxes and a free-text answer of its own.
 */
const QUESTION: SessionInteraction = {
  id: "question:q-1",
  attachmentId: "attach-1",
  kind: "question",
  title: "Before I start the migration",
  detail: null,
  options: [
    { id: "question:0:bWFpbg", label: "main", description: null },
    { id: "question:0:cmVsZWFzZQ", label: "release", description: null },
    { id: "question:1:dGVzdHM", label: "tests", description: "run the suite after each step" },
    { id: "question:1:bG9ja2ZpbGU", label: "lockfile", description: null },
  ],
  multiple: true,
  prompts: [
    {
      id: "prompt:0",
      label: "Which branch should this land on?",
      detail: null,
      options: [
        { id: "question:0:bWFpbg", label: "main", description: null },
        { id: "question:0:cmVsZWFzZQ", label: "release", description: null },
      ],
      multiple: false,
      custom: false,
    },
    {
      id: "prompt:1",
      label: "What should I update along the way?",
      detail: null,
      options: [
        { id: "question:1:dGVzdHM", label: "tests", description: "run the suite after each step" },
        { id: "question:1:bG9ja2ZpbGU", label: "lockfile", description: null },
      ],
      multiple: true,
      custom: true,
    },
  ],
  native: { id: "q-1", detail: null },
};

const MODELS: ComposerModel[] = [
  {
    id: "anthropic/claude-sonnet-4-5",
    label: "sonnet-4.5",
    state: "available",
    providerId: "anthropic",
    providerLabel: "Anthropic",
    modelId: "claude-sonnet-4-5",
    reasoningLevels: ["low", "medium", "high"],
  },
  {
    id: "anthropic/claude-opus-4-1",
    label: "opus-4.1",
    state: "available",
    providerId: "anthropic",
    providerLabel: "Anthropic",
    modelId: "claude-opus-4-1",
    reasoningLevels: ["medium", "high"],
  },
  {
    id: "openai/gpt-5-codex",
    label: "gpt-5-codex",
    state: "available",
    providerId: "openai",
    providerLabel: "OpenAI",
    modelId: "gpt-5-codex",
    reasoningLevels: [],
  },
  {
    id: "openai/o4-mini",
    label: "o4-mini",
    state: "unavailable",
    providerId: "openai",
    providerLabel: "OpenAI",
    modelId: "o4-mini",
    reasoningLevels: [],
  },
];

/* -------------------------------------------------------------------- shell */

export default function ChatActivityScratch() {
  return (
    <ContentColumn className="flex flex-col gap-10 py-8">
      <Section label="Rows · settled">
        {ACTIVITY_KINDS.map((kind) => (
          <ToolRow key={kind} part={KIND_ROWS[kind]} onOpenFile={() => undefined} />
        ))}
      </Section>

      {/* The only fixture long enough to reach the detail frame's height cap.
          Everything else here fits well inside it, so without this row the
          gallery cannot show — or regress — the clipped state and its fade. */}
      <Section label="Row · output past the height cap">
        <ToolRow part={LONG_OUTPUT_ROW} onOpenFile={() => undefined} />
      </Section>

      <Section label="Rows · in flight">
        <ToolRow part={PENDING_ROW} />
        <ToolRow part={EDITING_ROW} />
        <ToolRow part={GATED_ROW} />
        <ToolRow part={FAILED_RUN_ROW} />
      </Section>

      <Section label="Bundle · everything between two things the agent said">
        <ActivityBundle rows={SETTLED_BUNDLE} />
      </Section>

      <Section label="Bundle · reasoning alone is its own summary">
        <ActivityBundle rows={THOUGHT_BUNDLE} />
      </Section>

      <Section label="Bundle · thinking still being written">
        <ActivityBundle rows={LIVE_THOUGHT_BUNDLE} />
      </Section>

      <Section label="Bundle · live, the one row carries the whole report">
        <ActivityBundle rows={LIVE_BUNDLE} />
      </Section>

      <Section label="Bundle · a failure opens it without being asked">
        <ActivityBundle rows={FAILED_BUNDLE} />
      </Section>

      <Section label="Bundle · past the height cap, it scrolls inside itself">
        <ActivityBundle rows={TALL_BUNDLE} />
      </Section>

      {/* A gated call leaves the bundle — it blocks the reader and it needs
          controls, so it must not sit behind a disclosure — and it takes its
          decision with it. Row above, card under it, at one left edge. */}
      <Section label="Interaction · on the row, where the call was gated">
        <ToolRow part={GATED_CARD_ROW} />
        <InteractionCard interaction={PERMISSION} onResolve={() => undefined} />
      </Section>

      <Section label="Interaction · at the foot, with no call to hang it on">
        <InteractionCard
          interaction={QUESTION}
          onResolve={() => undefined}
          onStop={() => undefined}
        />
      </Section>

      <Section label="Interaction · receipts">
        <InteractionReceiptLine
          interaction={PERMISSION}
          resolution={{ optionIds: ["once"], response: null }}
        />
        <InteractionReceiptLine
          interaction={PERMISSION}
          resolution={{ optionIds: ["always"], response: null }}
        />
        <InteractionReceiptLine
          interaction={PERMISSION}
          resolution={{ optionIds: ["reject"], response: "read the lockfile instead" }}
        />
        <InteractionReceiptLine
          interaction={QUESTION}
          resolution={{ optionIds: ["question:0:bWFpbg"], response: null }}
        />
        {/* The out-of-band refusal: nothing selected, nothing said. */}
        <InteractionReceiptLine
          interaction={QUESTION}
          resolution={{ optionIds: [], response: null }}
        />
        <AttentionReceipt part={ALLOWED_ROW} />
        <AttentionReceipt part={DENIED_ROW} />
      </Section>

      <ComposerStates />
    </ContentColumn>
  );
}

function Section({ label, children }: React.PropsWithChildren<{ label: string }>) {
  return (
    <section className="flex flex-col gap-1">
      <h2 className="mb-1 text-label uppercase text-muted-foreground">{label}</h2>
      {children}
    </section>
  );
}

/* ----------------------------------------------------------------- composer */

const COMPOSER_STATES = ["idle", "working", "queued", "approval"] as const;
type ComposerStateName = (typeof COMPOSER_STATES)[number];

/**
 * The composer is fully controlled, so its four states are four prop sets
 * rather than four sessions. Each one is live: type into it, open the model
 * pill, press ⌫ on an empty box to take the queued message back.
 */
function ComposerStates() {
  const [state, setState] = React.useState<ComposerStateName>("idle");
  const [value, setValue] = React.useState("");
  const [selection, setSelection] = React.useState<ComposerModelSelection>({
    providerId: "anthropic",
    modelId: "claude-sonnet-4-5",
    reasoningLevel: "high",
  });
  const [queued, setQueued] = React.useState<readonly QueuedMessage[]>([
    { id: "q1", text: "also add a test for the empty-name branch" },
  ]);

  const working = state !== "idle";

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-1">
        <h2 className="mr-2 text-label uppercase text-muted-foreground">Composer</h2>
        {COMPOSER_STATES.map((name) => (
          <Button
            key={name}
            size="xs"
            variant={state === name ? "secondary" : "ghost"}
            className="capitalize"
            onClick={() => setState(name)}
          >
            {name}
          </Button>
        ))}
      </div>

      {/* The card replaces the composer rather than sitting above it: while an
          interaction is pending the turn cannot proceed, so there is nothing to
          type. Both are drawn here so the swap is reviewable. */}
      {state === "approval" ? (
        <InteractionCard interaction={PERMISSION} onResolve={() => undefined} />
      ) : null}

      <SessionComposer
        value={value}
        onValueChange={setValue}
        models={MODELS}
        selection={selection}
        onSelectionChange={setSelection}
        working={working}
        ready
        // Whatever is actually in the queue, in every state that can hold one.
        // Gating this on the two toggles that *start* with a queued message made
        // the fixture lie about its own behavior: queueing from Working cleared
        // the draft and showed nothing, which is the one bug this gallery exists
        // to catch. Idle is the only state with no queue, because there is no
        // turn to queue behind.
        queued={state === "idle" ? [] : queued}
        onQueuedChange={setQueued}
        onSubmit={(text, intent) => {
          setValue("");
          if (intent !== "queue") return;
          setQueued((current) => enqueueMessage(current, { id: `q-${Date.now()}`, text }));
        }}
        onStop={() => setState("idle")}
      />
    </section>
  );
}
