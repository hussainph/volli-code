/**
 * An Automation, as a file on disk.
 *
 * ── WHY A FILE AT ALL ─────────────────────────────────────────────────────
 * Research into the category (July 2026) turned up one fact that decided this:
 * no shipping coding-agent product lets you author a repeated agent workflow on
 * a node canvas, and the ones with the most design budget — Devin, Codex,
 * Cursor, Copilot, Linear — all landed on the same substitute, a text artifact
 * you check in. Devin calls it a Playbook, OpenAI calls it AGENTS.md, GitHub
 * calls it a custom agent, Claude Code calls it a Skill. Same thing each time:
 * frontmatter for the parameters a machine reads, prose for the part a model
 * reads.
 *
 * So an Automation is that file. The board is a view of it, never its home.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * ── THE SHAPE, AND THE ONE BORROWED IDEA ──────────────────────────────────
 * `on:` is a MAP of kind → operand, lifted wholesale from GitHub Actions:
 *
 *     on:
 *       enters-column: [doing]
 *
 * The obvious alternative was two flat keys (`on: enters-column` plus
 * `columns: [...]`), which reads better and is wrong for the same reason
 * {@link Trigger} is a union rather than a bare column list — the operand has to
 * be welded to the kind, or a file can carry `on: manual` with a stale column
 * list underneath it and no parser can tell which half the author meant. The
 * nested map makes that state unspellable, and it is already the most widely
 * read trigger syntax there is.
 *
 * v1 accepts exactly one key under `on:`. The map shape is what leaves room for
 * a second without a format change, which is the whole point of borrowing it.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * ── HOW STEPS FIND THEIR PROSE ────────────────────────────────────────────
 * Frontmatter holds the dials; the body holds the prompts, split by `## <id>`
 * headings. But a one-step automation needs no headings at all — an unheaded
 * body IS the single step's instructions, which makes the common file identical
 * in shape to a SKILL.md and keeps the format from taxing the n=1 case to pay
 * for the n=2 one.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * ── THE ONLY STRUCTURE IN THE LIST ────────────────────────────────────────
 * `steps:` is one flat ordered list and `also: true` is the whole of the
 * control flow: a step marked `also` starts alongside the one above it instead
 * of after it. Everything else runs in file order, top to bottom.
 *
 *     steps:
 *       - id: codex
 *       - id: cursor
 *         also: true         ← starts with codex, not after it
 *       - id: triage         ← once both have finished
 *
 * The predecessor was `after: <step id>`, a named parent, which bought a general
 * tree — and a general tree is exactly what this format must not offer. Volli
 * cannot tell "that step succeeded" from harness events, because the five
 * adapters do not agree on what they emit; a shape that reads as if-then over
 * that is a shape that lies. `also` promises only what a process exit code
 * delivers.
 *
 * It is also the one spelling with nothing to break. A pointer can dangle, cycle,
 * or orphan its children when a step is deleted, and every one of those needed a
 * diagnostic. A flag reads as English, cannot refer to a step that is not there,
 * and survives any rename — because it names nothing. It is the same field the
 * editor puts on the connector between two cards, spelled the same way.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * ── ON PARSING ────────────────────────────────────────────────────────────
 * The frontmatter reader below is a deliberate YAML SUBSET, not YAML — scalars,
 * inline arrays, one level of nesting, and a list of maps. It is written this
 * way for the same reason `ghostty-config.ts` is: a whole YAML implementation
 * brings a whole YAML implementation's ambiguities (`no` is a boolean, `1.0` is
 * a float, `needs_review` is fine but `Y` is not) to a format whose entire value
 * is being predictable to a human editing it in a text editor.
 *
 * It fails LOUDLY. Anything it does not understand becomes a
 * {@link FileDiagnostic} rather than a silent drop, because a config parser that
 * ignores what it cannot read is how you ship an automation that quietly does
 * half of what its file says.
 * ──────────────────────────────────────────────────────────────────────────
 */
import { TICKET_STATUSES, type TicketStatus } from "@volli/shared";

import {
  defaultRuntime,
  HARNESS_ADAPTERS,
  LAB_HARNESS_IDS,
  TRIGGER_KINDS,
  type Automation,
  type AutomationScope,
  type AutomationStep,
  type AuthoringMode,
  type LabHarnessId,
  type StepJoin,
  type Trigger,
  type TriggerKind,
} from "./model";

/* ------------------------------------------------------------ vocabulary */

/**
 * What each trigger kind is called in a file.
 *
 * A second vocabulary is a cost, and it is worth paying exactly once: the
 * internal ids are named for the union they discriminate (`enters-column`),
 * while a file is read left to right by a person (`on: enters-column: [doing]`).
 * Keeping the map explicit means the day an id is renamed, the format does not
 * move underneath every checked-in file in every repo.
 */
export const TRIGGER_FILE_KEYS: Record<TriggerKind, string> = {
  "enters-column": "enters-column",
  "leaves-column": "leaves-column",
  manual: "run-by-hand",
  "label-added": "label-added",
  "checks-pass": "checks-pass",
  "session-ends": "session-ends",
  schedule: "schedule",
  inbound: "inbound",
};

const TRIGGER_KIND_BY_FILE_KEY = new Map<string, TriggerKind>(
  Object.entries(TRIGGER_FILE_KEYS).map(([kind, key]) => [key, kind as TriggerKind]),
);

/**
 * Ticket statuses are written with their real stored values (`needs_review`,
 * not `needs-review`). A prettier spelling in the file would mean a mapping,
 * and a mapping between a file and a database column is a place for them to
 * drift — the underscore is cheaper than the bug.
 */
const STATUS_SET = new Set<string>(TICKET_STATUSES);

/* ----------------------------------------------------------- diagnostics */

export interface FileDiagnostic {
  /** 1-based line in the source text, or null when the problem is the file as a whole. */
  line: number | null;
  severity: "error" | "warning";
  message: string;
}

export interface ParsedAutomationFile {
  /** Always present. On `error` diagnostics this is the best reading available, not a lie about validity. */
  automation: Automation;
  diagnostics: FileDiagnostic[];
}

/* ------------------------------------------------------- the tiny reader */

interface Entry {
  key: string;
  value: string;
  line: number;
  children: Entry[];
  /** True for `- ` list items, whose `key` is always `"-"`. */
  item: boolean;
}

function indentOf(line: string): number {
  let count = 0;
  while (count < line.length && line[count] === " ") count += 1;
  return count;
}

/** `key: value` → the pair; a line with no colon → the whole line as key. */
function splitPair(text: string): { key: string; value: string } {
  const at = text.indexOf(":");
  if (at === -1) return { key: text.trim(), value: "" };
  return { key: text.slice(0, at).trim(), value: text.slice(at + 1).trim() };
}

/**
 * Reads indented `key: value` lines into a shallow tree. Blank lines and `#`
 * comments are skipped; tabs are rejected by the caller, because a tab in a
 * YAML-shaped file is the single most common way to get an indentation level
 * that looks right and parses wrong.
 */
function readEntries(lines: string[], startLine: number, diagnostics: FileDiagnostic[]): Entry[] {
  const root: Entry[] = [];
  const stack: Array<{ indent: number; children: Entry[] }> = [{ indent: -1, children: root }];

  for (const [offset, raw] of lines.entries()) {
    const line = startLine + offset;
    if (raw.trim() === "" || raw.trimStart().startsWith("#")) continue;
    if (raw.includes("\t")) {
      diagnostics.push({ line, severity: "error", message: "Tab in indentation — use spaces" });
      continue;
    }

    const indent = indentOf(raw);
    const text = raw.trim();
    const isItem = text.startsWith("- ");

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();

    if (isItem) {
      const pair = splitPair(text.slice(2));
      const entry: Entry = { key: "-", value: "", line, children: [], item: true };
      entry.children.push({ ...pair, line, children: [], item: false });
      stack[stack.length - 1].children.push(entry);
      // An item's own keys sit deeper than the dash, so the container it opens
      // is measured from the dash, not from the inline pair after it.
      stack.push({ indent, children: entry.children });
      continue;
    }

    const entry: Entry = { ...splitPair(text), line, children: [], item: false };
    stack[stack.length - 1].children.push(entry);
    stack.push({ indent, children: entry.children });
  }

  return root;
}

/** `[a, b]` → the members; anything else → null (it is a scalar, not a list). */
function readInlineList(value: string): string[] | null {
  if (!value.startsWith("[") || !value.endsWith("]")) return null;
  const inner = value.slice(1, -1).trim();
  if (inner === "") return [];
  return inner.split(",").map((member) => unquote(member.trim()));
}

function unquote(value: string): string {
  const quoted =
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")));
  return quoted ? value.slice(1, -1) : value;
}

/* ------------------------------------------------------------- the body */

const HEADING = /^##\s+(.+?)\s*$/;

/**
 * Splits the prose half into `id → instructions`.
 *
 * `null` means the body carried no headings at all, which is the one-step case
 * and is handled by the caller — it needs to know the difference between "no
 * sections" and "a section that happens to be empty".
 */
function readSections(body: string): Map<string, string> | null {
  const lines = body.split("\n");
  if (!lines.some((line) => HEADING.test(line))) return null;

  const sections = new Map<string, string>();
  let current: string | null = null;
  let buffer: string[] = [];

  function flush() {
    if (current !== null) sections.set(current, buffer.join("\n").trim());
  }

  for (const line of lines) {
    const heading = HEADING.exec(line);
    if (heading === null) {
      buffer.push(line);
      continue;
    }
    flush();
    current = heading[1];
    buffer = [];
  }
  flush();
  return sections;
}

/* ------------------------------------------------------------- reading */

function readTrigger(entry: Entry | undefined, diagnostics: FileDiagnostic[]): Trigger {
  if (entry === undefined) {
    diagnostics.push({ line: null, severity: "error", message: "No `on:` — nothing fires this" });
    return { kind: "enters-column", columns: [] };
  }

  if (entry.children.length === 0) {
    diagnostics.push({ line: entry.line, severity: "error", message: "`on:` names no trigger" });
    return { kind: "enters-column", columns: [] };
  }
  if (entry.children.length > 1) {
    diagnostics.push({
      line: entry.children[1].line,
      severity: "warning",
      message: "Only the first trigger under `on:` fires — one per automation for now",
    });
  }

  const first = entry.children[0];
  const kind = TRIGGER_KIND_BY_FILE_KEY.get(first.key);
  if (kind === undefined) {
    diagnostics.push({
      line: first.line,
      severity: "error",
      message: `Unknown trigger \`${first.key}\``,
    });
    return { kind: "enters-column", columns: [] };
  }
  if (!TRIGGER_KINDS[kind].available) {
    diagnostics.push({
      line: first.line,
      severity: "error",
      message: `\`${first.key}\` is designed for but not built — this will not fire`,
    });
  }
  if (kind === "manual") return { kind: "manual" };
  if (kind !== "enters-column" && kind !== "leaves-column") {
    // Unbuilt kinds have no operand modelled yet; read them as their column
    // equivalent so the surface can still show what the file says.
    return { kind: "enters-column", columns: [] };
  }

  const listed = readInlineList(first.value);
  if (listed === null) {
    diagnostics.push({
      line: first.line,
      severity: "error",
      message: `\`${first.key}\` needs a column list, e.g. [doing]`,
    });
    return { kind, columns: [] };
  }

  const columns: TicketStatus[] = [];
  for (const member of listed) {
    if (STATUS_SET.has(member)) {
      columns.push(member as TicketStatus);
    } else {
      diagnostics.push({
        line: first.line,
        severity: "error",
        message: `\`${member}\` is not a column`,
      });
    }
  }
  return { kind, columns };
}

function childValue(entry: Entry, key: string): { value: string; line: number } | undefined {
  const found = entry.children.find((child) => child.key === key);
  return found === undefined ? undefined : { value: found.value, line: found.line };
}

const STEP_KEYS = new Set(["id", "harness", "model", "effort", "approvals", "mode", "also"]);

function readStep(entry: Entry, index: number, diagnostics: FileDiagnostic[]): AutomationStep {
  for (const child of entry.children) {
    if (!STEP_KEYS.has(child.key)) {
      diagnostics.push({
        line: child.line,
        severity: "warning",
        message: `Ignored unknown step key \`${child.key}\``,
      });
    }
  }

  const rawId = childValue(entry, "id")?.value ?? "";
  const id = rawId === "" ? `step-${index + 1}` : rawId;
  if (rawId === "") {
    diagnostics.push({ line: entry.line, severity: "error", message: "Step has no `id`" });
  }

  const rawHarness = childValue(entry, "harness");
  let harnessId: LabHarnessId = "claude-code";
  if (rawHarness === undefined) {
    diagnostics.push({ line: entry.line, severity: "error", message: `\`${id}\` has no harness` });
  } else if ((LAB_HARNESS_IDS as readonly string[]).includes(rawHarness.value)) {
    harnessId = rawHarness.value as LabHarnessId;
  } else {
    diagnostics.push({
      line: rawHarness.line,
      severity: "error",
      message: `Unknown harness \`${rawHarness.value}\``,
    });
  }

  const runtime = defaultRuntime(harnessId);
  const adapter = HARNESS_ADAPTERS[harnessId];

  const model = childValue(entry, "model")?.value;
  if (model !== undefined && model !== "") runtime.model = unquote(model);

  // A dial an adapter does not have is a real mistake worth naming, not a value
  // to quietly keep: `effort` on cursor-agent means the file's author believes
  // in a flag that does not exist.
  const effort = childValue(entry, "effort");
  if (effort !== undefined) {
    if (adapter.effort === null) {
      diagnostics.push({
        line: effort.line,
        severity: "warning",
        message: `${adapter.label} has no effort dial — ignored`,
      });
    } else if (adapter.effort.options.some((option) => option.value === effort.value)) {
      runtime.effort = effort.value;
    } else {
      diagnostics.push({
        line: effort.line,
        severity: "error",
        message: `\`${effort.value}\` is not one of ${adapter.label}'s efforts`,
      });
    }
  }

  const approvals = childValue(entry, "approvals");
  if (approvals !== undefined) {
    if (adapter.approvals === null) {
      diagnostics.push({
        line: approvals.line,
        severity: "warning",
        message: `${adapter.label} gates nothing — \`approvals\` ignored`,
      });
    } else if (adapter.approvals.options.some((option) => option.value === approvals.value)) {
      runtime.approvals = approvals.value;
    } else {
      diagnostics.push({
        line: approvals.line,
        severity: "error",
        message: `\`${approvals.value}\` is not one of ${adapter.label}'s approval modes`,
      });
    }
  }

  const rawMode = childValue(entry, "mode");
  let mode: AuthoringMode = "prose";
  if (rawMode !== undefined) {
    if (rawMode.value === "prose" || rawMode.value === "placeholders") {
      mode = rawMode.value;
    } else {
      diagnostics.push({
        line: rawMode.line,
        severity: "error",
        message: `\`mode\` is prose or placeholders, not \`${rawMode.value}\``,
      });
    }
  }

  const rawAlso = childValue(entry, "also");
  let join: StepJoin = "then";
  if (rawAlso !== undefined) {
    if (rawAlso.value === "true" || rawAlso.value === "false") {
      join = rawAlso.value === "true" ? "with" : "then";
    } else {
      diagnostics.push({
        line: rawAlso.line,
        severity: "error",
        message: `\`also\` is true or false, not \`${rawAlso.value}\``,
      });
    }
    if (join === "with" && index === 0) {
      diagnostics.push({
        line: rawAlso.line,
        severity: "warning",
        message: `\`${id}\` is the first step — there is nothing above it to run alongside`,
      });
      join = "then";
    }
  }

  return { id, join, runtime, mode, instructions: "" };
}

/** Reads an automation file. Never throws — everything wrong becomes a diagnostic. */
export function parseAutomationFile(text: string, fallbackName = "Untitled"): ParsedAutomationFile {
  const diagnostics: FileDiagnostic[] = [];
  const normalised = text.replace(/\r\n/g, "\n");
  const lines = normalised.split("\n");

  if (lines[0]?.trim() !== "---") {
    diagnostics.push({ line: 1, severity: "error", message: "File must open with `---`" });
    return {
      automation: emptyAutomation(fallbackName, normalised.trim()),
      diagnostics,
    };
  }

  const closing = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (closing === -1) {
    diagnostics.push({ line: null, severity: "error", message: "Frontmatter is never closed" });
    return { automation: emptyAutomation(fallbackName, ""), diagnostics };
  }

  const front = readEntries(lines.slice(1, closing), 2, diagnostics);
  const body = lines.slice(closing + 1).join("\n");

  const known = new Set(["name", "scope", "on", "steps"]);
  for (const entry of front) {
    if (!known.has(entry.key)) {
      diagnostics.push({
        line: entry.line,
        severity: "warning",
        message: `Ignored unknown key \`${entry.key}\``,
      });
    }
  }

  const nameEntry = front.find((entry) => entry.key === "name");
  const name = unquote(nameEntry?.value ?? "");
  if (name === "") {
    diagnostics.push({ line: nameEntry?.line ?? null, severity: "error", message: "No `name`" });
  }

  const scopeValue = front.find((entry) => entry.key === "scope")?.value ?? "project";
  let scope: AutomationScope = "project";
  if (scopeValue === "global" || scopeValue === "project") {
    scope = scopeValue;
  } else {
    diagnostics.push({
      line: front.find((entry) => entry.key === "scope")?.line ?? null,
      severity: "error",
      message: "`scope` is global or project",
    });
  }

  const trigger = readTrigger(
    front.find((entry) => entry.key === "on"),
    diagnostics,
  );

  const stepsEntry = front.find((entry) => entry.key === "steps");
  const items = stepsEntry?.children.filter((child) => child.item) ?? [];
  if (items.length === 0) {
    diagnostics.push({ line: stepsEntry?.line ?? null, severity: "error", message: "No `steps`" });
  }

  const steps = items.map((item, index) => readStep(item, index, diagnostics));

  for (const [index, step] of steps.entries()) {
    if (steps.findIndex((other) => other.id === step.id) !== index) {
      diagnostics.push({
        line: items[index].line,
        severity: "error",
        message: `Duplicate step id \`${step.id}\``,
      });
    }
  }

  attachInstructions(steps, body, diagnostics);
  return {
    automation: { id: `atm-${slugify(name || fallbackName)}`, scope, name, trigger, steps },
    diagnostics,
  };
}

function attachInstructions(
  steps: AutomationStep[],
  body: string,
  diagnostics: FileDiagnostic[],
): void {
  const sections = readSections(body);

  if (sections === null) {
    // No headings: the body is the prompt. Only legible when there is one step
    // to give it to.
    if (steps.length > 1) {
      diagnostics.push({
        line: null,
        severity: "error",
        message: `${steps.length} steps but no \`## <id>\` sections — only the first gets a prompt`,
      });
    }
    if (steps.length > 0) steps[0].instructions = body.trim();
    return;
  }

  for (const step of steps) {
    const found = sections.get(step.id);
    if (found === undefined) {
      diagnostics.push({
        line: null,
        severity: "warning",
        message: `\`${step.id}\` has no \`## ${step.id}\` section — it would run with no prompt`,
      });
      continue;
    }
    step.instructions = found;
  }

  for (const id of sections.keys()) {
    if (!steps.some((step) => step.id === id)) {
      diagnostics.push({
        line: null,
        severity: "warning",
        message: `\`## ${id}\` matches no step — its prose is unused`,
      });
    }
  }
}

function emptyAutomation(name: string, instructions: string): Automation {
  return {
    id: `atm-${slugify(name)}`,
    scope: "project",
    name,
    trigger: { kind: "enters-column", columns: [] },
    steps: [
      {
        id: "claude-code",
        join: "then",
        runtime: defaultRuntime("claude-code"),
        mode: "prose",
        instructions,
      },
    ],
  };
}

/* ------------------------------------------------------------- writing */

/**
 * The file this automation is. Round-trips: `parse(format(a))` yields `a`.
 *
 * Everything defaulted is omitted rather than written out. A file that spells
 * every key including the ones matching the default reads like machine output,
 * and the point of a text format is that a person opens it, sees four lines, and
 * believes they could have typed them.
 */
export function formatAutomationFile(automation: Automation): string {
  const lines: string[] = ["---", `name: ${automation.name}`];
  if (automation.scope !== "project") lines.push(`scope: ${automation.scope}`);

  lines.push("on:");
  const key = TRIGGER_FILE_KEYS[automation.trigger.kind];
  if (automation.trigger.kind === "manual") {
    lines.push(`  ${key}:`);
  } else {
    lines.push(`  ${key}: [${automation.trigger.columns.join(", ")}]`);
  }

  lines.push("steps:");
  for (const [index, step] of automation.steps.entries()) {
    const adapter = HARNESS_ADAPTERS[step.runtime.harnessId];
    lines.push(`  - id: ${step.id}`);
    // Directly under the id, because it is the one key that is about where the
    // step sits rather than about how it runs.
    if (index > 0 && step.join === "with") lines.push(`    also: true`);
    lines.push(`    harness: ${step.runtime.harnessId}`);
    lines.push(`    model: ${step.runtime.model}`);
    if (adapter.effort !== null && step.runtime.effort !== null) {
      lines.push(`    effort: ${step.runtime.effort}`);
    }
    if (adapter.approvals !== null && step.runtime.approvals !== null) {
      lines.push(`    approvals: ${step.runtime.approvals}`);
    }
    if (step.mode !== "prose") lines.push(`    mode: ${step.mode}`);
  }

  lines.push("---", "");

  const steps = automation.steps;
  if (steps.length === 1) {
    lines.push(steps[0].instructions.trim(), "");
  } else {
    for (const step of steps) {
      lines.push(`## ${step.id}`, "", step.instructions.trim(), "");
    }
  }

  return lines.join("\n");
}

/* --------------------------------------------------------------- paths */

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "untitled"
  );
}

/**
 * Where the file lives.
 *
 * Project automations sit in the repo so they travel with it and get reviewed
 * like anything else; global ones sit in the user's config dir because they are
 * not a fact about any one codebase.
 *
 * NOTE, and it is load-bearing: `.volli/` today writes itself a `.gitignore`
 * containing `*` ({@link VOLLI_GITIGNORE_CONTENT}), so nothing under it is
 * committed. A format whose entire argument is "check this in" cannot live
 * under a directory that ignores itself — shipping this means that gitignore
 * grows an `!automations/` exception, or automations move out of `.volli`
 * entirely. Flagged here rather than fixed, because that constant is read by
 * main-process code on another branch.
 */
export function automationFilePath(automation: Automation): string {
  const file = `${slugify(automation.name)}.md`;
  return automation.scope === "global"
    ? `~/.config/volli/automations/${file}`
    : `.volli/automations/${file}`;
}
