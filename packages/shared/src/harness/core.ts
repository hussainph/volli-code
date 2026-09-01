import type { HarnessId } from "../ticket";
import { claudeCodeAdapter } from "./claude-code";
import { codexAdapter } from "./codex";
import { cursorAdapter } from "./cursor";
import { opencodeAdapter } from "./opencode";
import { genericHarnessActions } from "./generic";
import {
  VOLLI_CHANGES,
  VOLLI_CLI_REFERENCE,
  VOLLI_COMMAND_DOC,
  VOLLI_CONCEPTS,
  VOLLI_ORCHESTRATION,
  VOLLI_PLUGIN_DOC,
  VOLLI_SKILL,
} from "./skill-content";
import type { FenceComment, HarnessAdapter, InstallAction } from "./types";

/**
 * The adapter registry. A `ReadonlyMap` rather than a `Record<HarnessId, …>`,
 * which an open {@link HarnessId} can no longer express — and shouldn't: a
 * registered harness joins this map at runtime exactly the way a built-in sits
 * in it, which is the point of adapters being pure data.
 */
const adapters: ReadonlyMap<HarnessId, HarnessAdapter> = new Map(
  [claudeCodeAdapter, codexAdapter, cursorAdapter, opencodeAdapter].map((adapter) => [
    adapter.id,
    adapter,
  ]),
);

/**
 * The adapter for `id`, or `undefined` when nothing is registered under it.
 * {@link HarnessId} is open (bring-your-own harnesses), so a lookup can miss —
 * callers fall back to the Declared tier rather than assuming a first-class
 * adapter exists.
 */
export function getHarnessAdapter(id: HarnessId): HarnessAdapter | undefined {
  return adapters.get(id);
}

/** Every first-class harness adapter, for registry-driven iteration (detection, etc.). */
export const harnessAdapters: readonly HarnessAdapter[] = [...adapters.values()];

/**
 * The begin/end markers a fenced managed block wears, per comment syntax. One
 * table, consumed by the merge below, by {@link fencedBody}'s end-marker scan,
 * and — through {@link fencedBlockPattern} — by the installer's uninstall
 * excision (`harness-install.ts`), so the sites that have to recognize the same
 * block cannot drift apart.
 */
const FENCE_MARKERS: Record<FenceComment, { begin(version: number): string; end: string }> = {
  html: { begin: (version) => `<!-- volli:begin v=${version} -->`, end: "<!-- volli:end -->" },
  hash: { begin: (version) => `# volli:begin v=${version}`, end: "# volli:end" },
};

const FENCE_PATTERNS: Record<FenceComment, { block: string; begin: string }> = {
  html: {
    block: "<!-- volli:begin v=\\d+ -->[\\s\\S]*?<!-- volli:end -->",
    begin: "<!-- volli:begin v=\\d+ -->",
  },
  hash: {
    block: "# volli:begin v=\\d+[\\s\\S]*?# volli:end",
    begin: "# volli:begin v=\\d+ *",
  },
};

/** Matches one whole fenced block, markers included. Fresh per call — no shared state. */
export function fencedBlockPattern(comment: FenceComment = "html"): RegExp {
  return new RegExp(FENCE_PATTERNS[comment].block);
}

const CR = 0x0d;
const LF = 0x0a;

/** Index just past one optional `\r?\n` line ending at `index`. */
function skipLineEnding(text: string, index: number): number {
  let i = index;
  if (text.charCodeAt(i) === CR) i += 1;
  if (text.charCodeAt(i) === LF) i += 1;
  return i;
}

/**
 * `text` without its trailing run of `\n`.
 *
 * By index, because `/\n+$/` is quadratic on a file that is blank lines
 * followed by anything else (CodeQL js/polynomial-redos, alert 2): `\n+` runs
 * to the end of the blank prefix, `$` fails on the first real character, and
 * the whole walk repeats from the next newline — 23 seconds on 80k of them.
 * An instructions file is local and the user's own, so that was a
 * hang-your-own-app risk rather than a remote one.
 */
function withoutTrailingNewlines(text: string): string {
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === LF) end -= 1;
  return text.slice(0, end);
}

/** Index where one optional `\r?\n` line ending ending at `end` starts, never below `min`. */
function lineEndingStart(text: string, end: number, min: number): number {
  let i = end;
  if (i > min && text.charCodeAt(i - 1) === LF) i -= 1;
  if (i > min && text.charCodeAt(i - 1) === CR) i -= 1;
  return i;
}

/**
 * The body of the first fenced block in `content` — what sits between the two
 * markers, minus one line ending adjacent to each — or null when `content`
 * carries no complete block.
 *
 * Tolerates CRLF and a missing newline next to either marker: a strict `\n`
 * requirement makes the body null on Windows-edited or
 * trailing-newline-stripped files, which fails the hash guard open (null →
 * "write" → silent overwrite of a user's edits).
 *
 * Index arithmetic rather than one `BEGIN\r?\n?(body)\r?\n?END` regex: there,
 * an optional line ending and the lazy body can each claim the same newline,
 * and that ambiguity backtracks quadratically over a newline-heavy file whose
 * end marker is missing (CodeQL js/polynomial-redos). A managed file is local
 * and the user's own, so that was a hang-your-own-app risk rather than a remote
 * one — but scanning is linear and states the tolerance instead of implying it.
 */
export function fencedBody(content: string, comment: FenceComment = "html"): string | null {
  const begin = new RegExp(FENCE_PATTERNS[comment].begin).exec(content);
  if (begin === null) return null;
  const bodyStart = skipLineEnding(content, begin.index + begin[0].length);
  const end = content.indexOf(FENCE_MARKERS[comment].end, bodyStart);
  if (end === -1) return null;
  return content.slice(bodyStart, lineEndingStart(content, end, bodyStart));
}

export function mergeFencedSection(
  current: string,
  managedBody: string,
  version: number,
  comment: FenceComment = "html",
): { content: string; changed: boolean } {
  const markers = FENCE_MARKERS[comment];
  const block = `${markers.begin(version)}\n${managedBody}\n${markers.end}`;
  const managedPattern = fencedBlockPattern(comment);
  const unmanaged = withoutTrailingNewlines(current);
  // Function-form replacement so `$$`, `$&`, `$1`, … inside the managed body are
  // inserted literally instead of being interpreted as replacement patterns.
  const content = managedPattern.test(current)
    ? current.replace(managedPattern, () => block)
    : `${unmanaged.length > 0 ? `${unmanaged}\n\n` : ""}${block}\n`;
  return { content, changed: content !== current };
}

export type ManagedWriteDecision = "write" | "skip" | "conflict";

export function managedWriteDecision(input: {
  currentHash: string | null;
  recordedHash: string | null;
  desiredHash: string;
}): ManagedWriteDecision {
  if (input.currentHash === input.desiredHash) return "skip";
  if (input.currentHash === null || input.currentHash === input.recordedHash) return "write";
  return "conflict";
}

/** Stands in for the user's home directory in a {@link HarnessSurfaces} path. */
export const HOME_TOKEN = "{home}";

/** The canonical skill files every plan opens with, before any per-harness surface. */
export const CANONICAL_SKILL_FILES = 6;

function normalizedHome(home: string): string {
  return home.endsWith("/") ? home.slice(0, -1) : home;
}

function resolved(template: string, home: string): string {
  return template.replaceAll(HOME_TOKEN, home);
}

/**
 * The baseline assets a set of adapters earns, folded out of the surfaces each
 * one declares — no identity anywhere, so a manifest-registered harness gets
 * exactly what a built-in with the same surfaces gets.
 *
 * A harness receives the skill pack once: by symlink into its skills directory
 * when it reads one, and otherwise as a slash-command doc, which is the only
 * route left for a harness that has commands but no skills. An instructions
 * file earns the fenced managed block on top, and two harnesses naming the
 * same file share one action rather than fighting over it.
 *
 * Every path here lands in the USER's dotfiles, so a registered manifest's
 * surfaces must be validated before they reach this fold — the rule is about
 * which paths a manifest may claim, not about which adapters are built in.
 */
export function harnessBaselineActions(input: {
  home: string;
  adapters: readonly HarnessAdapter[];
}): InstallAction[] {
  const home = normalizedHome(input.home);
  const canonical = `${home}/.agents/skills/volli`;
  const byPath = new Map<string, InstallAction>();
  const claim = (action: InstallAction): void => {
    if (!byPath.has(action.path)) byPath.set(action.path, action);
  };

  for (const adapter of input.adapters) {
    const { skillsDir, commandsDir, instructionsFile } = adapter.surfaces;
    if (skillsDir) {
      claim({
        kind: "symlink",
        path: `${resolved(skillsDir, home)}/volli`,
        target: canonical,
        managed: true,
      });
    } else if (commandsDir) {
      claim({
        kind: "write",
        path: `${resolved(commandsDir, home)}/volli.md`,
        content: VOLLI_COMMAND_DOC,
        managed: true,
      });
    }
    if (instructionsFile) {
      for (const action of genericHarnessActions(resolved(instructionsFile, home))) claim(action);
    }
  }
  return [...byPath.values()];
}

/**
 * The canonical skill pack plus every surface `adapters` earns.
 *
 * Adapters, not ids — a plan built from ids can only ever mean the built-ins,
 * because an id is resolved through a registry that a registered manifest is
 * not in and (by design, see {@link getHarnessAdapter}) cannot join. Taking the
 * adapters makes the caller name the set, which is the only place that knows
 * whether a manifest has been registered AND trusted; it also puts this
 * function on the same footing as {@link harnessBaselineActions}, which has
 * been identity-free from the start.
 *
 * The caller owes this the home-containment guarantee: every path below lands
 * in the user's dotfiles, and a registered manifest's surfaces are only safe
 * here because they were validated at parse time.
 */
export function buildHarnessInstallPlan(input: {
  home: string;
  adapters: readonly HarnessAdapter[];
}): InstallAction[] {
  if (input.adapters.length === 0) return [];
  const home = normalizedHome(input.home);
  const canonical = `${home}/.agents/skills/volli`;
  return [
    { kind: "write", path: `${canonical}/SKILL.md`, content: VOLLI_SKILL, managed: true },
    { kind: "write", path: `${canonical}/cli.md`, content: VOLLI_CLI_REFERENCE, managed: true },
    { kind: "write", path: `${canonical}/concepts.md`, content: VOLLI_CONCEPTS, managed: true },
    { kind: "write", path: `${canonical}/changes.md`, content: VOLLI_CHANGES, managed: true },
    {
      kind: "write",
      path: `${canonical}/orchestration.md`,
      content: VOLLI_ORCHESTRATION,
      managed: true,
    },
    { kind: "write", path: `${canonical}/plugin.md`, content: VOLLI_PLUGIN_DOC, managed: true },
    ...harnessBaselineActions({ home, adapters: input.adapters }),
  ];
}

export * from "./types";
