/**
 * Pure navigation-hardening policy for the main window (extracted from index.ts
 * so the security rule is unit-tested — index.ts itself is Electron lifecycle
 * bootstrap, outside the coverage report). A `will-navigate` / window-open
 * target is "internal" (allowed to stay in the app window) only when it matches
 * the Vite dev-server origin in development or the exact custom-protocol scheme
 * and host in packaged builds. WHATWG URL reports `origin === "null"` for
 * custom schemes in Node, so the packaged branch must compare protocol + host
 * explicitly rather than comparing `URL.origin`.
 */
export type NavigationPolicy =
  | { kind: "dev"; origin: string }
  | { kind: "packaged"; scheme: string; host: string; pathname: string };

/** Whether `target` is an allowed in-window destination under `policy`. */
export function isInternalNavigationTarget(target: string, policy: NavigationPolicy): boolean {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return false;
  }
  if (policy.kind === "dev") {
    return policy.origin !== "null" && url.origin === policy.origin;
  }
  return (
    url.protocol === policy.scheme &&
    url.host === policy.host &&
    url.username === "" &&
    url.password === "" &&
    url.pathname === policy.pathname
  );
}
