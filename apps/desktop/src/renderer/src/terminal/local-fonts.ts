/**
 * The installed font families, via the Local Font Access API.
 *
 * restty already resolves ghostty's `font-family` values against installed
 * fonts through this API (main grants the `local-fonts` permission — see
 * src/main/index.ts), so Settings can offer the same list the renderer will
 * actually be able to load: no bundled font bytes, and no picker entry that
 * silently fails to resolve.
 *
 * `queryLocalFonts` is Chromium-only and permission-gated, so it is reached
 * through a narrow structural type rather than assumed on `window`; a host
 * without it (or a user who declines) degrades to an empty list, and the UI
 * falls back to a free-text field — the overlay file takes any value anyway (#68).
 */

/** The one field of the API's `FontData` we use. */
export interface LocalFontRecord {
  family: string;
}

type QueryLocalFonts = () => Promise<LocalFontRecord[]>;

/** Per-face records collapsed to distinct families, trimmed and alphabetized. */
export function uniqueFontFamilies(fonts: readonly LocalFontRecord[]): string[] {
  const families = new Map<string, string>();
  for (const font of fonts) {
    const family = font.family.trim();
    if (family.length === 0) continue;
    families.set(family.toLowerCase(), family);
  }
  return [...families.values()].toSorted((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" }),
  );
}

/**
 * The installed families, or an empty list when the API is unavailable or the
 * permission is refused. Never throws: an unavailable font list is a degraded
 * picker, not a failed mutation, so it is logged rather than toasted.
 */
export async function listLocalFontFamilies(): Promise<string[]> {
  const query = (globalThis as { queryLocalFonts?: QueryLocalFonts }).queryLocalFonts;
  if (typeof query !== "function") return [];
  try {
    return uniqueFontFamilies(await query());
  } catch (error) {
    console.warn("local font enumeration failed:", error);
    return [];
  }
}
