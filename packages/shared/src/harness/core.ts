import type { HarnessId } from "../ticket";
import { claudeCodeAdapter } from "./claude-code";
import { codexAdapter } from "./codex";
import { cursorAdapter } from "./cursor";
import { opencodeAdapter } from "./opencode";
import { genericHarnessActions } from "./generic";
import {
  VOLLI_CLI_REFERENCE,
  VOLLI_COMMAND_DOC,
  VOLLI_ORCHESTRATION,
  VOLLI_PLUGIN_DOC,
  VOLLI_SKILL,
} from "./skill-content";
import type { HarnessAdapter, InstallAction } from "./types";

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

export function mergeFencedSection(
  current: string,
  managedBody: string,
  version: number,
): { content: string; changed: boolean } {
  const block = `<!-- volli:begin v=${version} -->\n${managedBody}\n<!-- volli:end -->`;
  const managedPattern = /<!-- volli:begin v=\d+ -->[\s\S]*?<!-- volli:end -->/;
  const unmanaged = current.replace(/\n+$/, "");
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
export const CANONICAL_SKILL_FILES = 4;

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

export function buildHarnessInstallPlan(input: {
  home: string;
  detected: readonly HarnessId[];
}): InstallAction[] {
  if (input.detected.length === 0) return [];
  const home = normalizedHome(input.home);
  const canonical = `${home}/.agents/skills/volli`;
  const detected = [...new Set(input.detected)]
    .map((id) => getHarnessAdapter(id))
    .filter((adapter) => adapter !== undefined);
  return [
    { kind: "write", path: `${canonical}/SKILL.md`, content: VOLLI_SKILL, managed: true },
    { kind: "write", path: `${canonical}/cli.md`, content: VOLLI_CLI_REFERENCE, managed: true },
    {
      kind: "write",
      path: `${canonical}/orchestration.md`,
      content: VOLLI_ORCHESTRATION,
      managed: true,
    },
    { kind: "write", path: `${canonical}/plugin.md`, content: VOLLI_PLUGIN_DOC, managed: true },
    ...harnessBaselineActions({ home, adapters: detected }),
  ];
}

export * from "./types";
