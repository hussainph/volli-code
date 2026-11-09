/** A Session's vendor mark and semantic corner badge, shared by rows, tabs and
 * peek cards. Published artwork keeps the registry's vendor colour, independent
 * of state. State comes from the caller's Session projection, never inferred. */
import * as React from "react";
import {
  ChatIcon,
  CircleIcon,
  SpinnerIcon,
  HelpIcon,
  TerminalIcon,
  WarningIcon,
  type IconComponent,
} from "@renderer/components/ui/icon";

import { isFirstClassHarnessId, type FirstClassHarnessId, type HarnessId } from "@volli/shared";

import { ModelArtwork, providerMark } from "@renderer/components/models/model-identity";
import type { StatusDotState } from "@renderer/components/ui/status-dot";
import { cn } from "@renderer/lib/utils";

/** Where the mark sits, which fixes its box. */
export type SessionGlyphSize =
  /** A one-line row: a 20px slot holding a 14px mark. */
  | "row"
  /** A two-line row and the peek card's header: a 24px tile holding a 16px mark. */
  | "card"
  /**
   * A strip tab: the row's 14px mark, with the badge tucked inside the 28px tab
   * and a step of room before the label. The row's corner badge hangs 4px below
   * its slot, which a tab's scroller clips and which crowds the label.
   */
  | "tab";

/** The badge's disc is cut out of whatever is behind the mark. */
export type SessionGlyphSurface = "sidebar" | "popover";

/**
 * A terminal companion's vendor, so its row leads with the logo the harness's
 * MAKER owns rather than with a shared symbol (VC-402, amendment A3 —
 * moved here from the lab's `sidebar-corpus.ts`).
 *
 * Partial on purpose: a harness nobody publishes a mark for keeps the glyph its
 * row already drew, which the caller passes as {@link SessionGlyphProps.fallback}.
 */
export const HARNESS_VENDOR: Partial<Record<FirstClassHarnessId, string>> = {
  "claude-code": "anthropic",
  codex: "openai-codex",
  cursor: "cursor",
  opencode: "opencode-go",
};

/** The provider id a harness's mark is drawn from, or `null` when it has none. */
export function harnessVendorId(harnessId: HarnessId | null): string | null {
  if (harnessId === null || !isFirstClassHarnessId(harnessId)) return null;
  return HARNESS_VENDOR[harnessId] ?? null;
}

/** v2's four badges, over the dot's wider vocabulary. */
function badgeFor(state: StatusDotState): { icon: IconComponent; ink: string } {
  switch (state) {
    case "working":
    case "setup":
    case "starting":
      return { icon: SpinnerIcon, ink: "text-positive" };
    case "waiting":
      return { icon: HelpIcon, ink: "text-attention" };
    case "interrupted":
    case "error":
      return { icon: WarningIcon, ink: "text-destructive" };
    default:
      return { icon: CircleIcon, ink: "text-muted-foreground" };
  }
}

const DISC: Record<SessionGlyphSurface, string> = { sidebar: "bg-sidebar", popover: "bg-popover" };

export interface SessionGlyphProps {
  /**
   * The provider id the logo is drawn from: a chat's `model.providerId`, or a
   * terminal's {@link harnessVendorId}. No published mark draws {@link fallback} instead.
   */
  providerId: string | null;
  providerLabel: string;
  /**
   * The state the badge says, from `sessionActivityDotState(...)`. `null` draws
   * the logo alone at quiet opacity, retaining its vendor colour.
   */
  state: StatusDotState | null;
  /** Which shipped glyph stands in when there is no logo to draw. */
  kind: "chat" | "terminal";
  /**
   * The exact glyph to stand in with, overriding {@link kind}'s — a harness
   * mnemonic (`HARNESS_GLYPHS` in `sidebar/session-band-row.tsx`) for a
   * companion whose vendor publishes no mark.
   */
  fallback?: IconComponent;
  /** The complete accessible name, composed by the caller from SESSION_ACTIVITY_LABEL. */
  name: string;
  size?: SessionGlyphSize;
  surface?: SessionGlyphSurface;
}

export function SessionGlyph({
  providerId,
  providerLabel,
  state,
  kind,
  fallback,
  name,
  size = "card",
  surface = "sidebar",
}: SessionGlyphProps): React.ReactElement {
  const badge = state === null ? null : badgeFor(state);
  const tile = size === "card";
  const tab = size === "tab";
  const Stand = fallback ?? (kind === "chat" ? ChatIcon : TerminalIcon);
  const hasMark = providerId !== null && providerMark(providerId) !== null;
  return (
    <span
      role="img"
      aria-label={name}
      data-session-glyph={state ?? "none"}
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center",
        tile ? "size-6 rounded-md bg-muted/50" : "size-5",
        tab && "mr-0.5",
      )}
    >
      {/* The tab/row owns its help surface and keyboard anchor. A nested
          ModelMark would create a competing tooltip and another focus stop. */}
      {hasMark ? (
        <ModelArtwork
          model={{ providerId, modelId: providerId, label: providerLabel }}
          providerLabel={providerLabel}
          by="provider"
          className={cn(tile ? "size-4" : "size-3.5", state === null && "opacity-70")}
        />
      ) : (
        <Stand
          aria-hidden
          strokeWidth={2.25}
          className={cn(tile ? "size-4" : "size-3.5", "text-muted-foreground")}
        />
      )}
      {badge === null ? null : (
        <span
          aria-hidden
          className={cn(
            "absolute rounded-full p-px",
            tab ? "-right-0.5 -bottom-0.5 bg-background" : ["-right-1 -bottom-1", DISC[surface]],
            badge.ink,
          )}
        >
          <badge.icon
            strokeWidth={2.25}
            className={cn(
              tile ? "size-3" : "size-2.5",
              badge.icon === SpinnerIcon && "motion-safe:animate-spin",
            )}
          />
        </span>
      )}
    </span>
  );
}
