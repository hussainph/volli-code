// Pure parser for Ghostty's config file format (`~/.config/ghostty/config`).
// We only care about the handful of keys that drive terminal appearance and
// behavior, so this is intentionally not a general-purpose Ghostty config
// parser — it extracts the preferences we act on and ignores everything else.
//
// This module stays pure: filesystem access for `config-file` include
// resolution is injected as a callback (`GhosttyFileReader`), never imported.

/** Terminal-appearance/behavior preferences extracted from a Ghostty config. */
export interface GhosttyTerminalPrefs {
  /** Ordered `font-family` values (repeatable key; empty value resets the list). */
  fontFamilies: string[];
  /** `font-size` in points, or null when unset/unparseable. */
  fontSize: number | null;
  /** Resolved `theme` value (see dark: handling), or null when unset. */
  themeName: string | null;
  /**
   * Ligature state derived from `font-feature`: false when `calt`/`liga` are
   * explicitly disabled (`-` prefix), true when either is (re-)enabled and
   * neither is disabled, null when neither feature was ever mentioned.
   */
  ligatures: boolean | null;
  /** `scrollback-limit` in bytes (non-negative integer), or null when unset/invalid. */
  scrollbackLimitBytes: number | null;
  /** `mouse-reporting` boolean, or null when unset/invalid. */
  mouseReporting: boolean | null;
  /** `macos-option-as-alt` (true/false/left/right), or null when unset/invalid. */
  macosOptionAsAlt: "left" | "right" | boolean | null;
}

/**
 * Strips one pair of matching surrounding double quotes, e.g. `"Fira Code"`
 * → `Fira Code`. Unmatched or interior quotes are left as-is — Ghostty does
 * not support escaping, so anything short of a clean wrapping pair is
 * treated as a literal value.
 */
function stripSurroundingQuotes(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Resolves a `theme` value that may be a plain name or a light/dark pair
 * (`light:Rose Pine Dawn,dark:Rose Pine`). The app is dark-only, so a
 * `dark:` entry wins when present; a `light:`-only value is used as a
 * fallback. A value with no `light:`/`dark:` prefixes is used verbatim.
 */
function resolveThemeName(value: string): string {
  if (!/(?:^|,)\s*(?:light|dark)\s*:/.test(value)) {
    return value;
  }

  let lightName: string | null = null;
  let darkName: string | null = null;
  for (const rawEntry of value.split(",")) {
    const entry = rawEntry.trim();
    const match = /^(light|dark)\s*:\s*(.*)$/.exec(entry);
    if (!match) continue;
    const [, variant, name] = match;
    if (variant === "dark") {
      darkName = name;
    } else {
      lightName = name;
    }
  }

  return darkName ?? lightName ?? value;
}

/** Parses `font-size` into a positive finite point size, or null. */
function parseFontSize(value: string): number | null {
  const size = Number(value);
  return Number.isFinite(size) && size > 0 ? size : null;
}

/** Parses a non-negative integer (byte count), or null when invalid/negative. */
function parseNonNegativeInt(value: string): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** Parses a Ghostty boolean (`true`/`false` only), or null when invalid. */
function parseGhosttyBool(value: string): boolean | null {
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

/**
 * Applies a single `font-feature` value to the tracked feature map. A value
 * may list several comma-separated tags, each optionally prefixed with `+`
 * (enable) or `-` (disable); a bare tag enables it. Whitespace-tolerant.
 */
function applyFontFeatures(value: string, features: Map<string, boolean>): void {
  for (const rawTag of value.split(",")) {
    const tag = rawTag.trim();
    if (tag.length === 0) continue;
    if (tag.startsWith("-")) {
      features.set(tag.slice(1).trim(), false);
    } else if (tag.startsWith("+")) {
      features.set(tag.slice(1).trim(), true);
    } else {
      features.set(tag, true);
    }
  }
}

/** Derives ligature state from the tracked `calt`/`liga` font features. */
function resolveLigatures(features: Map<string, boolean>): boolean | null {
  const calt = features.get("calt");
  const liga = features.get("liga");
  if (calt === undefined && liga === undefined) return null;
  if (calt === false || liga === false) return false;
  return true;
}

/** Parses a `macos-option-as-alt` value, or null when invalid. */
function parseMacosOptionAsAlt(value: string): "left" | "right" | boolean | null {
  switch (value) {
    case "true":
      return true;
    case "false":
      return false;
    case "left":
      return "left";
    case "right":
      return "right";
    default:
      return null;
  }
}

/**
 * Splits a config line into a trimmed `[key, value]` pair, or null when the
 * line is blank, a comment (`#` first non-whitespace char), or has no `=`.
 * The value has one pair of surrounding double quotes stripped.
 */
function parseConfigLine(line: string): [key: string, value: string] | null {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.startsWith("#")) return null;

  const eq = trimmed.indexOf("=");
  if (eq === -1) return null;

  const key = trimmed.slice(0, eq).trim();
  const value = stripSurroundingQuotes(trimmed.slice(eq + 1).trim());
  return [key, value];
}

/**
 * Parses Ghostty's line-oriented `key = value` config format into the
 * terminal preferences we act on. Never throws: lines without an `=` (junk,
 * or comments starting with `#`) are skipped, and unrecognized keys are
 * ignored so unrelated config content can't break parsing.
 */
export function parseGhosttyTerminalPrefs(text: string): GhosttyTerminalPrefs {
  const fontFamilies: string[] = [];
  const features = new Map<string, boolean>();
  let fontSize: number | null = null;
  let themeName: string | null = null;
  let scrollbackLimitBytes: number | null = null;
  let mouseReporting: boolean | null = null;
  let macosOptionAsAlt: "left" | "right" | boolean | null = null;

  for (const line of text.split("\n")) {
    const parsed = parseConfigLine(line);
    if (parsed === null) continue;
    const [key, value] = parsed;

    switch (key) {
      case "font-family":
        if (value.length === 0) {
          fontFamilies.length = 0;
        } else {
          fontFamilies.push(value);
        }
        break;
      case "font-feature":
        if (value.length === 0) {
          features.clear();
        } else {
          applyFontFeatures(value, features);
        }
        break;
      case "font-size":
        fontSize = value.length === 0 ? null : parseFontSize(value);
        break;
      case "theme":
        themeName = value.length === 0 ? null : resolveThemeName(value);
        break;
      case "scrollback-limit":
        scrollbackLimitBytes = value.length === 0 ? null : parseNonNegativeInt(value);
        break;
      case "mouse-reporting":
        mouseReporting = value.length === 0 ? null : parseGhosttyBool(value);
        break;
      case "macos-option-as-alt":
        macosOptionAsAlt = value.length === 0 ? null : parseMacosOptionAsAlt(value);
        break;
      default:
        break;
    }
  }

  return {
    fontFamilies,
    fontSize,
    themeName,
    ligatures: resolveLigatures(features),
    scrollbackLimitBytes,
    mouseReporting,
    macosOptionAsAlt,
  };
}

// ── config-file include resolution ──────────────────────────────────────────
//
// Ghostty's `config-file` key includes other config files. We resolve an entry
// file plus its includes into one merged text so a downstream last-wins parse
// sees the effective config. Path handling is minimal pure POSIX: this is a
// macOS-only app, so we never deal with Windows separators or drive letters.
// `~/` expansion is NOT handled here — callers pre-expand home if ever needed.

/** A file read callback: absolute POSIX path in, file text out, null when missing/unreadable. */
export type GhosttyFileReader = (absPath: string) => string | null;

/** POSIX dirname: the directory portion of an absolute path. */
function posixDirname(path: string): string {
  const idx = path.lastIndexOf("/");
  if (idx === -1) return ".";
  if (idx === 0) return "/";
  return path.slice(0, idx);
}

/** Collapses `.`/`..` segments in a POSIX path, preserving a leading `/`. */
function posixNormalize(path: string): string {
  const isAbsolute = path.startsWith("/");
  const out: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") {
        out.pop();
      } else if (!isAbsolute) {
        out.push("..");
      }
      // At the root of an absolute path, `..` has nowhere to go — drop it.
    } else {
      out.push(segment);
    }
  }
  const joined = out.join("/");
  if (isAbsolute) return `/${joined}`;
  return joined.length === 0 ? "." : joined;
}

/** Resolves `ref` against `baseDir`; absolute refs are used as-is. */
function posixResolve(baseDir: string, ref: string): string {
  return ref.startsWith("/") ? posixNormalize(ref) : posixNormalize(`${baseDir}/${ref}`);
}

/**
 * Collects the ordered `config-file` include values from one file's text.
 * An empty value resets the accumulated list for that file (Ghostty
 * semantics). Values keep their optional `?` prefix for the caller to strip.
 */
function collectIncludeValues(text: string): string[] {
  const includes: string[] = [];
  for (const line of text.split("\n")) {
    const parsed = parseConfigLine(line);
    if (parsed === null) continue;
    const [key, value] = parsed;
    if (key !== "config-file") continue;
    if (value.length === 0) {
      includes.length = 0;
    } else {
      includes.push(value);
    }
  }
  return includes;
}

/**
 * Resolves a ghostty config entry file plus its `config-file` includes into
 * one merged text in effective last-wins order.
 *
 * Each file's includes are emitted BEFORE the file's own text, so a key set
 * in the containing file wins over the same key in any file it includes
 * (matching ghostty: includes never override the including file). Multiple
 * includes keep declaration order; nested includes recurse under the same
 * rule. Optional includes (`?` prefix) that are missing are skipped
 * silently; a missing non-optional include yields a warning but never
 * throws. Already-emitted paths (cycles, duplicates) are skipped silently.
 *
 * A missing entry file yields `{ text: null, warnings: [] }`.
 */
export function resolveGhosttyConfigText(
  entryPath: string,
  readFile: GhosttyFileReader,
): { text: string | null; warnings: string[] } {
  const warnings: string[] = [];
  const visited = new Set<string>();

  // Returns the merged text for `absPath` (its includes' text then its own),
  // or null when the file is missing. Adds the path to `visited` up front so
  // cycles and duplicates short-circuit.
  function resolveFile(absPath: string): string | null {
    visited.add(absPath);
    const raw = readFile(absPath);
    if (raw === null) return null;

    const dir = posixDirname(absPath);
    const includedTexts: string[] = [];
    for (const rawValue of collectIncludeValues(raw)) {
      let optional = false;
      let ref = rawValue;
      if (ref.startsWith("?")) {
        optional = true;
        ref = ref.slice(1).trim();
      }
      const includeAbs = posixResolve(dir, ref);
      if (visited.has(includeAbs)) continue;

      const includeText = resolveFile(includeAbs);
      if (includeText === null) {
        if (!optional) warnings.push(`config-file not found: ${includeAbs}`);
        continue;
      }
      includedTexts.push(includeText);
    }

    return [...includedTexts, raw].join("\n");
  }

  const text = resolveFile(posixNormalize(entryPath));
  return { text, warnings };
}

/**
 * Merges multiple already-resolved config texts in load order (later files
 * win under a downstream last-wins parse). Null entries are dropped; an
 * all-null list yields null.
 */
export function mergeGhosttyConfigTexts(texts: Array<string | null>): string | null {
  const present = texts.filter((t): t is string => t !== null);
  return present.length === 0 ? null : present.join("\n");
}
