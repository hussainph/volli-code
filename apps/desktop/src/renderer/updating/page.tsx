import { LoadingLabel } from "@renderer/components/ui/loading-label";

/** The one line the upgrade window says: a blocked state with no action. */
export const UPDATING_LABEL = "Updating your data";

/** The query parameter main names the window's light/dark mode in. */
export const UPDATING_APPEARANCE_PARAM = "appearance";

/** The mode main asked for, or `null` for anything else (the stylesheet's dark default). */
export function updatingAppearance(search: string): "light" | "dark" | null {
  const value = new URLSearchParams(search).get(UPDATING_APPEARANCE_PARAM);
  return value === "light" || value === "dark" ? value : null;
}

/**
 * The upgrade window's page (VC-1105): the busy mark and its label, centred,
 * on the window's canvas. The whole page drags the window: it has no title bar
 * and nothing to click.
 */
export function UpdatingPage() {
  return (
    <main
      role="status"
      aria-live="polite"
      className="app-region-drag flex h-screen items-center justify-center text-ui text-muted-foreground select-none"
    >
      <LoadingLabel>{UPDATING_LABEL}</LoadingLabel>
    </main>
  );
}
