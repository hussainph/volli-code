/**
 * The blank page a new Browser Tab opens on.
 *
 * A new tab has no destination yet — the person is about to type one — so it
 * must land somewhere real, empty, and offline. `about:blank` is all three: it
 * renders an empty document with an opaque origin, reaches no network, and
 * costs no bundled asset.
 *
 * It lives here, beside `external-app-ids.ts`, for that file's reason: the IPC
 * contract stays type-only so preload never loads it at runtime, and this
 * vocabulary is safe in every process because it has no Electron, Node, or DOM
 * dependency. Main enforces it as policy; the renderer reads it to know that a
 * tab is still blank, and so must show an empty address bar rather than the
 * literal string.
 */
export const BROWSER_START_URL = "about:blank";

/**
 * Whether a target is the product's own blank start page.
 *
 * Exact match, never a prefix: `about:` is a whole family of privileged
 * Chromium pages, and matching loosely would let `about:blank#x` or, worse, a
 * lookalike stand in for the one page this app actually vouches for.
 */
export function isBrowserStartUrl(target: string): boolean {
  return target === BROWSER_START_URL;
}
