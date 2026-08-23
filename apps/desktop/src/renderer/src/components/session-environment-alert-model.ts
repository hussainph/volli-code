import { SESSION_ENV_TOOLS } from "@volli/shared";
import type { CliToolStatus } from "../../../ipc/contract";

/**
 * The app-level faults a launch-wide banner is allowed to interrupt someone
 * for. A KIND, not a sentence: dismissal is stored against this word, so
 * rewording the copy never resurrects a notice the user has already put away,
 * and a fault of a different kind is never silenced by a dismissal that was
 * about something else (VC-159/R7).
 */
export type SessionEnvironmentFaultKind = "login-path-unreadable";

/** The one launch-wide fault a Session user must hear without opening Settings. */
export interface SessionEnvironmentAlertState {
  /**
   * The app fault this notice reports, or `null` for the project-readiness
   * notice — a project's own onboarding shortfall, not a fault of the app, and
   * dismissed for the view rather than durably.
   */
  fault: SessionEnvironmentFaultKind | null;
  title: string;
  detail: string;
}

/** The one project fact the shared alert needs; Configure owns future repair UI. */
export interface ProjectEnvironmentScope {
  name: string;
}

/** "git", "git and gh", "git, gh and node" — a sentence, never a CSV. */
function plainList(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * The genuine app-level fault, and only it (VC-159/R7).
 *
 * Two conditions, both required. BOTH login-shell passes failed — a boot
 * failure the later interactive pass recovered from left Sessions with a
 * working PATH, and a launch-wide banner about a repair that already happened
 * is noise. AND something a Session needs is consequently unresolvable: a
 * short PATH that still resolves every contract tool has cost the user
 * nothing they can see, so it belongs in Settings → CLI with the rest of the
 * evidence, not above their board.
 *
 * `pending` is not a failure (see `SessionEnvInteractiveProvenance`): the
 * second pass runs after the first window precisely so nothing waits on it.
 *
 * The copy names what a person lost, not how the app measured it. "Login-shell
 * passes", "adoption" and "provenance" are Settings → CLI and `volli doctor`
 * vocabulary; this sentence is somebody's first minute in the product.
 */
function loginPathFault(
  status: Pick<CliToolStatus, "environment">,
): SessionEnvironmentAlertState | null {
  const { provenance, interactiveProvenance, tools } = status.environment.session;
  if (provenance !== "probe-failed" || interactiveProvenance !== "probe-failed") return null;
  const missing = SESSION_ENV_TOOLS.filter((tool) => tools[tool] === null);
  if (missing.length === 0) return null;
  return {
    fault: "login-path-unreadable",
    title: "Volli couldn't read your terminal's PATH",
    detail: `Sessions can't find ${plainList(missing)}, so some commands may be missing. Fix now asks your terminal again — Sessions you start afterwards get the result.`,
  };
}

/**
 * The project readiness sentence: what was measured, plus the one step it
 * implies. `null` when the project has nothing missing.
 */
function readinessDetail(status: Pick<CliToolStatus, "environment">): string | null {
  const { dependencies, tools, installCommand } = status.environment.session;
  const missingTools = SESSION_ENV_TOOLS.filter((tool) => tools[tool] === null);
  if (missingTools.length === 0 && dependencies !== "absent") return null;

  const toolsFact =
    missingTools.length > 0 ? `Missing from the Session PATH: ${missingTools.join(", ")}.` : null;
  // No CLI incantation: a first-run reader is pointed at the door that holds
  // the evidence and the repair button, not handed a command to type.
  const toolsRemedy =
    missingTools.length > 0
      ? "If they are installed, open Settings → CLI to repair the Session PATH."
      : null;
  // The workspace's own install command, judged by its lockfile in main; a
  // bare manifest belongs to npm. Never a hardcoded pnpm for a yarn workspace.
  const dependenciesFact =
    dependencies === "absent"
      ? `Dependencies are not installed. Run ${installCommand ?? "npm install"} before starting a Session.`
      : null;

  return [toolsFact, toolsRemedy, dependenciesFact].filter((part) => part !== null).join(" ");
}

/**
 * The project-onboarding half of the shared alert.
 *
 * It deliberately returns facts and copy rather than a Configure pane: VC-109
 * owns the project's Git/repair surface. This is its hand-off seam — the add
 * flow can warn now, and Configure can later reuse the exact same report.
 */
export function projectEnvironmentReadiness(
  status: Pick<CliToolStatus, "environment">,
  project: ProjectEnvironmentScope | null,
): SessionEnvironmentAlertState | null {
  if (project === null) return null;
  const detail = readinessDetail(status);
  if (detail === null) return null;
  return { fault: null, title: `Sessions aren't ready for ${project.name}`, detail };
}

/**
 * One notice at a time, and the app fault outranks the project's readiness.
 *
 * They are not merged any more (VC-159): the fault already explains why those
 * tools are unreachable, and a banner that appends a second diagnosis to the
 * first is how the error budget was spent in the first place. When the fault
 * clears — repaired, or dismissed and gone on the next measurement — whatever
 * the project still lacks surfaces on its own.
 */
export function sessionEnvironmentAlert(
  status: Pick<CliToolStatus, "environment">,
  project: ProjectEnvironmentScope | null = null,
): SessionEnvironmentAlertState | null {
  return loginPathFault(status) ?? projectEnvironmentReadiness(status, project);
}
