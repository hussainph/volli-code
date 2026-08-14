import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// tailwind-merge doesn't know the design language's custom type-scale tokens
// (globals.css / DESIGN.md); unregistered `text-*` classes fall into its
// text-COLOR group, so e.g. `cn("text-label … text-white")` silently dropped
// `text-label` (and a trailing `text-ui` would knock out a variant's text
// color). Registering them as font-size utilities makes both merges correct.
//
// The radius ladder needs the same registration for the opposite failure: an
// unknown `rounded-*` is in no group at all, so nothing dedupes it and BOTH
// survive into the class list — after which alphabetical rule order decides,
// not the caller. Measured: a `rounded-container` override on the composer's
// input group rendered at 12px, because `.rounded-container` is emitted before
// `.rounded-control`.
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": ["text-label", "text-ui", "text-heading", "text-title"],
      rounded: ["rounded-control", "rounded-container", "rounded-row"],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
