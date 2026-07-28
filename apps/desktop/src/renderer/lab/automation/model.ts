/**
 * The Automations vocabulary, as far as the lab needs it — the four-part object,
 * the adapter-owned Runtime, the two authoring modes, and the seeded set.
 *
 * This is deliberately a LAB model, not a draft of `@volli/shared`. Nothing here
 * is persisted, validated at an IPC boundary, or shaped by SQLite. What it
 * exists to do is give the two automation scratches one shared, honest
 * vocabulary so a design judgement made on the form is being made about the same
 * object the trigger surfaces fire.
 *
 * ── WHY TWO MODES ─────────────────────────────────────────────────────────
 * The original design gave every Automation a set of `{{context}}` placeholders
 * that Volli resolved before handing the prompt to the agent. Research into the
 * category found that nobody else does this: every shipped agent tool either
 * dumps the whole issue into the prompt implicitly, or appends a plain string.
 * The reason is that it babysteps a model that can fetch what it needs — and
 * doing it well means Volli guessing, at author time, which slice of the ticket
 * matters for a run that has not happened yet.
 *
 * So BASIC mode has no substitutions at all. The prompt is prose, and every
 * prompt is appended with {@link APPENDED_CLI_NOTE}, which tells the agent it
 * has the `volli` CLI and which ticket it is on. The agent pulls what it wants.
 * ADVANCED mode restores the placeholders for the cases where you genuinely need
 * to control ordering — the review case below is the honest example.
 *
 * The lab exists to find out whether Advanced earns its existence. The
 * hypothesis is that it does not.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * The one thing this models with real care is the part the UI cannot fake: an
 * adapter's Runtime is its OWN dialect. Claude Code has no effort flag at all,
 * Codex takes a config argument, opencode folds effort into the model slug — so
 * an effort dial is present for some harnesses and structurally absent for
 * others. A prototype that shows the same three-stop slider for every harness
 * would be asserting an equivalence that does not exist, and would make the form
 * look easier than it is.
 */
import { HARNESS_LABELS, type HarnessId, type TicketStatus } from "@volli/shared";

/** Global automations appear in every project; project ones only in theirs. */
export type AutomationScope = "global" | "project";

/**
 * How the Instructions are authored.
 *
 * `basic` — prose only. Skills may be referenced; `{{placeholders}}` are not
 * resolved and are shown as a mistake if typed.
 * `advanced` — placeholders resolve against live ticket state at launch.
 */
export type AuthoringMode = "basic" | "advanced";

export interface AutomationRuntime {
  /** Pinned — Instructions are written in one harness's dialect and don't port. */
  harnessId: HarnessId;
  /** Free text with suggestions, never a closed enum: model names churn faster than releases. */
  model: string;
  /** A stop on the adapter's own scale, or `null` when it has no effort dial. */
  effort: string | null;
}

export interface Automation {
  id: string;
  scope: AutomationScope;
  name: string;
  /** `"any"` offers it everywhere; a status list restricts where it's offered. */
  columnScope: "any" | TicketStatus[];
  mode: AuthoringMode;
  instructions: string;
  runtime: AutomationRuntime;
}

/**
 * Appended to every Automation's prompt, in both modes, and not editable.
 *
 * This is what makes Basic mode possible: rather than Volli deciding which
 * slice of the ticket to paste in, it tells the agent where the ticket lives and
 * lets it fetch. The form shows this verbatim rather than describing it, because
 * an author needs to know exactly what the agent was told before deciding how
 * much of it to repeat.
 */
export const APPENDED_CLI_NOTE = `You are working on ticket {TICKET} in a git worktree on branch {BRANCH}.

The \`volli\` CLI is on your PATH and it is how you reach the planner:
  volli ticket show          the body, labels, attachments and comment history
  volli ticket comment …     report back to the board
  volli diff                 the change set against the merge base
  volli --help               everything else

Read what you need. Do not ask for context that volli can give you.`;

/**
 * What the form can render for one harness. `effortScale` being empty is a
 * modelled state, not missing data — see the module doc.
 */
export interface HarnessAdapterUi {
  label: string;
  /** Suggestions for the model combobox. Typing something absent is always allowed. */
  models: string[];
  /** Ordered weakest → strongest. Empty when the harness exposes no effort dial. */
  effortScale: string[];
  /** How this harness expresses effort — shown so the dial never looks portable. */
  effortNote: string;
}

export const HARNESS_ADAPTERS: Record<HarnessId, HarnessAdapterUi> = {
  "claude-code": {
    label: HARNESS_LABELS["claude-code"],
    models: ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"],
    effortScale: ["think", "think hard", "ultrathink"],
    effortNote: "No effort flag — expressed as a thinking keyword in the prompt.",
  },
  codex: {
    label: HARNESS_LABELS.codex,
    models: ["gpt-5.1-codex", "gpt-5.1-codex-mini"],
    effortScale: ["low", "medium", "high"],
    effortNote: "Passed as -c model_reasoning_effort=…",
  },
  opencode: {
    label: HARNESS_LABELS.opencode,
    models: ["anthropic/claude-opus-5", "openai/gpt-5.1", "google/gemini-3-pro"],
    // Not an oversight: opencode folds reasoning effort into the model slug, so
    // there is no second dial to bind to. The form must show nothing here.
    effortScale: [],
    effortNote: "Folded into the model slug — no separate dial.",
  },
};

/**
 * A Skill, in the `SKILL.md` sense — the one extensibility format that is
 * genuinely portable.
 *
 * This replaced a per-harness slash-command table. That table keyed commands by
 * harness because each vendor scans its own directory with its own escaping
 * (`.claude/commands`, `~/.codex/prompts`, `.cursor/commands`, opencode's
 * `commands/`), and a prompt written against one silently means nothing to
 * another. Building three adapters just to *list* those directories is exactly
 * the coupling a BYO-harness app exists to avoid.
 *
 * Skills are the alternative: an open, published format read by Claude Code,
 * Codex and opencode alike, discovered by the harness itself. So Volli does not
 * key them by harness, and does not need to know how any harness loads them —
 * which is why there is one flat list here and no `Record<HarnessId, …>`.
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

/** A placeholder resolved against live ticket state at launch — Advanced mode only. */
export interface ContextChip {
  token: string;
  label: string;
  /** What it turns into, in one phrase — the form shows this, not a schema. */
  resolves: string;
}

export const CONTEXT_CHIPS: ContextChip[] = [
  {
    token: "brief",
    label: "Runtime Brief",
    resolves: "orientation, body, attachments, CLI paragraph",
  },
  { token: "change_set", label: "Change Set", resolves: "the diff vs the merge base" },
  { token: "comments", label: "Comments", resolves: "the ticket's comment timeline" },
  { token: "pr", label: "Pull request", resolves: "PR url, state and checks" },
  { token: "branch", label: "Branch", resolves: "branch name and base branch" },
];

/** `{{brief}}` → the chip, if it is one of ours. */
export function chipFor(token: string): ContextChip | undefined {
  return CONTEXT_CHIPS.find((chip) => chip.token === token);
}

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
  | { kind: "chip"; token: string; known: boolean }
  | { kind: "skill"; name: string; known: boolean }
);

/**
 * Splits Instructions into prose, chips and skill references so the editor can
 * paint each differently. One pass, because the three token shapes can't nest.
 *
 * `mode` changes only what counts as KNOWN, never what is recognised: a
 * `{{chip}}` in Basic mode is still found, and still tokenised as a chip — it is
 * just marked unknown, because in Basic mode nothing will resolve it and the
 * agent would receive the literal braces. Silently painting it as valid would be
 * the worst of the options.
 */
export function tokenizeInstructions(text: string, mode: AuthoringMode): InstructionToken[] {
  const pattern = /\{\{(\w+)\}\}|(?:^|(?<=\s))(\/[\w-]+)/g;
  const tokens: InstructionToken[] = [];
  let cursor = 0;

  for (const match of text.matchAll(pattern)) {
    const at = match.index;
    if (at > cursor) tokens.push({ kind: "text", at: cursor, value: text.slice(cursor, at) });
    if (match[1] !== undefined) {
      tokens.push({
        kind: "chip",
        at,
        token: match[1],
        known: mode === "advanced" && chipFor(match[1]) !== undefined,
      });
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
 * The seeded set: real, editable, one per lifecycle stage, and every one of them
 * UNARMED. Seeded-and-armed would spend tokens on someone's first drag, which is
 * the exact surprise the automation-only-de-escalates rule exists to prevent.
 *
 * Four of the five are Basic, written the way a person actually writes a prompt.
 * "Code review" is deliberately the one Advanced seed, because it is the single
 * case that genuinely cannot be expressed as prose-plus-fetch: the diff has to
 * LEAD and the ticket body has to be demoted underneath it, and that ordering is
 * the whole point of the review. If Advanced mode dies, this is the automation
 * that has to survive the transition — so it is the one to watch.
 */
export const SEEDED_AUTOMATIONS: Automation[] = [
  {
    id: "atm-grill",
    scope: "project",
    name: "Grill the ticket",
    columnScope: ["todo"],
    mode: "basic",
    instructions:
      "Before writing any code, interrogate this ticket with me. Read it, then find the parts that are underspecified, the assumptions I have not stated, and anything that contradicts what is already in the codebase.\n\nAsk one question at a time. When we agree on the shape, write it back into the ticket body.",
    runtime: { harnessId: "claude-code", model: "claude-opus-5", effort: "think hard" },
  },
  {
    id: "atm-implement",
    scope: "project",
    name: "Implement",
    columnScope: ["doing"],
    mode: "basic",
    instructions:
      "Implement this ticket. Match the conventions of the code you are changing rather than importing new ones, and run the project's checks before you tell me it is done.\n\nIf the ticket turns out to be wrong, stop and say so instead of building the wrong thing well.",
    runtime: { harnessId: "claude-code", model: "claude-opus-5", effort: "think" },
  },
  {
    id: "atm-review",
    scope: "project",
    name: "Code review",
    columnScope: ["needs_review"],
    mode: "advanced",
    instructions:
      "Review {{change_set}} on {{branch}}.\n\nThe ticket it claims to implement, for context only: {{brief}}\n\nBe specific about what is wrong and where. Do not restate what the diff already says.",
    runtime: { harnessId: "codex", model: "gpt-5.1-codex", effort: "high" },
  },
  {
    id: "atm-wrapup",
    scope: "project",
    name: "Wrap up",
    columnScope: ["done"],
    mode: "basic",
    instructions:
      "This work is ready to land. Write the PR body from the ticket and from what actually changed — the ticket for the intent, the diff for the substance.\n\nFlag anything in the change set that the ticket never asked for.",
    runtime: { harnessId: "claude-code", model: "claude-sonnet-5", effort: null },
  },
  {
    id: "atm-tdd",
    scope: "global",
    name: "TDD loop",
    columnScope: "any",
    mode: "basic",
    instructions:
      "/tdd\n\nRed, green, refactor. Write the failing test first and show it to me failing before you make it pass.",
    runtime: { harnessId: "claude-code", model: "claude-opus-5", effort: "think" },
  },
];

/** A fresh Automation. Basic by default — Advanced is the escape hatch, not the door. */
export function blankAutomation(scope: AutomationScope): Automation {
  return {
    id: "atm-new",
    scope,
    name: "",
    columnScope: "any",
    mode: "basic",
    instructions: "",
    runtime: { harnessId: "claude-code", model: "claude-opus-5", effort: "think" },
  };
}
