/**
 * The Automations vocabulary, as far as the lab needs it — the four-part object
 * (#79), the adapter-owned Runtime (#81), the Context chips and the `/` command
 * tiers (#82), plus the seeded set (#88).
 *
 * This is deliberately a LAB model, not a draft of `@volli/shared`. Nothing here
 * is persisted, validated at an IPC boundary, or shaped by SQLite; the plan's
 * data model is the record for that. What it exists to do is give the two
 * automation scratches one shared, honest vocabulary so a design judgement made
 * on the form is being made about the same object the trigger surfaces fire.
 *
 * The one thing it models with real care is the part the UI cannot fake: an
 * adapter's Runtime is its OWN dialect (#81). Claude Code has no effort flag at
 * all, Codex takes a config argument, opencode folds effort into the model slug
 * — so an effort dial is present for some harnesses and structurally absent for
 * others. A prototype that shows the same three-stop slider for every harness
 * would be asserting an equivalence the plan explicitly rejected, and would make
 * the form look easier than it is.
 */
import { HARNESS_LABELS, type HarnessId, type TicketStatus } from "@volli/shared";

/** Global automations appear in every project; project ones only in theirs (#79). */
export type AutomationScope = "global" | "project";

export interface AutomationRuntime {
  /** Pinned — Instructions are written in one harness's dialect and don't port (#81). */
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
  instructions: string;
  runtime: AutomationRuntime;
}

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

/** A placeholder resolved against live ticket state at launch, never a stored copy (#82). */
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

/**
 * A `/` command offered by the picker.
 *
 * The `tier` is the whole point of #82: `scanned` came off disk, `builtin` is
 * compiled into the harness binary and appears nowhere on disk (a disk-only
 * scan would silently omit `/code-review` — the most useful one), and anything
 * typed that matches neither is never blocked, only marked unverified.
 */
export interface SlashCommand {
  name: string;
  tier: "scanned" | "builtin";
  detail: string;
}

export const SLASH_COMMANDS: Record<HarnessId, SlashCommand[]> = {
  "claude-code": [
    { name: "/code-review", tier: "builtin", detail: "Compiled in — not on disk" },
    { name: "/security-review", tier: "builtin", detail: "Compiled in — not on disk" },
    { name: "/simplify", tier: "builtin", detail: "Compiled in — not on disk" },
    { name: "/tdd", tier: "scanned", detail: ".claude/skills/tdd" },
    { name: "/volli", tier: "scanned", detail: ".claude/skills/volli" },
    { name: "/product-docs", tier: "scanned", detail: ".claude/commands/product-docs.md" },
  ],
  codex: [
    { name: "/review", tier: "builtin", detail: "Compiled in — not on disk" },
    { name: "/init", tier: "builtin", detail: "Compiled in — not on disk" },
    { name: "/plan", tier: "scanned", detail: ".codex/prompts/plan.md" },
  ],
  opencode: [{ name: "/volli", tier: "scanned", detail: "~/.config/opencode/command/volli.md" }],
};

/** `{{brief}}` → the chip, if it is one of ours. */
export function chipFor(token: string): ContextChip | undefined {
  return CONTEXT_CHIPS.find((chip) => chip.token === token);
}

/**
 * Splits Instructions into prose, chips and command references so a preview can
 * render each differently. One pass, because the three token shapes can't nest.
 */
/**
 * `at` is the token's offset in the source text. It is carried so the preview
 * has a data-dependent React key: an array index would make every token after
 * an inserted chip re-key, which is the one thing that reliably makes a caret
 * jump while you are typing into the field being previewed.
 */
export type InstructionToken = { at: number } & (
  | { kind: "text"; value: string }
  | { kind: "chip"; token: string; known: boolean }
  | { kind: "command"; name: string; known: boolean }
);

export function tokenizeInstructions(text: string, harnessId: HarnessId): InstructionToken[] {
  const known = new Set(SLASH_COMMANDS[harnessId].map((command) => command.name));
  const pattern = /\{\{(\w+)\}\}|(?:^|(?<=\s))(\/[\w-]+)/g;
  const tokens: InstructionToken[] = [];
  let cursor = 0;

  for (const match of text.matchAll(pattern)) {
    const at = match.index;
    if (at > cursor) tokens.push({ kind: "text", at: cursor, value: text.slice(cursor, at) });
    if (match[1] !== undefined) {
      tokens.push({ kind: "chip", at, token: match[1], known: chipFor(match[1]) !== undefined });
    } else {
      // Never blocked, only marked: an unrecognised command renders as prose
      // with a quiet unverified affordance (#82).
      tokens.push({ kind: "command", at, name: match[2], known: known.has(match[2]) });
    }
    cursor = at + match[0].length;
  }
  if (cursor < text.length) tokens.push({ kind: "text", at: cursor, value: text.slice(cursor) });
  return tokens;
}

/**
 * The seeded set (#88): real, editable, one per lifecycle stage, and every one
 * of them UNARMED. Seeded-and-armed would spend tokens on someone's first drag,
 * which is the exact surprise #20 exists to prevent.
 *
 * Written the way a person actually writes a prompt — the chips sit inside
 * sentences rather than stacked in a header — because a seed that reads like a
 * form submission teaches everyone who edits it to write one.
 */
export const SEEDED_AUTOMATIONS: Automation[] = [
  {
    id: "atm-grill",
    scope: "project",
    name: "Grill the ticket",
    columnScope: ["todo"],
    instructions:
      "{{brief}}\n\nBefore writing any code, interrogate this ticket with me. Find the parts that are underspecified, the assumptions I have not stated, and anything that contradicts what is already in the codebase. Ask one question at a time. When we agree on the shape, write it back into the ticket body.",
    runtime: { harnessId: "claude-code", model: "claude-opus-5", effort: "think hard" },
  },
  {
    id: "atm-implement",
    scope: "project",
    name: "Implement",
    columnScope: ["doing"],
    instructions:
      "{{brief}}\n\nImplement this ticket. Match the conventions of the code you are changing rather than importing new ones, and run the project's checks before you tell me it is done.\n\nIf the ticket turns out to be wrong, stop and say so instead of building the wrong thing well.",
    runtime: { harnessId: "claude-code", model: "claude-opus-5", effort: "think" },
  },
  {
    id: "atm-review",
    scope: "project",
    name: "Code review",
    // The review automation is the case a fixed Instructions-then-Brief sandwich
    // cannot express (#82): the Change Set leads and the Ticket Body is demoted
    // to context underneath it.
    columnScope: ["needs_review"],
    // `/review`, not `/code-review` — this Automation is pinned to Codex, and
    // `/code-review` is a Claude Code builtin. Getting this wrong is the exact
    // failure #81 predicts (Instructions are written in ONE harness's dialect
    // and do not port), and a seeded Automation that ships already flagged
    // unverified would teach every reader that the flag is normal.
    instructions:
      "/review\n\nReview {{change_set}} on {{branch}}.\n\nThe ticket it claims to implement, for context only: {{brief}}\n\nBe specific about what is wrong and where. Do not restate what the diff already says.",
    runtime: { harnessId: "codex", model: "gpt-5.1-codex", effort: "high" },
  },
  {
    id: "atm-wrapup",
    scope: "project",
    name: "Wrap up",
    columnScope: ["done"],
    instructions:
      "{{change_set}} is ready to land on {{branch}}.\n\nWrite the PR body from the ticket and what actually changed — {{brief}} for the intent, the diff for the substance. Flag anything in the change set that the ticket never asked for.",
    runtime: { harnessId: "claude-code", model: "claude-sonnet-5", effort: null },
  },
  {
    id: "atm-tdd",
    scope: "global",
    name: "TDD loop",
    columnScope: "any",
    instructions:
      "/tdd\n\n{{brief}}\n\nRed, green, refactor. Write the failing test first and show it to me failing before you make it pass.",
    runtime: { harnessId: "claude-code", model: "claude-opus-5", effort: "think" },
  },
];

/** A fresh Automation, pre-seeded so the ticket's context is present without configuration (#82). */
export function blankAutomation(scope: AutomationScope): Automation {
  return {
    id: "atm-new",
    scope,
    name: "",
    columnScope: "any",
    instructions: "{{brief}}\n\n",
    runtime: { harnessId: "claude-code", model: "claude-opus-5", effort: "think" },
  };
}
