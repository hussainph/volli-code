/**
 * The Session states the lab can put on screen on purpose.
 *
 * Every one of these is a state a live OpenCode server raises only when it
 * happens to: a permission with no tool call, a question with three prompts, a
 * rate limit that came without a `Retry-After`. Waiting for a provider to be in
 * the right mood is not a way to review a surface, and a fixture handed straight
 * to a React component proves nothing about the thing that actually broke —
 * every bug the interaction card fixed was a bug in what *reached* the renderer.
 *
 * So a scenario is a script in the harness's own observation vocabulary. The lab
 * backend hosts it as an ordinary `NativeHarnessAdapter`, the Session runtime
 * commits each beat as a durable event, and the renderer sees it through the
 * same projection, the same tRPC edge and the same subscription a real harness
 * arrives on. Nothing here is a shortcut around any of that.
 *
 * Shared by both halves of the lab — main plays the beats, the renderer's picker
 * lists the labels — which is why it sits beside `lab-session-rpc-path.ts`
 * rather than inside either tree. Dev-server only: no app code imports it.
 *
 * A beat is a `HarnessObservation` minus the envelope the adapter stamps, so a
 * state that cannot be written here is a state a harness cannot report either.
 */
import type { HarnessObservation } from "@volli/session-engine";
import type {
  ActivityDescriptor,
  SessionInteraction,
  SessionInteractionOption,
} from "@volli/shared";
import { ACTIVITY_METADATA_KEY } from "@volli/shared";
import type { DynamicToolUIPart, UIMessage } from "ai";

/** The adapter id the lab registers its scripted harness under. */
export const LAB_SCENARIO_ADAPTER_ID = "lab-scenario";

/** Distributes over the union; a plain `Omit` would collapse it to its base. */
type Unstamped<T> = T extends unknown ? Omit<T, "id" | "occurredAt"> : never;

/** One scripted fact, stamped with a stable id and a clock by the adapter. */
export type LabScenarioBeat = Unstamped<HarnessObservation>;

export interface LabScenarioContext {
  /** One reading of the clock for the whole script, so relative times agree. */
  readonly now: number;
}

export interface LabScenarioResolveContext extends LabScenarioContext {
  readonly interactionId: string;
  /** What the reader chose. A scenario may settle its gated row from it. */
  readonly optionIds: readonly string[];
}

export interface LabScenario {
  /** Also the harness profile the renderer attaches to. */
  readonly id: string;
  /** The picker's own words. */
  readonly label: string;
  readonly beats: (context: LabScenarioContext) => readonly LabScenarioBeat[];
  /**
   * Played after the durable `interaction.resolved` the adapter always emits.
   * A scenario whose question gated a tool call uses it to settle that row.
   */
  readonly afterResolve?: (context: LabScenarioResolveContext) => readonly LabScenarioBeat[];
}

/* ------------------------------------------------------------------ pieces */

const THREAD = {
  threadId: "thread:lab:root",
  branchId: "branch:lab:main",
  attemptId: "attempt:lab:1",
} as const;

/** One turn per script, and the id an interrupt ends. */
export const LAB_SCENARIO_TURN_ID = "turn:lab:1";

const TURN_ID = LAB_SCENARIO_TURN_ID;

function turnStarted(): LabScenarioBeat {
  return { kind: "turn.started", turnId: TURN_ID };
}

function turnCompleted(): LabScenarioBeat {
  return { kind: "turn.completed", turnId: TURN_ID };
}

function assistant(id: string, parts: UIMessage["parts"]): LabScenarioBeat {
  return {
    kind: "transcript.message",
    ...THREAD,
    turnId: TURN_ID,
    message: { id, role: "assistant", parts },
  };
}

function say(id: string, text: string): LabScenarioBeat {
  return assistant(id, [{ type: "text", text }]);
}

/** The SDK types `toolMetadata` as `JSONObject`; a descriptor is one structurally. */
function activity(
  kind: ActivityDescriptor["kind"],
  nativeToolName: string,
  label: string,
): DynamicToolUIPart["toolMetadata"] {
  const descriptor: ActivityDescriptor = {
    kind,
    nativeToolName,
    subject: { label, path: null, lineRange: null },
    outcome: null,
    startedAt: null,
    endedAt: null,
  };
  return { [ACTIVITY_METADATA_KEY]: descriptor } as DynamicToolUIPart["toolMetadata"];
}

const GATED_CALL_ID = "call-rm";
const GATED_COMMAND = "rm -rf node_modules";

/**
 * The call a permission is correlated to, still waiting on the reader.
 *
 * `approval.id` is the *permission's own native id*, not an id of the call's —
 * that is how OpenCode reports it and how the adapter stamps it, and it is the
 * only thing pairing a gated row with the question that gates it. A fixture
 * that made one up would draw the card at the foot of the transcript and leave
 * the row waiting on a decision it could not name.
 */
function gatedCall(permissionId: string): DynamicToolUIPart {
  return {
    type: "dynamic-tool",
    toolName: "bash",
    toolCallId: GATED_CALL_ID,
    toolMetadata: activity("run-command", "bash", GATED_COMMAND),
    state: "approval-requested",
    input: { command: GATED_COMMAND },
    approval: { id: permissionId },
  };
}

/**
 * The same call once the reader has answered — a *newer snapshot of the same
 * message*, which is how a native adapter reports a settled row and what the
 * transcript projection is built to fold together.
 */
function settledCall(permissionId: string, approved: boolean): DynamicToolUIPart {
  const base = {
    type: "dynamic-tool" as const,
    toolName: "bash",
    toolCallId: GATED_CALL_ID,
    toolMetadata: activity("run-command", "bash", GATED_COMMAND),
    input: { command: GATED_COMMAND },
  };
  return approved
    ? { ...base, state: "output-available", output: "removed 1284 directories" }
    : { ...base, state: "output-denied", approval: { id: permissionId, approved: false } };
}

/** A plan the rail shows and the composer's dock would show — until a card takes the slot. */
function plan(id: string): LabScenarioBeat {
  return assistant(id, [
    {
      type: "dynamic-tool",
      toolName: "todowrite",
      toolCallId: "call-plan",
      toolMetadata: activity("plan", "todowrite", "3 steps"),
      state: "output-available",
      input: {
        todos: [
          { id: "t1", content: "Read the failing test", status: "completed", priority: "high" },
          {
            id: "t2",
            content: "Reinstall the dependency tree",
            status: "in_progress",
            priority: "high",
          },
          { id: "t3", content: "Run the suite", status: "pending", priority: "medium" },
        ],
      },
      output: "ok",
    },
  ]);
}

/** The three ids a permission offers. They are ours, exactly as the adapter mints them. */
const PERMISSION_OPTIONS: readonly SessionInteractionOption[] = [
  { id: "once", label: "Allow once", description: null },
  { id: "always", label: "Allow always", description: null },
  { id: "reject", label: "Reject", description: null },
];

function permission(
  nativeId: string,
  title: string,
  detail: string | null,
): Omit<SessionInteraction, "attachmentId"> {
  return {
    id: `permission:${nativeId}`,
    kind: "permission",
    title,
    detail,
    options: PERMISSION_OPTIONS,
    multiple: false,
    prompts: [
      {
        id: "prompt:0",
        label: title,
        detail,
        options: PERMISSION_OPTIONS,
        multiple: false,
        custom: false,
      },
    ],
    native: { id: nativeId, detail: null },
  };
}

function opened(interaction: Omit<SessionInteraction, "attachmentId">): LabScenarioBeat {
  return { kind: "interaction.opened", interaction };
}

/**
 * A question's option ids are `question:<index>:<base64url(value)>` — the
 * adapter's own encoding, written out rather than computed so a fixture reads
 * as the record it stands in for.
 */
const QUESTION_OPTION_IDS = {
  main: "question:0:bWFpbg",
  release: "question:0:cmVsZWFzZQ",
  tests: "question:1:dGVzdHM",
  lockfile: "question:1:bG9ja2ZpbGU",
  docs: "question:1:ZG9jcw",
  note: "question:2:bm90ZQ",
  reject: "question:0:cmVqZWN0",
  accept: "question:0:YWNjZXB0",
} as const;

/* --------------------------------------------------------------- scenarios */

export const LAB_SCENARIOS: readonly LabScenario[] = [
  {
    id: "permission-tool",
    label: "Permission · tool call",
    beats: () => [
      turnStarted(),
      plan("lab-plan"),
      assistant("lab-msg-1", [
        { type: "text", text: "The tree is stale, so I want to clear it before reinstalling." },
        gatedCall("perm-1"),
      ]),
      // Correlated, so the card draws on the row — the composer and the plan
      // dock stay where they are, because the card is not in their slot.
      opened(permission("perm-1", "Run a command outside the worktree", GATED_COMMAND)),
    ],
    // The gate lifts on the row it gated, which only a newer snapshot of the
    // same message can say. Rejecting settles it too: a refused call is a fact
    // about the call, not an absence of one.
    afterResolve: (context) => [
      assistant("lab-msg-1", [
        { type: "text", text: "The tree is stale, so I want to clear it before reinstalling." },
        settledCall(
          "perm-1",
          context.optionIds.some((id) => id === "once" || id === "always"),
        ),
      ]),
      turnCompleted(),
    ],
  },
  {
    id: "permission-toolless",
    label: "Permission · no tool call",
    beats: () => [
      turnStarted(),
      say("lab-msg-1", "The reference the task points at lives outside this project."),
      // No call, no row, nothing to correlate to — the shape a `doom_loop` or
      // `external_directory` permission arrives in. `PermissionRequest.tool` is
      // optional and these carry none.
      opened(
        permission("perm-2", "Work outside the project directory", "/tmp/volli-lab-reference"),
      ),
    ],
  },
  {
    id: "question-single",
    label: "Question · one prompt",
    beats: () => [
      turnStarted(),
      say("lab-msg-1", "Before I start the migration."),
      opened({
        id: "question:q-1",
        kind: "question",
        title: "Which branch should this land on?",
        detail: null,
        options: [
          { id: QUESTION_OPTION_IDS.main, label: "main", description: null },
          { id: QUESTION_OPTION_IDS.release, label: "release", description: null },
        ],
        multiple: true,
        prompts: [
          {
            id: "prompt:0",
            label: "Which branch should this land on?",
            detail: null,
            options: [
              { id: QUESTION_OPTION_IDS.main, label: "main", description: null },
              { id: QUESTION_OPTION_IDS.release, label: "release", description: null },
            ],
            multiple: false,
            custom: false,
          },
        ],
        native: { id: "q-1", detail: null },
      }),
    ],
  },
  {
    id: "question-multi",
    label: "Question · several prompts",
    beats: () => [
      turnStarted(),
      say("lab-msg-1", "A few things to settle before I touch the lockfile."),
      // Three questions in one request, each with its own answer rules — the
      // case the flat `options`/`multiple` pair could not express at all.
      opened({
        id: "question:q-2",
        kind: "question",
        title: "Before I start the migration",
        detail: null,
        options: [
          { id: QUESTION_OPTION_IDS.main, label: "Which branch: main", description: null },
          { id: QUESTION_OPTION_IDS.release, label: "Which branch: release", description: null },
          { id: QUESTION_OPTION_IDS.tests, label: "What to update: tests", description: null },
          {
            id: QUESTION_OPTION_IDS.lockfile,
            label: "What to update: lockfile",
            description: null,
          },
          { id: QUESTION_OPTION_IDS.docs, label: "What to update: docs", description: null },
          { id: QUESTION_OPTION_IDS.note, label: "Anything else: no", description: null },
        ],
        multiple: true,
        prompts: [
          {
            id: "prompt:0",
            label: "Which branch should this land on?",
            detail: null,
            options: [
              { id: QUESTION_OPTION_IDS.main, label: "main", description: null },
              { id: QUESTION_OPTION_IDS.release, label: "release", description: null },
            ],
            multiple: false,
            custom: false,
          },
          {
            id: "prompt:1",
            label: "What should I update along the way?",
            detail: "Pick as many as apply",
            options: [
              {
                id: QUESTION_OPTION_IDS.tests,
                label: "tests",
                description: "run the suite after each step",
              },
              { id: QUESTION_OPTION_IDS.lockfile, label: "lockfile", description: null },
              { id: QUESTION_OPTION_IDS.docs, label: "docs", description: null },
            ],
            multiple: true,
            custom: false,
          },
          {
            id: "prompt:2",
            label: "Anything else I should know?",
            detail: null,
            options: [{ id: QUESTION_OPTION_IDS.note, label: "no", description: null }],
            multiple: false,
            custom: true,
          },
        ],
        native: { id: "q-2", detail: null },
      }),
    ],
  },
  {
    id: "question-reject-option",
    label: "Question · a reject answer",
    beats: () => [
      turnStarted(),
      say("lab-msg-1", "The branch has a clean merge."),
      // `reject` is one of the harness's own values here, so its id is the
      // encoded one and its polarity is `answer`. Choosing it answers the
      // question; the card's own Reject control is what refuses it.
      opened({
        id: "question:q-3",
        kind: "question",
        title: "Merge?",
        detail: null,
        options: [
          { id: QUESTION_OPTION_IDS.reject, label: "reject", description: null },
          { id: QUESTION_OPTION_IDS.accept, label: "accept", description: null },
        ],
        multiple: true,
        prompts: [
          {
            id: "prompt:0",
            label: "Merge?",
            detail: null,
            options: [
              { id: QUESTION_OPTION_IDS.reject, label: "reject", description: null },
              { id: QUESTION_OPTION_IDS.accept, label: "accept", description: null },
            ],
            multiple: false,
            custom: false,
          },
        ],
        native: { id: "q-3", detail: null },
      }),
    ],
  },
  {
    id: "auth-required",
    label: "Sign-in required",
    beats: () => [
      turnStarted(),
      say("lab-msg-1", "Starting on the greeting."),
      {
        kind: "attention.raised",
        attention: {
          id: "lab:auth",
          kind: "auth_required",
          detail: "The Anthropic credential expired",
          diagnostic: null,
        },
      },
      turnCompleted(),
    ],
  },
  {
    id: "rate-limited-until",
    label: "Rate limited · with a time",
    beats: (context) => [
      turnStarted(),
      say("lab-msg-1", "Starting on the greeting."),
      {
        kind: "attention.raised",
        attention: {
          id: "lab:rate",
          kind: "rate_limited",
          detail: "429 from the provider",
          diagnostic: null,
          // The provider stated one, so the row may show it.
          retryAt: context.now + 12 * 60_000,
        },
      },
      turnCompleted(),
    ],
  },
  {
    id: "rate-limited-open",
    label: "Rate limited · no time",
    beats: () => [
      turnStarted(),
      say("lab-msg-1", "Starting on the greeting."),
      {
        kind: "attention.raised",
        attention: {
          id: "lab:rate",
          kind: "rate_limited",
          detail: "429 with no Retry-After",
          diagnostic: null,
          // Absent, and it must stay absent rather than becoming a guess.
          retryAt: null,
        },
      },
      turnCompleted(),
    ],
  },
  {
    id: "context-limit",
    label: "Context limit reached",
    beats: () => [
      turnStarted(),
      say("lab-msg-1", "Reading the whole worktree to find the caller."),
      {
        kind: "attention.raised",
        attention: {
          id: "lab:context",
          kind: "context_limit_reached",
          detail: "This conversation exceeds the model's context window",
          diagnostic: null,
        },
      },
      turnCompleted(),
    ],
  },
  {
    id: "adapter-unrecoverable",
    label: "Session stopped",
    beats: () => [
      turnStarted(),
      say("lab-msg-1", "Starting on the greeting."),
      {
        kind: "attention.raised",
        attention: {
          id: "lab:unrecoverable",
          kind: "adapter_unrecoverable",
          detail: "The OpenCode server exited and cannot be restarted",
          diagnostic: null,
        },
      },
      turnCompleted(),
    ],
  },
  {
    id: "interaction-over-attention",
    label: "Interaction over attention",
    beats: (context) => [
      turnStarted(),
      plan("lab-plan"),
      assistant("lab-msg-1", [
        { type: "text", text: "The tree is stale, so I want to clear it before reinstalling." },
        gatedCall("perm-3"),
      ]),
      // Both live at once, and the interaction wins: the rate-limit row stands
      // down for it. The card draws on the gated row rather than at the foot,
      // so the composer and the plan dock are still there — being asked a
      // question blocks the turn, not the reader's place in the conversation.
      {
        kind: "attention.raised",
        attention: {
          id: "lab:rate",
          kind: "rate_limited",
          detail: "429 from the provider",
          diagnostic: null,
          retryAt: context.now + 12 * 60_000,
        },
      },
      opened(permission("perm-3", "Run a command outside the worktree", GATED_COMMAND)),
    ],
    afterResolve: (context) => [
      assistant("lab-msg-1", [
        { type: "text", text: "The tree is stale, so I want to clear it before reinstalling." },
        settledCall(
          "perm-3",
          context.optionIds.some((id) => id === "once" || id === "always"),
        ),
      ]),
    ],
  },
];

export function labScenario(id: string): LabScenario | null {
  return LAB_SCENARIOS.find((scenario) => scenario.id === id) ?? null;
}
