import type { HarnessId } from "../ticket";
import { claudeCodeAdapter } from "./claude-code";
import { codexAdapter } from "./codex";
import { opencodeAdapter } from "./opencode";
import { VOLLI_CLI_REFERENCE, VOLLI_ORCHESTRATION, VOLLI_SKILL } from "./skill-content";
import type { HarnessAdapter, InstallAction } from "./types";

const adapters: Record<HarnessId, HarnessAdapter> = {
  "claude-code": claudeCodeAdapter,
  codex: codexAdapter,
  opencode: opencodeAdapter,
};

export function getHarnessAdapter(id: HarnessId): HarnessAdapter {
  return adapters[id];
}

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
    actions.push(...adapters[id].installActions(home, canonical));
  }
  return actions;
}

export type { HarnessAdapter, InstallAction } from "./types";
