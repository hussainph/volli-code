import { isFirstClassHarnessId } from "../ticket";
import type { FirstClassHarnessId, HarnessId } from "../ticket";
import { claudeCodeAdapter } from "./claude-code";
import { codexAdapter } from "./codex";
import { cursorAdapter } from "./cursor";
import { opencodeAdapter } from "./opencode";
import {
  VOLLI_CLI_REFERENCE,
  VOLLI_OPENCODE_COMMAND,
  VOLLI_ORCHESTRATION,
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

/**
 * Per-harness baseline assets: real files under the user's own dotfiles, which
 * is why they are NOT adapter data. An adapter describes a harness; this table
 * describes what Volli writes, and only a built-in may write outside
 * Volli-owned directories (bring-your-own manifests may not).
 */
const BASELINE_ASSETS: Partial<
  Record<FirstClassHarnessId, (home: string, canonicalSkillPath: string) => InstallAction[]>
> = {
  "claude-code": (home, canonicalSkillPath) => [
    {
      kind: "symlink",
      path: `${home}/.claude/skills/volli`,
      target: canonicalSkillPath,
      managed: true,
    },
  ],
  opencode: (home) => [
    {
      kind: "write",
      path: `${home}/.config/opencode/command/volli.md`,
      content: VOLLI_OPENCODE_COMMAND,
      managed: true,
    },
  ],
};

function normalizedHome(home: string): string {
  return home.endsWith("/") ? home.slice(0, -1) : home;
}

export function buildHarnessInstallPlan(input: {
  home: string;
  detected: readonly HarnessId[];
}): InstallAction[] {
  if (input.detected.length === 0) return [];
  const home = normalizedHome(input.home);
  const canonical = `${home}/.agents/skills/volli`;
  const actions: InstallAction[] = [
    {
      kind: "write",
      path: `${canonical}/SKILL.md`,
      content: VOLLI_SKILL,
      managed: true,
    },
    {
      kind: "write",
      path: `${canonical}/cli.md`,
      content: VOLLI_CLI_REFERENCE,
      managed: true,
    },
    {
      kind: "write",
      path: `${canonical}/orchestration.md`,
      content: VOLLI_ORCHESTRATION,
      managed: true,
    },
  ];
  for (const id of new Set(input.detected)) {
    // A registered-but-unknown harness contributes no baseline assets: the
    // skill pack it can't host is exactly the tier it doesn't have.
    const assets = isFirstClassHarnessId(id) ? BASELINE_ASSETS[id] : undefined;
    actions.push(...(assets?.(home, canonical) ?? []));
  }
  return actions;
}

export * from "./types";
