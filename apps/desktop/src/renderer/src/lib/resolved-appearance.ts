/**
 * "Am I light or dark right now?" — read from the DOM rather than from a store.
 *
 * The paint path stamps the resolved mode as a class on `<html>` (preload does
 * it before any page script runs, so it is already correct on the first frame,
 * and the renderer keeps it in sync afterwards). Reading the class rather than
 * subscribing to the theme store is deliberate: this is the *rendered* answer,
 * so anything that paints — including code that runs before React, and CSS —
 * agrees with it by construction, and there is no second copy of the resolution
 * to drift.
 *
 * The absence of a class means dark, matching `globals.css`, whose base block is
 * written as `:root, :root.dark`.
 */

import * as React from "react";
import type { ResolvedAppearance } from "@volli/shared";

/** The class the paint path stamps on `<html>` for the light half. */
const LIGHT_CLASS = "light";

/** The stamped mode, or `dark` when nothing has stamped one (globals.css's own default). */
export function resolvedAppearance(root?: Element): ResolvedAppearance {
  const target = root ?? (typeof document === "undefined" ? null : document.documentElement);
  return target?.classList.contains(LIGHT_CLASS) === true ? "light" : "dark";
}

function subscribe(onChange: () => void): () => void {
  if (typeof MutationObserver === "undefined" || typeof document === "undefined") {
    return () => undefined;
  }
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
}

/**
 * The live resolved mode, for the handful of components that must hand it to a
 * library rather than express it in CSS (sonner's `theme` prop). Everything that
 * *can* be a token should be a token — this hook is the escape hatch, not the
 * pattern.
 */
export function useResolvedAppearance(): ResolvedAppearance {
  return React.useSyncExternalStore(
    subscribe,
    () => resolvedAppearance(),
    () => "dark" as const,
  );
}
