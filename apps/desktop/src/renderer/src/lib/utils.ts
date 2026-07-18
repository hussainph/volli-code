import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// tailwind-merge doesn't know the design language's custom type-scale tokens
// (globals.css / DESIGN.md); unregistered `text-*` classes fall into its
// text-COLOR group, so e.g. `cn("text-label … text-white")` silently dropped
// `text-label` (and a trailing `text-ui` would knock out a variant's text
// color). Registering them as font-size utilities makes both merges correct.
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": ["text-label", "text-ui", "text-heading", "text-title"],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
