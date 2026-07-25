/**
 * What Settings → Appearance says about each terminal value, and where that
 * claim comes from.
 *
 * Decision #67's promise to the user is specific: every row is labeled
 * `Inherited from Ghostty` or `Set by Volli`, with one-click revert. That is
 * only honest if the answer is *computed from the same merge the terminal is
 * actually painted with* — which is why the provenance map is built next to the
 * merge in main and simply read here. This module never diffs config layers of
 * its own; doing that would produce a label that drifts from reality the first
 * time ghostty's precedence surprises us.
 *
 * The other rule encoded here: **revert only ever removes a key from a Volli
 * overlay.** A value the user's own config supplied is still shown as
 * revertible, because reverting it means dropping Volli's key and letting their
 * config win again — Volli never edits their file to make that happen.
 *
 * Pure: a payload in, rows out. No DOM, no IPC.
 */

import type { GhosttyAppearancePayload, GhosttyValueOrigin } from "@volli/shared";

/** The three ghostty keys the Settings UI exposes (#68 — the file takes any key). */
export type TerminalSettingKey = "theme" | "font-family" | "font-size";

/** Where a resolved value came from — the provenance origins, plus "nothing set it". */
export type TerminalValueSource = GhosttyValueOrigin | "default";

export interface TerminalSettingRow {
  key: TerminalSettingKey;
  /** Row label in Settings. */
  label: string;
  /** The value as displayed, or null when no layer sets the key. */
  value: string | null;
  source: TerminalValueSource;
  /** The #67 label. */
  sourceLabel: string;
  /**
   * Whether the revert affordance applies. False only for a key nothing sets:
   * there is nothing to revert *to*, and the revert action itself is always a
   * key removal from a Volli overlay, never a write to the user's config.
   */
  revertible: boolean;
}

const SOURCE_LABELS: Record<TerminalValueSource, string> = {
  ghostty: "Inherited from Ghostty",
  "volli-global": "Set by Volli",
  // #67 asks for two labels; the third exists because "Volli set this" and
  // "this project set this" are different facts, and a user staring at a
  // project-scoped surprise deserves to be told which one they're looking at.
  "volli-project": "Set by this project",
  default: "Built-in default",
};

/** Ghostty's font-size unit is points, and the config file writes it bare. */
function formatFontSize(size: number | null): string | null {
  return size === null ? null : `${size} pt`;
}

/**
 * The three exposed rows for a resolved appearance payload. A null payload
 * (config unreadable, or not yet loaded) is all-defaults rather than an error:
 * a missing ghostty config is the normal case, not a failure.
 */
export function buildTerminalSettingRows(
  payload: GhosttyAppearancePayload | null,
): TerminalSettingRow[] {
  const values: Record<TerminalSettingKey, string | null> = {
    theme: payload?.prefs.themeName ?? null,
    "font-family": payload?.prefs.fontFamilies[0] ?? null,
    "font-size": formatFontSize(payload?.prefs.fontSize ?? null),
  };
  const labels: Record<TerminalSettingKey, string> = {
    theme: "Theme",
    "font-family": "Font family",
    "font-size": "Font size",
  };

  return (Object.keys(labels) as TerminalSettingKey[]).map((key) => {
    const source: TerminalValueSource = payload?.provenance[key] ?? "default";
    return {
      key,
      label: labels[key],
      value: values[key],
      source,
      sourceLabel: SOURCE_LABELS[source],
      revertible: source !== "default",
    };
  });
}
