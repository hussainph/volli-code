import type { CliToolStatus } from "../../../ipc/contract";

/** The one launch-wide fault a Session user must hear without opening Settings. */
export interface SessionEnvironmentAlertState {
  title: string;
  detail: string;
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
export function sessionEnvironmentAlert(
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
