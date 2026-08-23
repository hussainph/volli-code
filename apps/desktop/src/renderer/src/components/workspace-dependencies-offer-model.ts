/**
 * Whether to OFFER to install a project's dependencies, and with which command.
 *
 * The replacement for the dependency arm of `session-environment-alert-model.ts`
 * (VC-156). Adding a fresh scaffold project used to greet its owner with a red
 * "Sessions aren't ready for {project} — Dependencies are not installed. Run
 * npm install before starting a Session." Every part of that was wrong for the
 * situation: a checkout without `node_modules` is the expected state of a fresh
 * clone, nothing was broken, and the instruction was addressed to a human in an
 * app whose whole premise is that an agent does that sort of thing for you.
 *
 * So the fault surface loses the arm and this takes its place: one neutral
 * line, and the state's own remedy attached to it as an action. The agent hears
 * the same fact through its prompt (`RuntimeWorkspaceEnvironment`), which is
 * where it always belonged.
 *
 * A model rather than a `.tsx` condition because it is a decision about what a
 * person is told, the same class of thing `cli-status-model.ts` and the alert
 * model are, and it is enrolled in the coverage gate for the same reason.
 */
import type { CliToolStatus } from "../../../ipc/contract";

/** The offer, once there is one to make. */
export interface WorkspaceDependenciesOffer {
  /**
   * The command that installs THIS workspace, judged in main by the lockfile
   * beside its manifest. Never a hardcoded `npm install`, and never invented
   * here: the offer's whole value is that pressing it runs the right thing.
   */
  installCommand: string;
}

/**
 * The offer for a measured workspace, or `null` when there is nothing to
 * offer.
 *
 * Silent in every case but one, and each silence means something different:
 * `installed` and `null` dependencies are workspaces with nothing to do, a
 * dismissal is an answer already given (persisted, so it stays given), and a
 * missing install command is a measurement that cannot be acted on — an offer
 * whose button had no command would be a warning with extra steps, which is
 * precisely what this replaces.
 */
export function workspaceDependenciesOffer(
  status: Pick<CliToolStatus, "environment">,
  dismissed: boolean,
): WorkspaceDependenciesOffer | null {
  if (dismissed) return null;
  const { dependencies, installCommand } = status.environment.session;
  if (dependencies !== "absent" || installCommand === null) return null;
  return { installCommand };
}
