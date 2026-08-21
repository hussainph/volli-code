import { SESSION_ENV_TOOLS } from "@volli/shared";
import type { CliToolStatus } from "../../../ipc/contract";

/** The one launch-wide fault a Session user must hear without opening Settings. */
export interface SessionEnvironmentAlertState {
  title: string;
  detail: string;
}

/** The one project fact the shared alert needs; Configure owns future repair UI. */
export interface ProjectEnvironmentScope {
  name: string;
}

/**
 * The one recovery sentence, stated exactly once per alert. Plain words, no
 * backticks: this detail renders as prose, so markup arrives verbatim.
 */
const PATH_REPAIR_HINT =
  "Run volli doctor --fix to re-run PATH adoption for new Sessions; this running Session keeps its startup environment.";

/**
 * A PATH probe failure is an app-level fault, not a Settings-only detail.
 *
 * The boot pass matters even when the later interactive pass recovered: it
 * records that this launch could not make the original, safe adoption. The
 * alert keeps that fact visible for the launch instead of replacing it with a
 * lucky later outcome and recreating the "healthy screen, broken Session"
 * failure this work exists to prevent.
 */
function probeFailure(
  status: Pick<CliToolStatus, "environment">,
): SessionEnvironmentAlertState | null {
  const { provenance, interactiveProvenance } = status.environment.session;
  if (provenance === "probe-failed" && interactiveProvenance === "probe-failed") {
    return {
      title: "Sessions couldn't read your login PATH",
      detail:
        "Both login-shell passes failed. Sessions are using the app's inherited PATH, so commands available in your terminal may not run here. " +
        PATH_REPAIR_HINT,
    };
  }
  if (provenance === "probe-failed") {
    return {
      title: "Sessions couldn't read your login PATH",
      detail:
        "Sessions are using the app's inherited PATH. Commands available in your terminal may not run here. " +
        PATH_REPAIR_HINT,
    };
  }
  if (interactiveProvenance === "probe-failed") {
    return {
      title: "Sessions couldn't read your interactive login PATH",
      detail:
        "Tools configured by your interactive shell, such as nvm or mise, may not be available in Sessions. " +
        PATH_REPAIR_HINT,
    };
  }
  return null;
}

/**
 * The project readiness shortfalls, split so the combined alert can state
 * every fact once and the repair once: `facts` carries only what was
 * measured, `detail` adds the repair hint the facts imply — the standalone
 * copy. The combined alert appends `facts` to a probe failure whose detail
 * already ends in the same hint, which is what keeps "run volli doctor
 * --fix" from appearing twice in one notice (VC-94 review).
 */
interface ProjectReadinessParts {
  facts: string;
  detail: string;
}

function readinessParts(status: Pick<CliToolStatus, "environment">): ProjectReadinessParts | null {
  const { dependencies, tools, installCommand } = status.environment.session;
  const missingTools = SESSION_ENV_TOOLS.filter((tool) => tools[tool] === null);
  if (missingTools.length === 0 && dependencies !== "absent") return null;

  const toolsFact =
    missingTools.length > 0 ? `Missing from the Session PATH: ${missingTools.join(", ")}.` : null;
  const toolsRemedy =
    missingTools.length > 0
      ? "If they are installed, run volli doctor --fix to re-run PATH adoption for new Sessions."
      : null;
  // The workspace's own install command, judged by its lockfile in main; a
  // bare manifest belongs to npm. Never a hardcoded pnpm for a yarn workspace.
  const dependenciesFact =
    dependencies === "absent"
      ? `Dependencies are not installed. Run ${installCommand ?? "npm install"} before starting a Session.`
      : null;

  return {
    facts: [toolsFact, dependenciesFact].filter((part) => part !== null).join(" "),
    detail: [toolsFact, toolsRemedy, dependenciesFact].filter((part) => part !== null).join(" "),
  };
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
  const parts = readinessParts(status);
  if (parts === null) return null;
  return { title: `Sessions aren't ready for ${project.name}`, detail: parts.detail };
}

/** One surface for launch failures and project-onboarding readiness facts. */
export function sessionEnvironmentAlert(
  status: Pick<CliToolStatus, "environment">,
  project: ProjectEnvironmentScope | null = null,
): SessionEnvironmentAlertState | null {
  const probe = probeFailure(status);
  if (probe === null) return projectEnvironmentReadiness(status, project);
  const parts = project === null ? null : readinessParts(status);
  if (parts === null) return probe;
  // One notice, every fact once: the probe detail already ends with the
  // repair hint, so the readiness half contributes only its measurements.
  return { ...probe, detail: `${probe.detail} ${parts.facts}` };
}
