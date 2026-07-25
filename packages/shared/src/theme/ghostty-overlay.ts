/**
 * Volli's Ghostty OVERLAY files: where they live, and how a Volli write edits
 * one without destroying what the user put there by hand.
 *
 * The load-bearing rule (decision #67) is that Volli NEVER writes the user's
 * own `~/.config/ghostty/config`. That file stays a read-only base; Volli owns
 * separate overlay files *in Ghostty's own `key = value` format*, layered on
 * top with the same last-wins precedence `mergeGhosttyConfigTexts` already
 * applies to ghostty's two config locations. Writing the real config would
 * silently restyle **Ghostty.app and cmux** because someone clicked a swatch in
 * Volli — kitty converged on this same `current-theme.conf` design for exactly
 * that reason.
 *
 * Half of decision #68 lives here too: the overlay file accepts ANY ghostty
 * key, hand-written, and Volli honors it. That is only true if a Volli write
 * is surgical — {@link applyOverlayEdits} rewrites the keys it was asked to
 * and preserves every other key, comment, and blank line byte-for-byte. A
 * hand-written `cursor-style = block` must survive Volli rewriting `theme`.
 *
 * Pure string/path logic only — no Node imports (this package must stay usable
 * from main, preload, and the CLI alike). The filesystem half is
 * `apps/desktop/src/main/theme-overlay.ts`.
 */

import { mergeGhosttyConfigTexts } from "../ghostty-config";
import { isValidPrefix } from "../project-identity";

/** Strips a single trailing slash, so `<dir>/` and `<dir>` build the same path. */
function stripTrailingSlash(path: string): string {
  return path.endsWith("/") ? path.slice(0, -1) : path;
}

/** Volli's ghostty overlay root: `<userDataDir>/volli/ghostty`. The ONLY directory a terminal-overlay write may touch. */
export function volliGhosttyOverlayDir(userDataDir: string): string {
  return `${stripTrailingSlash(userDataDir)}/volli/ghostty`;
}

/** The global overlay, layered over the user's real ghostty config: `<userDataDir>/volli/ghostty/config`. */
export function globalGhosttyOverlayPath(userDataDir: string): string {
  return `${volliGhosttyOverlayDir(userDataDir)}/config`;
}

/** The per-project overlay directory: `<userDataDir>/volli/ghostty/projects`. */
export function projectGhosttyOverlayDir(userDataDir: string): string {
  return `${volliGhosttyOverlayDir(userDataDir)}/projects`;
}

/**
 * A project's overlay, layered last: `<userDataDir>/volli/ghostty/projects/<prefix>.config`.
 *
 * Keyed by the project's ticket prefix rather than its UUID so the file is
 * recognizable when opened by hand ("Open Volli overlay" is a shipped
 * affordance). The prefix is user-supplied, so it is validated against the
 * SAME rule the rest of the app enforces (`isValidPrefix`: 1–5 ASCII
 * uppercase alphanumerics starting with a letter) — which makes a traversal
 * segment structurally unrepresentable here, before the main-process write
 * guard ever sees the path.
 */
export function projectGhosttyOverlayPath(userDataDir: string, ticketPrefix: string): string {
  if (!isValidPrefix(ticketPrefix)) {
    throw new Error(`Invalid ticket prefix for a ghostty overlay: ${JSON.stringify(ticketPrefix)}`);
  }
  return `${projectGhosttyOverlayDir(userDataDir)}/${ticketPrefix}.config`;
}

// ── editing an overlay ───────────────────────────────────────────────────────

/**
 * Written at the top of an overlay Volli creates. Comments only — ghostty
 * ignores `#` lines — and deliberately framed as an invitation: the file IS
 * the escape hatch for every ghostty key the Settings UI doesn't expose (#68),
 * so it has to read as the user's file too, not as generated output they must
 * not touch.
 */
export const OVERLAY_HEADER = `# Volli terminal overlay — ghostty config format.
#
# Volli writes the keys you change in Settings here, and NEVER edits your own
# ghostty config. This file is layered on top of it, so anything set here wins.
#
# Safe to hand-edit: any ghostty key works, and Volli preserves your lines,
# comments, and blank lines when it rewrites the keys it manages.
`;

/**
 * One overlay edit set: the keys to rewrite, mapped to their new value.
 *
 * `null` REMOVES the key (the revert-to-inherited action). An empty string is
 * NOT the same thing — ghostty reads `key =` as an explicit reset of that key,
 * so an empty value is written through as a real directive.
 */
export type OverlayEdits = Record<string, string | null>;

/** A parsed overlay line: its key when it sets one, plus the indentation to preserve on rewrite. */
interface KeyedLine {
  key: string;
  indent: string;
}

/**
 * The `key` a config line sets, or null for a blank line, a comment, or a line
 * with no `=`. Deliberately NOT a full ghostty parse — the value is left
 * untouched, because a line this function reports no key for must survive the
 * rewrite byte-for-byte.
 */
function keyedLine(line: string): KeyedLine | null {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.startsWith("#")) return null;
  const eq = trimmed.indexOf("=");
  if (eq === -1) return null;
  const key = trimmed.slice(0, eq).trim();
  if (key.length === 0) return null;
  return { key, indent: line.slice(0, line.length - line.trimStart().length) };
}

/**
 * Serializes one `key = value` line. Ghostty takes the value to end-of-line
 * and strips at most one pair of wrapping double quotes, so quoting is needed
 * for exactly one case: a value whose own leading/trailing whitespace is
 * significant (`font-family = " Mono"`). Everything else — spaces inside the
 * value, `#`, `=` — is literal and must NOT be quoted, or ghostty would read
 * the quotes as part of the value.
 */
function overlayLine(key: string, value: string, indent = ""): string {
  const needsQuotes = value !== value.trim();
  return `${indent}${key} = ${needsQuotes ? `"${value}"` : value}`;
}

/**
 * Applies `edits` to an overlay file's text, preserving everything else.
 *
 * This is the function that makes "the overlay file takes any key" (#68) true
 * rather than aspirational, so its contract is worth stating exactly:
 *
 *  - A key already in the file is rewritten **in place**, keeping its position
 *    and indentation. Later duplicate lines for that same key are dropped, so
 *    an edited key is left set exactly once and its effective value is
 *    unambiguous under ghostty's last-wins parse.
 *  - A key not in the file is **appended** at the end.
 *  - A `null` value **removes** every line setting that key.
 *  - Every line the edits don't name — other keys, comments, blank lines —
 *    is preserved verbatim, in order.
 *  - A file that does not exist yet (or is blank) is created with
 *    {@link OVERLAY_HEADER}.
 *
 * The result always ends in exactly one newline.
 */
export function applyOverlayEdits(existingText: string | null, edits: OverlayEdits): string {
  const base =
    existingText === null || existingText.trim().length === 0 ? OVERLAY_HEADER : existingText;

  // Split, dropping the trailing "" a final newline produces, so appended keys
  // land after the last real line rather than after a phantom blank one.
  const lines = base.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();

  const written = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const parsed = keyedLine(line);
    if (parsed === null || !Object.hasOwn(edits, parsed.key)) {
      out.push(line);
      continue;
    }
    // A second line for an already-rewritten key is dropped (see the contract
    // above), as is any line for a key being removed.
    if (written.has(parsed.key)) continue;
    const value = edits[parsed.key];
    written.add(parsed.key);
    if (value !== null && value !== undefined)
      out.push(overlayLine(parsed.key, value, parsed.indent));
  }

  for (const [key, value] of Object.entries(edits)) {
    if (written.has(key) || value === null) continue;
    out.push(overlayLine(key, value));
  }

  return `${out.join("\n")}\n`;
}

// ── layering + provenance ────────────────────────────────────────────────────

/**
 * Where a resolved ghostty value came from. Settings labels every row with
 * this (#67): `Inherited from Ghostty` vs `Set by Volli`, with one-click
 * revert — which is only honest if the answer is computed from the same merge
 * the terminal actually renders, never re-derived by the renderer diffing
 * layers on its own.
 */
export type GhosttyValueOrigin = "ghostty" | "volli-global" | "volli-project";

/** One layer of the resolution chain: its origin and its already-include-resolved text (null when the file is absent). */
export interface GhosttyOverlayLayer {
  origin: GhosttyValueOrigin;
  text: string | null;
}

/** A merged chain: the effective config text, plus the winning origin of every key it sets. */
export interface ResolvedGhosttyLayers {
  /** Merged in load order for a downstream last-wins parse; null when no layer exists. */
  text: string | null;
  /** Winning origin per key — only keys some layer actually sets appear. */
  provenance: Record<string, GhosttyValueOrigin>;
}

/**
 * Merges the resolution chain — user's real ghostty config → Volli global
 * overlay → Volli project overlay — with the SAME last-wins semantics
 * `mergeGhosttyConfigTexts` already applies to ghostty's own two config
 * locations, and records which layer won each key.
 *
 * Provenance is computed here, next to the merge, so it cannot drift from the
 * text the terminal is actually painted with.
 */
export function resolveGhosttyLayers(
  layers: readonly GhosttyOverlayLayer[],
): ResolvedGhosttyLayers {
  const provenance: Record<string, GhosttyValueOrigin> = {};
  for (const layer of layers) {
    if (layer.text === null) continue;
    for (const line of layer.text.split("\n")) {
      const parsed = keyedLine(line);
      if (parsed !== null) provenance[parsed.key] = layer.origin;
    }
  }
  return { text: mergeGhosttyConfigTexts(layers.map((layer) => layer.text)), provenance };
}
