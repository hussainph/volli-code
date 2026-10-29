import { existsSync } from "node:fs";
import type { MachinePathReader } from "../machine-paths";
import type { RunnerPathRegistry } from "./paths";

/** Read-only projections for Files, MCP discovery and working-copy/git reads. */
export function cloudMachinePaths(options: {
  registry(): RunnerPathRegistry | null;
  ticketDisplayIdOf(ticketId: string): string | null;
}): MachinePathReader {
  return {
    kind: "cloud",
    projectPath(projectId) {
      const checkout = options.registry()?.checkouts.ofProject(projectId);
      return checkout !== null && checkout !== undefined && existsSync(checkout.absPath)
        ? checkout.absPath
        : null;
    },
    ticket(ticketId) {
      const registry = options.registry();
      const located = registry?.workingCopies.ofTicket(ticketId);
      if (registry == null || located == null) return null;
      const { projectId, copy } = located;
      // Project the registered copy, not a Session birth hint: several Sessions
      // can disagree about checkout mode. As in local mode, a retained isolated
      // copy stays the ticket-scoped read target even while a shared Session
      // runs in Main. Session tools use their own prepared directory instead.
      // Registration/execution own collision validation; these read projections
      // must not realpath the entire registry synchronously on every file read.
      const usesWorktree = copy.kind === "worktree";
      return {
        projectId,
        displayId: options.ticketDisplayIdOf(ticketId) ?? ticketId,
        usesWorktree,
        worktreePath: usesWorktree ? copy.absPath : null,
        branch: copy.branch,
        baseBranch: copy.baseBranch,
      };
    },
  };
}
