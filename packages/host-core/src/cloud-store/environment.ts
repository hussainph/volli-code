/** Machine-only environment preparation for a cloud Working copy. No board writes. */
import { displayTicketId } from "@volli/shared";

import type { PowerPort } from "../ports/power";
import { runGitCapturingAsync } from "../worktree/git";
import { setPhase } from "../worktree/phase";
import { runWorktreeResume, watchRunnerWakes } from "../worktree/resume-exec";
import { runPendingWorktreeSetup } from "../worktree/setup-exec";
import type { WorktreePorts } from "../worktree/types";
import type { CloudSessionLocationOptions } from "./location";

export interface CloudEnvironmentPreparationOptions {
  /** Required by the existing runners' port bundle; neither runner reads or writes it here. */
  db: WorktreePorts["db"];
  home?: string;
  power?: PowerPort;
  onPhase?: WorktreePorts["onPhase"];
  /** The runner's scrubbed PATH/environment, including this Session's concurrency budget. */
  environment(sessionId: string): Promise<{ shellPath: string; env: Record<string, string> }>;
}

/**
 * Supplies the location resolver's prepareEnvironment callback. Always asks
 * setup, even when ensure did not see a pending marker: another start may be
 * running it, or a failed run may still gate this Working copy. The runners
 * retain their existing claims, process limits, output tails and wake epochs.
 */
export function createCloudEnvironmentPreparation(
  options: CloudEnvironmentPreparationOptions,
): NonNullable<CloudSessionLocationOptions["prepareEnvironment"]> {
  // The shared runners accept the full legacy bundle, although these paths use
  // only home and onPhase. In particular, replacing failure reporting below
  // keeps the SQLite ticket-event writer out of every cloud setup failure.
  const deps: WorktreePorts = {
    db: options.db,
    gitAsync: runGitCapturingAsync,
    blobsRoot: "",
    ...(options.home === undefined ? {} : { home: options.home }),
    ...(options.onPhase === undefined ? {} : { onPhase: options.onPhase }),
  };
  return async ({ request, facts, directory }) => {
    const ticket = facts.ticket;
    // Like the local resolver, only an isolated worktree owes these steps.
    if (ticket === null || ticket.checkoutMode !== "worktree") return;
    const recipe = {
      projectId: facts.project.id,
      ticketDisplayId: displayTicketId(facts.ticketPrefix, ticket.number),
    };
    const environment = () => options.environment(request.sessionId);
    const setup = await runPendingWorktreeSetup(deps, {
      ticketId: ticket.id,
      worktreePath: directory,
      setupCommand: facts.project.setupCommand ?? null,
      environment,
      recipe,
      reportFailure: (ticketId) => setPhase(ticketId, "failed", deps.onPhase),
    });
    if (setup.kind === "failed") {
      throw new Error(`Couldn't prepare the worktree at ${directory} — ${setup.message}`);
    }
    if (options.power !== undefined) watchRunnerWakes(options.power);
    // Resume failures are recorded warnings, not setup gates.
    await runWorktreeResume(deps, {
      ticketId: ticket.id,
      worktreePath: directory,
      recipe,
      environment,
    });
  };
}
