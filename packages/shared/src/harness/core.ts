import { isFirstClassHarnessId } from "../ticket";
import type { FirstClassHarnessId, HarnessId } from "../ticket";
import { claudeCodeAdapter } from "./claude-code";
import { codexAdapter } from "./codex";
import { cursorAdapter } from "./cursor";
import { opencodeAdapter } from "./opencode";
import { VOLLI_CLI_REFERENCE, VOLLI_ORCHESTRATION, VOLLI_SKILL } from "./skill-content";
import type { HarnessAdapter, InstallAction } from "./types";

const adapters: Record<FirstClassHarnessId, HarnessAdapter> = {
  "claude-code": claudeCodeAdapter,
  codex: codexAdapter,
  cursor: cursorAdapter,
  opencode: opencodeAdapter,
};

/**
 * The adapter for `id`, or `undefined` when nothing is registered under it.
 * {@link HarnessId} is open (bring-your-own harnesses), so a lookup can miss —
 * callers fall back to the Declared tier rather than assuming a first-class
 * adapter exists.
 */
export function getHarnessAdapter(id: HarnessId): HarnessAdapter | undefined {
  return isFirstClassHarnessId(id) ? adapters[id] : undefined;
}

/** Every first-class harness adapter, for registry-driven iteration (detection, etc.). */
export const harnessAdapters: readonly HarnessAdapter[] = Object.values(adapters);

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
    const adapter = getHarnessAdapter(id);
    if (adapter) actions.push(...adapter.installActions(home, canonical));
  }
  return actions;
}

export type { HarnessAdapter, InstallAction } from "./types";
