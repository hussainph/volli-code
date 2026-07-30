/**
 * The Automations vocabulary, as far as the lab needs it — the trigger, the
 * steps, and the adapter dialects the Runtime controls have to render.
 *
 * This is deliberately a LAB model, not a draft of `@volli/shared`. Nothing here
 * is persisted, validated at an IPC boundary, or shaped by SQLite. What it
 * exists to do is give the two automation scratches one shared, honest
 * vocabulary so a design judgement made on the form is being made about the same
 * object the trigger surfaces fire.
 *
 * ── WHY A TRIGGER *KIND*, NOT A COLUMN LIST ───────────────────────────────
 * v1 has exactly one trigger: a ticket entering a column. Modelling that as a
 * bare `columnScope: TicketStatus[]` was the shortest path and it was wrong,
 * because the roadmap is explicitly meta-level — automations that create tickets,
 * that fire when checks go green, that pull from another tracker. Every one of
 * those is a different OPERAND behind the same question, and a field named after
 * v1's operand cannot grow a second one without a migration and a redesign.
 *
 * So the trigger is a discriminated union keyed on {@link TriggerKind}, and
 * {@link TRIGGER_KINDS} carries the ones that are designed-for but not built. The
 * picker renders those as disabled rows: the point of a lab is to find out
 * whether the surface still reads correctly once there are eight kinds in three
 * groups, and it cannot find that out from a list with one entry.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * ── WHY A FLAT LIST, AND WHY THE UI ONLY AUTHORS PARALLEL ─────────────────
 * A step is `{runtime, instructions}` — one session, one harness, one prompt.
 * An Automation is a flat, ordered list of them. The file still spells
 * {@link StepJoin} (`also: true` ↔ `with`), so a hand-edited sequential spine
 * round-trips — but the studio only *authors* parallel launches. Stop hooks
 * mean the agent yielded, not that the work is done; a `then` edge would
 * promise chaining we do not have. Sequencing across launches is a column move
 * (or a schedule), written as a separate automation.
 *
 * It is the third model this went through:
 *
 *   1. `join: "with" | "after"` — silently re-parented siblings.
 *   2. `after: <step id>` — bought a general tree that reads as branching.
 *   3. A flag on a flat list. The UI's only add affordance is "Add alongside".
 *
 * {@link toStages} recovers the grouping for anything that still needs it.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * ── WHY THE PROMPT IS ONLY PROSE ──────────────────────────────────────────
 * The original design gave every Automation a set of `{{context}}` placeholders
 * that Volli resolved before handing the prompt to the agent. Research into the
 * category found that nobody else does this: every shipped agent tool either
 * dumps the whole issue into the prompt implicitly, or appends a plain string.
 * The reason is that it babysteps a model that can fetch what it needs — and
 * doing it well means Volli guessing, at author time, which slice of the ticket
 * matters for a run that has not happened yet.
 *
 * That left placeholders as an opt-in second mode "for the cases where you
 * genuinely need to control ordering", which the two-opinion review seed was
 * written to demonstrate. Rewriting that seed as prose settled it: the prose
 * version is SHORTER and clearer than the one with `{{change_set}}` and
 * `{{brief}}` in it, because the ordering it was fighting to control was never
 * load-bearing. A mode whose only witness argues against it is a mode.
 *
 * So there is one way to write a prompt: prose, appended with
 * {@link APPENDED_CLI_NOTE}, which tells the agent it has the `volli` CLI and
 * which ticket it is on. The agent pulls what it wants. `{{braces}}` are still
 * RECOGNISED — and always painted as a mistake, because they will be sent
 * literally and someone will type them out of habit.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * The one thing this models with real care is the part the UI cannot fake: an
 * adapter's Runtime is its OWN dialect. Every flag below was read off the real
 * binary's `--help` (Claude Code 2.1.220, Codex 0.144.6, cursor-agent 2026.07.23,
 * opencode 1.17.18) or off pi's published docs, in July 2026. Two asymmetries
 * survive that check and both are load-bearing for this design:
 *
 *   • **cursor-agent has no effort flag.** Effort rides inside the model string
 *     as a bracket parameter — `claude-opus-4-8[context=1m,effort=high]` — so
 *     there is no second control to bind a dial to, and the correct render is
 *     nothing at all rather than a disabled slider.
 *   • **pi has no approval or sandbox mode.** `--approve` governs whether it
 *     trusts project-local config files, which is a different question; nothing
 *     in its docs gates tool use. So its Approvals control is absent, not empty.
 *
 * A form that showed the same three dials for all five would be asserting an
 * equivalence that does not exist, and would make the surface look easier than
 * it is.
 */
import { TICKET_STATUS_LABELS, type TicketStatus } from "@volli/shared";

/* --------------------------------------------------------------- harnesses */

/**
 * The harnesses the lab renders. Deliberately a LAB list rather than
 * `@volli/shared`'s `HARNESS_IDS`: the shipped adapter layer is being reworked
 * on its own branch, and a design scratch has no business widening a vocabulary
 * that main-process code and SQLite both read.
 */
export const LAB_HARNESS_IDS = ["claude-code", "codex", "cursor", "opencode", "pi"] as const;

export type LabHarnessId = (typeof LAB_HARNESS_IDS)[number];

/**
 * One stop on an adapter's own scale. `arg` is the literal CLI fragment, which
 * is what makes {@link composeCommand} possible without a per-harness `switch`:
 * the same picked value is spelled `--effort high` by Claude Code, `--variant
 * high` by opencode and `-c model_reasoning_effort=high` by Codex, and the only
 * place that difference should live is here.
 */
export interface RuntimeOption {
  value: string;
  arg: string;
}

/** A one-of-many runtime dial. `null` on an adapter means the dial does not exist. */
export interface RuntimeAxis {
  label: string;
  options: RuntimeOption[];
}

export interface HarnessAdapterUi {
  label: string;
  /** The invocation with `%p` where the Instructions go. */
  invocation: string;
  /** The model flag with `%s` where the slug goes. */
  modelArg: string;
  /** Suggestions for the model combobox. Typing something absent is always allowed. */
  models: string[];
  /** Ordered weakest → strongest, or `null` when the harness exposes no dial. */
  effort: RuntimeAxis | null;
  /** Unordered — a choice, not a scale. `null` when the harness gates nothing. */
  approvals: RuntimeAxis | null;
}

export const HARNESS_ADAPTERS: Record<LabHarnessId, HarnessAdapterUi> = {
  "claude-code": {
    label: "Claude Code",
    invocation: "claude %p",
    modelArg: "--model %s",
    models: ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"],
    effort: {
      label: "Effort",
      options: ["low", "medium", "high", "xhigh", "max"].map((value) => ({
        value,
        arg: `--effort ${value}`,
      })),
    },
    approvals: {
      label: "Approvals",
      options: ["manual", "acceptEdits", "plan", "auto", "bypassPermissions"].map((value) => ({
        value,
        arg: `--permission-mode ${value}`,
      })),
    },
  },
  codex: {
    label: "Codex",
    invocation: "codex exec %p",
    modelArg: "-m %s",
    models: ["gpt-5.1-codex", "gpt-5.1-codex-mini"],
    effort: {
      label: "Effort",
      // No flag of its own — Codex takes reasoning effort as a config override,
      // which is exactly the kind of dialect difference the ribbon exists to show.
      options: ["low", "medium", "high", "xhigh"].map((value) => ({
        value,
        arg: `-c model_reasoning_effort=${value}`,
      })),
    },
    approvals: {
      label: "Approvals",
      options: [
        { value: "read-only", arg: "-s read-only" },
        { value: "workspace-write", arg: "-s workspace-write" },
        { value: "on-request", arg: "-a on-request" },
        { value: "never", arg: "-a never" },
      ],
    },
  },
  cursor: {
    label: "Cursor",
    invocation: "cursor-agent %p",
    modelArg: "--model %s",
    // The bracket suffix is the effort dial. It is offered as a model
    // suggestion rather than a separate control because that is where it lives.
    models: ["sonnet-4-thinking", "gpt-5", "claude-opus-4-8[effort=high]"],
    effort: null,
    approvals: {
      label: "Approvals",
      options: [
        { value: "sandbox", arg: "--sandbox enabled" },
        { value: "auto-review", arg: "--auto-review" },
        { value: "force", arg: "--force" },
      ],
    },
  },
  opencode: {
    label: "Opencode",
    invocation: "opencode run %p",
    modelArg: "-m %s",
    models: ["anthropic/claude-opus-5", "openai/gpt-5.1", "google/gemini-3-pro"],
    effort: {
      label: "Effort",
      options: ["minimal", "high", "max"].map((value) => ({
        value,
        arg: `--variant ${value}`,
      })),
    },
    approvals: {
      label: "Approvals",
      // Boolean on the CLI; the "ask" stop is the absence of the flag, which is
      // why its `arg` is empty rather than invented.
      options: [
        { value: "ask", arg: "" },
        { value: "auto", arg: "--auto" },
      ],
    },
  },
  pi: {
    label: "Pi",
    invocation: "pi %p",
    modelArg: "--model %s",
    models: ["anthropic/claude-opus-5", "openai/gpt-5.1", "google/gemini-3-pro"],
    effort: {
      label: "Thinking",
      options: ["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((value) => ({
        value,
        arg: `--thinking ${value}`,
      })),
    },
    approvals: null,
  },
};

export interface AutomationRuntime {
  /** Pinned per step — Instructions are written in one harness's dialect. */
  harnessId: LabHarnessId;
  /** Free text with suggestions, never a closed enum: model names churn faster than releases. */
  model: string;
  /** A stop on the adapter's own scale, or `null` when it has no dial. */
  effort: string | null;
  /** A stop on the adapter's own approval vocabulary, or `null` when it gates nothing. */
  approvals: string | null;
}

/** The runtime an adapter starts from when it is first selected. */
export function defaultRuntime(harnessId: LabHarnessId): AutomationRuntime {
  const adapter = HARNESS_ADAPTERS[harnessId];
  return {
    harnessId,
    model: adapter.models[0],
    effort: adapter.effort?.options[0].value ?? null,
    approvals: adapter.approvals?.options[0].value ?? null,
  };
}

/** One `flag value` pair of the composed command, kept split so the flag can be dimmed. */
export interface CommandPart {
  /** `claude`, `--model`, `-c model_reasoning_effort=high` … */
  flag: string;
  /** The chosen value, when the fragment has one worth emphasising. */
  value?: string;
}

/**
 * The command this runtime actually produces, as parts.
 *
 * This is the form's answer to "what does this dial do" — a sentence explaining
 * `--effort` would be prose the reader has to trust, where the flag itself is
 * the thing they already know how to read. It is also the only honest way to
 * show five dialects at once: nothing here normalises, it just concatenates what
 * each adapter declared.
 */
export function composeCommand(runtime: AutomationRuntime): CommandPart[] {
  const adapter = HARNESS_ADAPTERS[runtime.harnessId];
  const [bin, ...rest] = adapter.invocation.split(" ");
  const parts: CommandPart[] = [{ flag: [bin, ...rest.filter((word) => word !== "%p")].join(" ") }];

  const [modelFlag] = adapter.modelArg.split(" ");
  parts.push({ flag: modelFlag, value: runtime.model });

  const effortArg = adapter.effort?.options.find((option) => option.value === runtime.effort)?.arg;
  if (effortArg !== undefined) parts.push(splitArg(effortArg));

  const approvalArg = adapter.approvals?.options.find(
    (option) => option.value === runtime.approvals,
  )?.arg;
  if (approvalArg !== undefined && approvalArg !== "") parts.push(splitArg(approvalArg));

  return parts;
}

/** `--effort high` → flag + value; `--force` and `-c a=b` stay whole. */
function splitArg(arg: string): CommandPart {
  const at = arg.indexOf(" ");
  if (at === -1) return { flag: arg };
  return { flag: arg.slice(0, at), value: arg.slice(at + 1) };
}

/* ----------------------------------------------------------------- triggers */

export type TriggerKind =
  | "enters-column"
  | "leaves-column"
  | "manual"
  | "label-added"
  | "checks-pass"
  | "session-ends"
  | "schedule"
  | "inbound";

export interface TriggerKindUi {
  label: string;
  group: "Board" | "Session" | "Outside Volli";
  /** false = designed for, not built. The picker shows it and will not select it. */
  available: boolean;
}

/**
 * Every trigger the surface is designed to hold, including the ones v1 does not
 * fire. The unavailable rows are not a roadmap tease — they are the load test.
 * A picker that reads well with one entry and badly with eight is a picker that
 * has to be rebuilt the first time a trigger is added, and the whole reason the
 * kind is a union is to make sure that does not happen.
 */
export const TRIGGER_KINDS: Record<TriggerKind, TriggerKindUi> = {
  "enters-column": { label: "Ticket enters", group: "Board", available: true },
  "leaves-column": { label: "Ticket leaves", group: "Board", available: true },
  manual: { label: "Run by hand", group: "Board", available: true },
  "label-added": { label: "Label added", group: "Board", available: false },
  "checks-pass": { label: "Checks pass", group: "Session", available: false },
  "session-ends": { label: "Session ends", group: "Session", available: false },
  // Off-board: fires without a ticket move (cron / intake). Operand UI is still
  // thin — the kind itself is what parks the automation in the Off board lane.
  schedule: { label: "Schedule", group: "Outside Volli", available: true },
  inbound: { label: "Inbound event", group: "Outside Volli", available: false },
};

export const TRIGGER_GROUPS: Array<TriggerKindUi["group"]> = ["Board", "Session", "Outside Volli"];

export type Trigger =
  | { kind: "enters-column"; columns: TicketStatus[] }
  | { kind: "leaves-column"; columns: TicketStatus[] }
  | { kind: "manual" }
  | { kind: "schedule" };

/** An empty operand for a kind, used when the picker switches kinds. */
export function blankTrigger(kind: TriggerKind): Trigger {
  if (kind === "leaves-column") return { kind, columns: [] };
  if (kind === "manual" || kind === "schedule") return { kind };
  return { kind: "enters-column", columns: [] };
}

/** True when the automation is not driven by a board move (Off board lane). */
export function isOffBoardTrigger(
  trigger: Trigger,
): trigger is Extract<Trigger, { kind: "manual" | "schedule" }> {
  return trigger.kind === "manual" || trigger.kind === "schedule";
}

/** The columns a trigger names, or `"any"` when it names none / is off-board. */
export function triggerColumns(trigger: Trigger): "any" | TicketStatus[] {
  if (isOffBoardTrigger(trigger)) return "any";
  return trigger.columns;
}

/** One phrase for a trigger — used in the index and on the dragged card. */
export function triggerSummary(trigger: Trigger): string {
  if (trigger.kind === "manual") return "Run by hand";
  if (trigger.kind === "schedule") return "On a schedule";
  const verb = TRIGGER_KINDS[trigger.kind].label;
  if (trigger.columns.length === 0) return `${verb} any column`;
  if (trigger.columns.length === 1) return `${verb} ${TICKET_STATUS_LABELS[trigger.columns[0]]}`;
  return `${verb} ${trigger.columns.length} columns`;
}

/* -------------------------------------------------------------- automations */

/** Global automations appear in every project; project ones only in theirs. */
export type AutomationScope = "global" | "project";

/**
 * When a step starts, relative to the one above it.
 *
 * The file still spells both (`also: true` ↔ `with`, omitted ↔ `then`) so a
 * hand-edited sequential spine round-trips. The studio UI only *authors*
 * `with`: Volli cannot tell "the work is done" from a harness Stop hook, so a
 * `then` edge would promise chaining we do not have. Sequencing across launches
 * is a column move (or a schedule), authored as separate automations.
 */
export type StepJoin = "then" | "with";

export interface AutomationStep {
  /**
   * Unique within the automation, and user-facing: it is the `## heading` this
   * step's prose lives under in the file. Not a pointer — nothing else refers to
   * it — so renaming one can only ever move a heading.
   */
  id: string;
  join: StepJoin;
  runtime: AutomationRuntime;
  instructions: string;
}

/** Steps that start together, in order. */
export type Stage = AutomationStep[];

/**
 * The list, grouped into the sets that start together.
 *
 * This is what "waits for" means, and it is derived rather than stored: a
 * second representation of the same fact is a second thing to keep in sync.
 */
export function toStages(steps: AutomationStep[]): Stage[] {
  const stages: Stage[] = [];
  for (const [index, step] of steps.entries()) {
    if (step.join === "with" && index > 0) stages[stages.length - 1].push(step);
    else stages.push([step]);
  }
  return stages;
}

/** The first non-empty line, for the collapsed face. */
export function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .find((line) => line.trim() !== "")
      ?.trim() ?? ""
  );
}

export interface Automation {
  id: string;
  scope: AutomationScope;
  name: string;
  trigger: Trigger;
  /** In order, top to bottom. See {@link StepJoin} for what separates two of them. */
  steps: AutomationStep[];
}

/** The step whose harness stands for the automation in one-mark surfaces. */
export function primaryRuntime(automation: Automation): AutomationRuntime {
  return automation.steps[0].runtime;
}

/** Every harness this automation would start, in step order, deduplicated. */
export function harnessTrail(automation: Automation): LabHarnessId[] {
  return [...new Set(automation.steps.map((step) => step.runtime.harnessId))];
}

/* ------------------------------------------------------------- list edits */

/**
 * Every structural edit the editor can make, as pure functions over the list.
 *
 * They live here rather than in the scratch because they are the part that was
 * actually broken before: under `after` pointers, "remove" had to re-parent
 * orphans and "rename" had to rewrite every reference, and both were one-off
 * loops inside a component with no test around them.
 */

/** Swaps a step for an edited copy of itself, in place. */
export function replaceStep(steps: AutomationStep[], next: AutomationStep): AutomationStep[] {
  return steps.map((step) => (step.id === next.id ? next : step));
}

/** Renaming moves the `## heading` its prose lives under. Nothing else moves. */
export function renameStep(steps: AutomationStep[], from: string, to: string): AutomationStep[] {
  return steps.map((step) => (step.id === from ? { ...step, id: to } : step));
}

/**
 * Removes a step. If it was the first, whatever is now first loses its `with` —
 * a leading step cannot run alongside something that is no longer there.
 */
export function removeStep(steps: AutomationStep[], id: string): AutomationStep[] {
  const kept = steps.filter((step) => step.id !== id);
  if (kept.length > 0 && kept[0].join === "with") kept[0] = { ...kept[0], join: "then" };
  return kept;
}

/**
 * A copy of `id` directly beneath it, under a new name.
 *
 * Beneath, not at the end: position is meaning in this list, and the reason to
 * duplicate a step is almost always "the same thing again, here" — appending
 * would silently move the copy past everything between.
 */
export function duplicateStep(
  steps: AutomationStep[],
  id: string,
  freshId: string,
): AutomationStep[] {
  const at = steps.findIndex((step) => step.id === id);
  if (at === -1) return steps;
  const copy: AutomationStep = { ...steps[at], id: freshId };
  return [...steps.slice(0, at + 1), copy, ...steps.slice(at + 1)];
}

/**
 * New steps land at the end, launching alongside everything already there.
 *
 * The studio's only add affordance is "Add alongside" — there is no UI path
 * that authors a `then` edge. Hand-edited files can still carry one.
 */
export function appendStep(steps: AutomationStep[], step: AutomationStep): AutomationStep[] {
  if (steps.length === 0) return [{ ...step, join: "then" }];
  return [...steps, { ...step, join: "with" }];
}

/** Changes when one step starts. The first step has nothing above it, so it never moves. */
export function setJoin(steps: AutomationStep[], id: string, join: StepJoin): AutomationStep[] {
  return steps.map((step, index) => (step.id === id && index > 0 ? { ...step, join } : step));
}

/**
 * Appended to every step's prompt, in both modes, and not editable.
 *
 * This is what makes prose mode possible: rather than Volli deciding which slice
 * of the ticket to paste in, it tells the agent where the ticket lives and lets
 * it fetch.
 *
 * It used to sit open under the editor on the argument that an author needs to
 * see exactly what the agent was told. That argument is right about the need and
 * wrong about the frequency — it is read once when you are learning the feature
 * and never again, and until then it costs a third of the form's vertical space
 * on every single view. It lives behind a disclosure now.
 */
export const APPENDED_CLI_NOTE = `You are working on ticket {TICKET} in a git worktree on branch {BRANCH}.

The \`volli\` CLI is on your PATH and it is how you reach the planner:
  volli ticket show          the body, labels, attachments and comment history
  volli ticket comment …     report back to the board
  volli diff                 the change set against the merge base
  volli --help               everything else

Read what you need. Do not ask for context that volli can give you.`;

/**
 * A Skill, in the `SKILL.md` sense — the one extensibility format that is
 * genuinely portable.
 *
 * This replaced a per-harness slash-command table. That table keyed commands by
 * harness because each vendor scans its own directory with its own escaping
 * (`.claude/commands`, `~/.codex/prompts`, `.cursor/commands`, opencode's
 * `commands/`), and a prompt written against one silently means nothing to
 * another. Building five adapters just to *list* those directories is exactly
 * the coupling a BYO-harness app exists to avoid.
 *
 * Skills are the alternative: an open, published format read by Claude Code,
 * Codex, opencode and pi alike, discovered by the harness itself. So Volli does
 * not key them by harness, and does not need to know how any harness loads them.
 */
export interface Skill {
  name: string;
  detail: string;
  source: "bundled" | "project" | "user";
}

export const SKILLS: Skill[] = [
  {
    name: "/volli",
    detail: "Read tickets, comment, move columns — ships with Volli",
    source: "bundled",
  },
  { name: "/tdd", detail: ".volli/skills/tdd", source: "project" },
  { name: "/product-docs", detail: ".volli/skills/product-docs", source: "project" },
  { name: "/design-review", detail: ".volli/skills/design-review", source: "project" },
  { name: "/security-review", detail: "~/.config/skills/security-review", source: "user" },
];

/** `/volli` → the skill, if it is one of ours. */
export function skillFor(name: string): Skill | undefined {
  return SKILLS.find((skill) => skill.name === name);
}

/**
 * `at` is the token's offset in the source text. It is carried so the editor has
 * a data-dependent React key: an array index would make every token after an
 * inserted chip re-key, which is the one thing that reliably makes a caret jump
 * while you are typing into the field being highlighted.
 */
export type InstructionToken = { at: number } & (
  | { kind: "text"; value: string }
  | { kind: "brace"; token: string }
  | { kind: "skill"; name: string; known: boolean }
);

/**
 * Splits Instructions into prose, stray braces and skill references so the
 * editor can paint each differently. One pass, because the three token shapes
 * can't nest.
 *
 * `{{braces}}` are recognised precisely so they can be painted as WRONG.
 * Nothing resolves them any more, so the agent would receive them verbatim —
 * and the people most likely to type one are the ones who used the feature
 * while it existed. Silently rendering them as ordinary prose is the one
 * option that guarantees the mistake ships.
 */
export function tokenizeInstructions(text: string): InstructionToken[] {
  const pattern = /\{\{(\w+)\}\}|(?:^|(?<=\s))(\/[\w-]+)/g;
  const tokens: InstructionToken[] = [];
  let cursor = 0;

  for (const match of text.matchAll(pattern)) {
    const at = match.index;
    if (at > cursor) tokens.push({ kind: "text", at: cursor, value: text.slice(cursor, at) });
    if (match[1] !== undefined) {
      tokens.push({ kind: "brace", at, token: match[1] });
    } else {
      // Never blocked, only marked: an unrecognised skill renders as prose with
      // a quiet unverified affordance. Volli cannot see every skill directory a
      // harness might load, so absence here is not proof of absence on disk.
      tokens.push({ kind: "skill", at, name: match[2], known: skillFor(match[2]) !== undefined });
    }
    cursor = at + match[0].length;
  }
  if (cursor < text.length) tokens.push({ kind: "text", at: cursor, value: text.slice(cursor) });
  return tokens;
}

/**
 * An unused step id built from `base`: `codex`, then `codex-2`, and so on.
 *
 * Named for the harness rather than numbered, because the id is the `## heading`
 * a person reads in the file — `## codex` says what that section is, `## step-3`
 * says only that it was the third one added.
 */
export function freshStepId(steps: AutomationStep[], base: string): string {
  const taken = new Set(steps.map((step) => step.id));
  if (!taken.has(base)) return base;
  let suffix = 2;
  while (taken.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

/** A fresh step. */
export function blankStep(harnessId: LabHarnessId, id: string): AutomationStep {
  return { id, join: "then", runtime: defaultRuntime(harnessId), instructions: "" };
}

function seedStep(
  id: string,
  harnessId: LabHarnessId,
  patch: Partial<AutomationRuntime>,
  instructions: string,
  join: StepJoin = "then",
): AutomationStep {
  return { id, join, runtime: { ...defaultRuntime(harnessId), ...patch }, instructions };
}

/**
 * The seeded set: real, editable, one per lifecycle stage, and every one of them
 * unarmed. Seeded-and-armed would spend tokens on someone's first drag, which is
 * the exact surprise the automation-only-de-escalates rule exists to prevent.
 *
 * Every one is prose, written the way a person actually writes a prompt.
 * "Two-opinion review" stresses the structure that is honest today: two readers
 * launching side by side. A third "then triage" step used to sit underneath
 * them; it was cut because Stop hooks mean the agent yielded, not that the work
 * is done — chaining on exit is a lie. If you want triage later, that is a
 * second automation on a later column move.
 *
 * "Grill the ticket" fires in two columns, which is the other case worth seeding
 * — on the board it appears in both lanes, because one file genuinely does fire
 * in both places and a board that showed it once would have to pick a lie.
 *
 * "Pull product signals" is the off-board case: a schedule, not a column move,
 * whose job may be to CREATE tickets rather than to work one.
 */
export const SEEDED_AUTOMATIONS: Automation[] = [
  {
    id: "atm-grill",
    scope: "project",
    name: "Grill the ticket",
    trigger: { kind: "enters-column", columns: ["backlog", "todo"] },
    steps: [
      seedStep(
        "grill",
        "claude-code",
        { model: "claude-opus-5", effort: "high", approvals: "plan" },
        "Before writing any code, interrogate this ticket with me. Read it, then find the parts that are underspecified, the assumptions I have not stated, and anything that contradicts what is already in the codebase.\n\nAsk one question at a time. When we agree on the shape, write it back into the ticket body.",
      ),
    ],
  },
  {
    id: "atm-implement",
    scope: "project",
    name: "Implement",
    trigger: { kind: "enters-column", columns: ["doing"] },
    steps: [
      seedStep(
        "implement",
        "claude-code",
        { model: "claude-opus-5", effort: "high", approvals: "acceptEdits" },
        "Implement this ticket. Match the conventions of the code you are changing rather than importing new ones, and run the project's checks before you tell me it is done.\n\nIf the ticket turns out to be wrong, stop and say so instead of building the wrong thing well.",
      ),
    ],
  },
  {
    id: "atm-review",
    scope: "project",
    name: "Two-opinion review",
    trigger: { kind: "enters-column", columns: ["needs_review"] },
    steps: [
      seedStep(
        "codex",
        "codex",
        { model: "gpt-5.1-codex", effort: "high", approvals: "read-only" },
        "Review the change set on this branch against the ticket it claims to implement.\n\nBe specific about what is wrong and where. Do not restate what the diff already says.",
      ),
      seedStep(
        "cursor",
        "cursor",
        { model: "sonnet-4-thinking", approvals: "sandbox" },
        "Read the change set looking only for what it BREAKS — call sites it missed, invariants it quietly drops, tests that now pass for the wrong reason.\n\nIgnore style. Another reviewer has the ticket; you have the blast radius.",
        "with",
      ),
    ],
  },
  {
    id: "atm-wrapup",
    scope: "project",
    name: "Wrap up",
    trigger: { kind: "enters-column", columns: ["done"] },
    steps: [
      seedStep(
        "wrapup",
        "claude-code",
        { model: "claude-sonnet-5", effort: "medium", approvals: "acceptEdits" },
        "This work is ready to land. Write the PR body from the ticket and from what actually changed — the ticket for the intent, the diff for the substance.\n\nFlag anything in the change set that the ticket never asked for.",
      ),
    ],
  },
  {
    id: "atm-signals",
    scope: "project",
    name: "Pull product signals",
    trigger: { kind: "schedule" },
    steps: [
      seedStep(
        "signals",
        "claude-code",
        { model: "claude-sonnet-5", effort: "medium", approvals: "plan" },
        "Use the PostHog MCP to pull recent product events and funnels that look broken or surprising.\n\nFor each signal worth a look, create a ticket in Backlog with enough context that tomorrow-me can grill it cold. Prefer fewer sharp tickets over a dump of noise.",
      ),
    ],
  },
  {
    id: "atm-tdd",
    scope: "global",
    name: "TDD loop",
    trigger: { kind: "manual" },
    steps: [
      seedStep(
        "tdd",
        "pi",
        { model: "anthropic/claude-opus-5", effort: "high" },
        "/tdd\n\nRed, green, refactor. Write the failing test first and show it to me failing before you make it pass.",
      ),
    ],
  },
];

/** A fresh Automation, entered from a column where there is one. */
export function blankAutomation(scope: AutomationScope, from: TicketStatus | null): Automation {
  return {
    id: "atm-new",
    scope,
    name: "",
    trigger: { kind: "enters-column", columns: from === null ? [] : [from] },
    steps: [blankStep("claude-code", "claude-code")],
  };
}
