/**
 * The product stills (`src/assets/stills/<name>-{wide,tall}.webp`), captured
 * from the release film's scenes by `apps/desktop/scripts/film/web-stills.mjs`.
 *
 * A still missing its tall (9:16) cut falls back to the wide one, so a page
 * never breaks on a capture that has not landed yet.
 */
import type { ImageMetadata } from "astro";

const files = import.meta.glob<{ default: ImageMetadata }>("../assets/stills/*.webp", {
  eager: true,
});

function find(name: string, format: "wide" | "tall"): ImageMetadata | undefined {
  return files[`../assets/stills/${name}-${format}.webp`]?.default;
}

export interface Still {
  wide: ImageMetadata;
  tall: ImageMetadata;
}

/** The still called `name`, or undefined when neither cut exists yet. */
export function still(name: string): Still | undefined {
  const wide = find(name, "wide") ?? find(name, "tall");
  const tall = find(name, "tall") ?? wide;
  return wide && tall ? { wide, tall } : undefined;
}
