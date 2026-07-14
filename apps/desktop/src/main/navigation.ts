/**
 * Pure navigation-hardening policy for the main window (extracted from index.ts
 * so the security rule is unit-tested — index.ts itself is Electron lifecycle
 * bootstrap, outside the coverage report). A `will-navigate` / window-open
 * target is "internal" (allowed to stay in the app window) only when it matches
 * the app's own entry point: the Vite dev-server origin in dev, or the EXACT
 * packaged `index.html` document in prod. Prod compares by pathname (ignoring
 * query/hash so an in-app hash route stays internal) instead of accepting any
 * `file:` URL — otherwise dropping an arbitrary local `.html` onto the window
 * would navigate to it with the preload bridge attached.
 */
export interface NavigationPolicy {
  /** The allowed dev-server origin (dev), or `null` in prod. */
  devOrigin: string | null;
  /** The allowed packaged document's `file://` pathname (prod), or `null` in dev. */
  packagedPathname: string | null;
}

/** Whether `target` is an allowed in-window destination under `policy`. */
export function isInternalNavigationTarget(target: string, policy: NavigationPolicy): boolean {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return false;
  }
  if (policy.devOrigin !== null) {
    return url.origin === policy.devOrigin;
  }
  if (policy.packagedPathname !== null) {
    return url.protocol === "file:" && url.pathname === policy.packagedPathname;
  }
  return false;
}
