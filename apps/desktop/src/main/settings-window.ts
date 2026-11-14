/** Single-instance, nonmodal Settings lifetime, independent of the workspace. */
import type { SettingsWindowNavigation, SettingsWindowOpenInput } from "../ipc/settings-window";

export interface SettingsNativeWindow {
  isDestroyed(): boolean;
  once(event: "closed", listener: () => void): unknown;
}

export function createSettingsWindowOwner<W extends SettingsNativeWindow>(ports: {
  create(navigation: SettingsWindowOpenInput): W;
  navigate(window: W, navigation: SettingsWindowOpenInput): void;
  reveal(window: W): void;
}) {
  let window: W | null = null;
  return {
    open(navigation: SettingsWindowOpenInput): W {
      if (window === null || window.isDestroyed()) {
        const created = ports.create(navigation);
        window = created;
        created.once("closed", () => {
          if (window === created) window = null;
        });
        return created;
      }
      // Ordinary Settings entries and ⌘, raise the existing view, retaining
      // search, scope, drafts and scroll. Only an explicit pane is navigation.
      if (
        navigation.category !== undefined ||
        navigation.configureCategory !== undefined ||
        navigation.signInProviderId !== undefined
      ) {
        ports.navigate(window, navigation);
      }
      ports.reveal(window);
      return window;
    },
    current(): W | null {
      return window !== null && !window.isDestroyed() ? window : null;
    },
  };
}

/**
 * The Settings page's readiness answer for one revision, and what main keeps
 * of that navigation afterwards (VC-1236).
 *
 * Acknowledged is the page saying it has taken this revision. Its one-shot
 * sign-in request — the provider to sign in to, and a stopped chat's
 * sign-in-again intent — is spent at that moment: main keeps the navigation
 * for the page's next bootstrap read, and a reload of the page must arrive
 * at the same pane without starting that provider's auth flow again. A stale
 * or superseded revision acknowledges nothing and changes nothing.
 */
export function settleSettingsNavigation(
  current: SettingsWindowNavigation | null,
  appliedRevision: number,
): { acknowledged: boolean; navigation: SettingsWindowNavigation | null } {
  if (current === null || appliedRevision !== current.revision) {
    return { acknowledged: false, navigation: current };
  }
  const { signInProviderId: _provider, reauthenticate: _reauthenticate, ...spent } = current;
  return { acknowledged: true, navigation: spent };
}

export interface SettingsFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}
export const SETTINGS_WINDOW_SIZE = {
  width: 900,
  height: 680,
  minWidth: 720,
  minHeight: 520,
  maxWidth: 1440,
  maxHeight: 1200,
} as const;

/** A disconnected display must not strand the title bar offscreen. */
export function restoreSettingsFrame(
  value: unknown,
  displays: readonly SettingsFrame[],
): Partial<SettingsFrame> {
  if (typeof value !== "object" || value === null) return {};
  const frame = value as Partial<SettingsFrame>;
  if (
    ![frame.x, frame.y, frame.width, frame.height].every(
      (n) => typeof n === "number" && Number.isFinite(n),
    )
  )
    return {};
  const { x, y, width, height } = frame as SettingsFrame;
  const size = {
    width: Math.round(
      Math.max(SETTINGS_WINDOW_SIZE.minWidth, Math.min(SETTINGS_WINDOW_SIZE.maxWidth, width)),
    ),
    height: Math.round(
      Math.max(SETTINGS_WINDOW_SIZE.minHeight, Math.min(SETTINGS_WINDOW_SIZE.maxHeight, height)),
    ),
  };
  const visible = displays.some(
    (display) =>
      x + 80 <= display.x + display.width &&
      x + size.width - 80 >= display.x &&
      y >= display.y &&
      y + 46 <= display.y + display.height,
  );
  return visible ? { ...size, x: Math.round(x), y: Math.round(y) } : size;
}
