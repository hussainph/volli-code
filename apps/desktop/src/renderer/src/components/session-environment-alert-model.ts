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
        "Both login-shell passes failed. Sessions are using the app's inherited PATH, so commands available in your terminal may not run here.",
    };
  }
  if (provenance === "probe-failed") {
    return {
      title: "Sessions couldn't read your login PATH",
      detail:
        "Sessions are using the app's inherited PATH. Commands available in your terminal may not run here.",
    };
  }
  if (interactiveProvenance === "probe-failed") {
    return {
      title: "Sessions couldn't read your interactive login PATH",
      detail:
        "Tools configured by your interactive shell, such as nvm or mise, may not be available in Sessions.",
    };
  }
  return null;
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
  const { dependencies, tools } = status.environment.session;
  const missingTools = SESSION_ENV_TOOLS.filter((tool) => tools[tool] === null);
  if (missingTools.length === 0 && dependencies !== "absent") return null;

  const details: string[] = [];
  if (missingTools.length > 0) {
    details.push(
      `Missing from the Session PATH: ${missingTools.join(", ")}. If they are installed, this is a PATH adoption failure.`,
    );
  }
  if (dependencies === "absent") {
    details.push("Dependencies are not installed. Run pnpm install before starting a Session.");
  }
  return { title: `Sessions aren't ready for ${project.name}`, detail: details.join(" ") };
}

/** One surface for launch failures and project-onboarding readiness facts. */
export function sessionEnvironmentAlert(
  status: Pick<CliToolStatus, "environment">,
  project: ProjectEnvironmentScope | null = null,
): SessionEnvironmentAlertState | null {
  const probe = probeFailure(status);
  const readiness = projectEnvironmentReadiness(status, project);
  if (probe === null) return readiness;
  if (readiness === null) return probe;
  return { ...probe, detail: `${probe.detail} ${readiness.detail}` };
}
