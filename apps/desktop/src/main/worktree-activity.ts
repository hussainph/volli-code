import type { BackgroundShellHost } from "@volli/host-core/shell/background-shell-host";
import {
  agentTurnOpenWithin,
  liveShellWorktreeSites,
  type AgentSiteRuntime,
  type BusyWorktreeSite,
  type BusyWorktreeSites,
} from "@volli/host-core/worktree";

/** One live supplier for desktop's manual and automatic worktree guards. */
export function createDesktopBusyWorktreeSites(deps: {
  terminalCwds: () => readonly string[];
  shells: Pick<BackgroundShellHost, "liveCwds">;
  runtime: () => Pick<AgentSiteRuntime, "openNativeBindings" | "projection"> | null;
  onUnreadable: (sessionId: string, error: unknown) => void;
}): BusyWorktreeSites {
  return async (target) => {
    const sites: BusyWorktreeSite[] = [
      ...deps.terminalCwds().map((directory) => ({ directory, surface: "terminal" as const })),
      ...liveShellWorktreeSites(deps.shells),
    ];
    const runtime = deps.runtime();
    if (runtime === null) return sites;
    const turnOpen = await agentTurnOpenWithin(runtime, target, deps.onUnreadable);
    return turnOpen ? [...sites, { directory: target, surface: "agent" }] : sites;
  };
}
