import { LoadingLabel } from "@renderer/components/ui/loading-label";

/** The one line the upgrade window says: a blocked state with no action. */
export const UPDATING_LABEL = "Updating your data";

/**
 * The app window's line while a routine launch's database check runs
 * (VC-1203): nothing is changing, so it does not say updating.
 */
export const CHECKING_LABEL = "Checking your data";

/** The query parameter main names the window's light/dark mode in. */
export const UPDATING_APPEARANCE_PARAM = "appearance";

/** The query parameter main names the window's background in. */
export const UPDATING_BACKGROUND_PARAM = "background";

/** The query parameter main names the launch's database work in: `check`, or an upgrade. */
export const UPDATING_WORK_PARAM = "work";

/** The query parameter main sets to `quit` while a quit waits for the upgrade (VC-1208). */
export const UPDATING_THEN_PARAM = "then";

/** The upgrade window's line while a quit waits for it: still a blocked state with no action. */
export const UPDATING_THEN_QUIT_LABEL = "Updating your data before quitting";

/** The mode main asked for, or `null` for anything else (the stylesheet's dark default). */
export function updatingAppearance(search: string): "light" | "dark" | null {
  const value = new URLSearchParams(search).get(UPDATING_APPEARANCE_PARAM);
  return value === "light" || value === "dark" ? value : null;
}

/** The window's background as main named it (`#rrggbb`), or `null` for anything else. */
export function updatingBackground(search: string): string | null {
  const value = new URLSearchParams(search).get(UPDATING_BACKGROUND_PARAM);
  return value !== null && /^#[\da-f]{6}$/i.test(value) ? value : null;
}

/** What the launch is doing to the database: anything but `check` reads as an upgrade. */
export function updatingWork(search: string): "upgrade" | "check" {
  return new URLSearchParams(search).get(UPDATING_WORK_PARAM) === "check" ? "check" : "upgrade";
}

/** Whether a quit waits for the upgrade. */
export function updatingThenQuit(search: string): boolean {
  return new URLSearchParams(search).get(UPDATING_THEN_PARAM) === "quit";
}

/**
 * The page a launch shows while its database work runs off main: the busy
 * mark and its label, centred, on the window's canvas. For an upgrade it is
 * the small window's whole page (VC-1105); for a routine check, the app
 * window's until the app loads in its place (VC-1203). The whole page drags
 * the window: nothing on it is for the person to press.
 */
export function UpdatingPage({
  work = "upgrade",
  thenQuit = false,
}: {
  work?: "upgrade" | "check";
  thenQuit?: boolean;
}) {
  const label =
    work === "check" ? CHECKING_LABEL : thenQuit ? UPDATING_THEN_QUIT_LABEL : UPDATING_LABEL;
  return (
    <main
      role="status"
      aria-live="polite"
      className="app-region-drag flex h-screen items-center justify-center text-ui text-muted-foreground select-none"
    >
      <LoadingLabel>{label}</LoadingLabel>
    </main>
  );
}
