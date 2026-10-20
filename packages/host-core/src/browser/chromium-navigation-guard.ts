/** Renderer-local cancellation: a blob commit must not race a CDP stop command. */
export const CHROMIUM_NAVIGATION_GUARD_WORLD = "volli-navigation-policy";
export const CHROMIUM_NAVIGATION_GUARD_BINDING = "__volliNavigationBlocked";
export const BLOCKED_BROWSER_NAVIGATION = "Blocked a page navigation to a non-HTTP(S) address";

/**
 * Installed before page scripts in a named isolated world: the page cannot
 * replace our listener, URL primitive or notification binding. Only the main frame is
 * guarded here; same-process iframe policy remains the documented residual.
 * Only the scheme is checked here: Fetch/commit enforce cross-document URL
 * length, without changing HTTP(S) in-page state/hash updates or downloads.
 * Non-cancelable navigations still have the CDP stop and commit backstops.
 */
export const CHROMIUM_NAVIGATION_GUARD_SOURCE = `(() => {
  if (window !== window.top || !window.navigation) return;
  window.navigation.addEventListener("navigate", (event) => {
    if (event.downloadRequest != null) return;
    const target = event.destination.url;
    if (target === "about:blank" || target.startsWith("chrome-error://")) return;
    try {
      const protocol = new URL(target).protocol;
      if (protocol === "http:" || protocol === "https:") return;
    } catch {}
    if (!event.cancelable) return;
    event.preventDefault();
    globalThis[${JSON.stringify(CHROMIUM_NAVIGATION_GUARD_BINDING)}](${JSON.stringify(BLOCKED_BROWSER_NAVIGATION)});
  });
})();`;
