import type Database from "better-sqlite3";
import {
  attachmentsSectionInput,
  buildHarnessCommand,
  composeAttachmentsSection,
  worktreeOrientationPreamble,
} from "@volli/shared";
import { listAttachments } from "../db/attachments-repo";
import type { EnsureOutcome } from "../worktree";
import type { SessionScope } from "./scope";

/**
 * Composes the FIRST line a worktree ticket session writes to its shell, now
 * that `ensure` has resolved the worktree identity — or `null` when there is
 * nothing to launch (a bare worktree shell). The setup-sentinel gating around
 * this line (arming {@link createSetupRun}, the actual `pty.write`) stays in
 * {@link PtyManager.create}; this only builds the string.
 *
 * A resume writes its pre-built resume line verbatim (no orientation preamble —
 * the harness is picking up an existing session). Otherwise a kickoff composes
 * the harness command with the preamble now that the worktree identity is
 * resolved: `ensure` already materialized the ticket's attachments into this
 * worktree (CONCEPT decision #19), so the "## Attachments" section is re-derived
 * here — cheap, deterministic, no fs touch — rather than threading the
 * materialize output through EnsureOutcome.
 */
export function composeWorktreeLaunchCommand(
  db: Database.Database,
  worktree: NonNullable<SessionScope["worktree"]>,
  identity: EnsureOutcome["identity"],
  worktreeCwd: string,
): string | null {
  if (worktree.resumeCommand !== null) {
    return worktree.resumeCommand;
  }
  if (worktree.kickoff !== null) {
    const attachmentsSection = composeAttachmentsSection(
      attachmentsSectionInput(listAttachments(db, worktree.ticketId)),
    );
    const attachmentsSuffix = attachmentsSection.length > 0 ? `\n\n${attachmentsSection}` : "";
    const preamble = worktreeOrientationPreamble({
      worktreePath: worktreeCwd,
      branch: identity.branch ?? "",
      baseBranch: identity.baseBranch,
      projectPath: worktree.projectPath,
    });
    return buildHarnessCommand(
      worktree.kickoff.harnessId,
      `${preamble}\n\n${worktree.kickoff.prompt}${attachmentsSuffix}`,
    );
  }
  return null;
}
