/**
 * Cloud-only Mac login policy. Electron 44 reports `wasOpenedAtLogin` from the
 * launch Apple Event (the modern-macOS path); main uses that signal to enter
 * the menu bar without showing a window. Login arguments are Windows-only.
 * Dev builds never register Electron itself as a login item.
 */
import { runnerStaysAvailable } from "@volli/shared";

/** Explicit hidden launch, also used by isolated acceptance fixtures. */
export const RUNNER_LOGIN_ITEM_ARG = "--hidden";

export interface RunnerLoginItemSettings {
  openAtLogin: boolean;
}

export interface RunnerLoginItemLaunch {
  cloud: boolean;
  platform: string;
  packaged: boolean;
}

/** Local launches leave even manually-added login items untouched. */
export function runnerLoginItemSettings(
  launch: RunnerLoginItemLaunch,
  preference: string | null | undefined,
): RunnerLoginItemSettings | null {
  if (!launch.cloud || launch.platform !== "darwin" || !launch.packaged) return null;
  return { openAtLogin: runnerStaysAvailable(preference) };
}

export interface RunnerLoginLaunch {
  cloud: boolean;
  platform: string;
  argv: readonly string[];
  /** Electron reads the launch Apple Event, including on modern macOS. */
  openedAtLogin: boolean;
}

/** Only a cloud launch may start windowless. Ordinary manual launches remain visible. */
export function launchedIntoMenuBar(launch: RunnerLoginLaunch): boolean {
  if (!launch.cloud || launch.platform !== "darwin") return false;
  return launch.openedAtLogin || launch.argv.includes(RUNNER_LOGIN_ITEM_ARG);
}

export type RunnerLoginItemState = "registered" | "not-registered" | "needs-approval";

/** The part of Electron's login-item answer the state reads. */
export interface RunnerLoginItemOsSettings {
  readonly openAtLogin: boolean;
  /** macOS's own status; absent on platforms that do not report one. */
  readonly status?: "not-registered" | "enabled" | "requires-approval" | "not-found";
}

/**
 * Electron's login-item answer as the port's state. macOS's `status` is the
 * truth (a registered item can still be `requires-approval`, and a moved app
 * can report `not-found`); `openAtLogin` is only the fallback where the OS
 * does not report one.
 */
export function runnerLoginItemState(settings: RunnerLoginItemOsSettings): RunnerLoginItemState {
  if (settings.status === "enabled") return "registered";
  if (settings.status === "requires-approval") return "needs-approval";
  if (settings.status === "not-registered" || settings.status === "not-found") {
    return "not-registered";
  }
  return settings.openAtLogin ? "registered" : "not-registered";
}

/** Main's adapter over app.getLoginItemSettings / app.setLoginItemSettings. */
export interface RunnerLoginItemPort {
  read(): RunnerLoginItemState;
  apply(settings: RunnerLoginItemSettings): void;
}

const APPROVAL_REQUIRED = "Allow Volli in System Settings → General → Login Items.";

/**
 * Electron's setter returns void even when macOS refuses registration. Read
 * back before acknowledging the switch; never re-register over an OS refusal.
 */
export function syncRunnerLoginItem(
  port: RunnerLoginItemPort,
  settings: RunnerLoginItemSettings | null,
): "applied" | "unchanged" | "skipped" {
  if (settings === null) return "skipped";
  const state = port.read();
  if (settings.openAtLogin && state === "needs-approval") throw new Error(APPROVAL_REQUIRED);
  const desired = settings.openAtLogin ? "registered" : "not-registered";
  if (state === desired) return "unchanged";
  port.apply(settings);
  const after = port.read();
  if (after === desired) return "applied";
  if (after === "needs-approval") throw new Error(APPROVAL_REQUIRED);
  throw new Error("Couldn’t change the login item. Check System Settings → General → Login Items.");
}
