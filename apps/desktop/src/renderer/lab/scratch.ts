/**
 * The scratch contract — one default-exported component plus a title, so
 * adding an idea to the lab is "write one file" with no registration step
 * anywhere else (the shell discovers them with `import.meta.glob`).
 *
 * Setup is DECLARED here, not performed at module scope. Scratches are all
 * imported eagerly at load, so a scratch that seeded a store or installed
 * bridge stubs on import would apply that setup whether or not it is the one
 * on screen — and the last file imported would win. Declaring `api`/`seed`
 * instead lets the shell apply exactly one scratch's setup at a time, when it
 * becomes active.
 */
import type * as React from "react";

import type { ApiOverrides } from "./fake-api";

export interface ScratchModule {
  /** The scratch itself. Rendered inside the shell's stage. */
  default: React.ComponentType;
  /** Shown in the picker. A sentence fragment, not a component name. */
  title: string;
  /** One line on what question this scratch is meant to answer. */
  note?: string;
  /**
   * How much room the scratch gets.
   *
   * `"stage"` (the default) puts it in the shell's padded, width-limited stage
   * — right for a component or a set of states.
   *
   * `"window"` gives it the entire viewport and hides the lab's own chrome
   * behind a floating control. Whole-window surfaces need this rather than
   * merely preferring it: the app shell is sized `h-svh` and its sidebar
   * positions against the viewport, so inside a stage box it would render a
   * window's worth of layout hanging out of a smaller frame — and you would be
   * judging the overhang, not the design.
   */
  viewport?: "stage" | "window";
  /**
   * Bridge stubs this scratch needs — see `fake-api.ts`. Installed wholesale
   * when the scratch becomes active, so no other scratch's stubs are in play.
   */
  api?: ApiOverrides;
  /**
   * Seeds the stores this scratch's components read from, e.g.
   * `useBoardStore.setState({ ... })`. Run once per activation, before the
   * scratch first renders — never on re-render, so state you have interacted
   * with is not snapped back by an unrelated shell update.
   */
  seed?: () => void;
}

/** Whether a glob-imported module satisfies {@link ScratchModule}. */
export function isScratchModule(value: unknown): value is ScratchModule {
  if (typeof value !== "object" || value === null) return false;
  const module = value as Partial<ScratchModule>;
  return typeof module.default === "function" && typeof module.title === "string";
}

/** `./scratches/ticket-card.tsx` → `ticket-card`. The slug is the URL hash. */
export function slugFromPath(path: string): string {
  return path.replace(/^.*\//, "").replace(/\.tsx?$/, "");
}
