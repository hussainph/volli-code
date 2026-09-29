/**
 * VC-30 / VC-402 — a Session's leading mark: the vendor's own logo, with the
 * state as a badge on its corner.
 *
 * It replaces the status dot on every Session row (the sidebar's two bands,
 * the Sessions inside a ticket folder, the in-ticket rail) and leads the peek
 * card's header, so one Session reads the same wherever it is drawn. The lab
 * compared three ways of saying this (`lab/session-peek/row-mark.tsx`) and the
 * owner chose the BADGE: the vendor's mark in its own colours on a quiet tile,
 * the state as a corner icon. A tinted logo carrying the status colour was the
 * alternative, and it lost because a brand colour and a state colour in one
 * glyph cannot both be read.
 *
 * TWO MAPS, AND WHY THERE IS NOT A THIRD. What a state LOOKS like belongs to
 * `ui/status-dot.tsx`, and what a Session's activity IS as a state belongs to
 * `ui/session-activity-status.ts` — callers pass the answer from
 * `sessionActivityDotState(...)` and this file re-derives nothing. What is new
 * here is only the four BADGE GLYPHS, and they paint with the semantic tone
 * tokens the dot already uses (`text-positive`, `text-attention`,
 * `text-destructive`, `text-muted-foreground`) rather than with a second
 * status→colour map. The lab's `STATUS_INK` copy is deliberately NOT ported: it
 * was a copy of a column PR #568 never merged, so it has no upstream to read.
 *
 * THE ACCESSIBLE NAME IS THE CALLER'S. The mark is in the tree because it says
 * something the row prints nowhere — which vendor — but the words for the state
 * are `SESSION_ACTIVITY_LABEL`'s, and composing them is the row's job (it knows
 * whether it is also printing them). This file never writes a state word.
 */
import * as React from "react";
import { ChatCircleIcon } from "@phosphor-icons/react/dist/csr/ChatCircle";
import { CircleIcon } from "@phosphor-icons/react/dist/csr/Circle";
import { CircleNotchIcon } from "@phosphor-icons/react/dist/csr/CircleNotch";
import { QuestionIcon } from "@phosphor-icons/react/dist/csr/Question";
import { TerminalWindowIcon } from "@phosphor-icons/react/dist/csr/TerminalWindow";
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";
import type { Icon as PhosphorIcon } from "@phosphor-icons/react";
import { isFirstClassHarnessId, type FirstClassHarnessId, type HarnessId } from "@volli/shared";

import { ModelMark } from "@renderer/components/models/model-identity";
import type { StatusDotState } from "@renderer/components/ui/status-dot";
import { cn } from "@renderer/lib/utils";

/** Where the mark sits, which fixes its box. */
export type SessionGlyphSize =
  /** A one-line row: a 20px slot holding a 14px mark. */
  | "row"
  /** A two-line row and the peek card's header: a 24px tile holding a 16px mark. */
  | "card";

/** The badge's disc is cut out of whatever is behind the mark. */
export type SessionGlyphSurface = "sidebar" | "popover";

/**
 * A terminal companion's vendor, so its row leads with the logo the harness's
 * MAKER owns rather than with a Phosphor mnemonic (VC-402, amendment A3 —
 * moved here from the lab's `sidebar-corpus.ts`).
 *
 * Partial on purpose: a harness nobody publishes a mark for keeps the glyph its
 * row already drew, which the caller passes as {@link SessionGlyphProps.fallback}.
 */
export const HARNESS_VENDOR: Partial<Record<FirstClassHarnessId, string>> = {
  "claude-code": "anthropic",
  codex: "openai-codex",
  opencode: "opencode-go",
};

/** The provider id a harness's mark is drawn from, or `null` when it has none. */
export function harnessVendorId(harnessId: HarnessId | null): string | null {
  if (harnessId === null || !isFirstClassHarnessId(harnessId)) return null;
  return HARNESS_VENDOR[harnessId] ?? null;
}

/** v2's four badges, over the dot's wider vocabulary. */
function badgeFor(state: StatusDotState): { icon: PhosphorIcon; ink: string } {
  switch (state) {
    case "working":
    case "setup":
    case "starting":
      return { icon: CircleNotchIcon, ink: "text-positive" };
    case "waiting":
      return { icon: QuestionIcon, ink: "text-attention" };
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
   * terminal's {@link harnessVendorId}. `null` draws {@link fallback} instead.
   */
  providerId: string | null;
  providerLabel: string;
  /**
   * The state the badge says, from `sessionActivityDotState(...)`. `null` draws
   * the logo alone, muted — a row that carries no state at all.
   */
  state: StatusDotState | null;
  /** Which shipped glyph stands in when there is no logo to draw. */
  kind: "chat" | "terminal";
  /**
   * The exact glyph to stand in with, overriding {@link kind}'s — a harness
   * mnemonic (`HARNESS_GLYPHS` in `sidebar/session-band-row.tsx`) for a
   * companion whose vendor publishes no mark.
   */
  fallback?: PhosphorIcon;
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
  const Stand = fallback ?? (kind === "chat" ? ChatCircleIcon : TerminalWindowIcon);
  return (
    <span
      role="img"
      aria-label={name}
      data-session-glyph={state ?? "none"}
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center",
        tile ? "size-6 rounded-md bg-muted/50" : "size-5",
      )}
    >
      {providerId === null ? (
        <Stand
          aria-hidden
          weight="bold"
          className={cn(tile ? "size-4" : "size-3.5", "text-muted-foreground")}
        />
      ) : (
        <ModelMark
          model={{ providerId, modelId: providerId, label: providerLabel }}
          providerLabel={providerLabel}
          by="provider"
          className={cn(tile ? "size-4" : "size-3.5", state === null && "opacity-70 grayscale")}
        />
      )}
      {badge === null ? null : (
        <span
          aria-hidden
          className={cn("absolute -right-1 -bottom-1 rounded-full p-px", DISC[surface], badge.ink)}
        >
          <badge.icon
            weight="bold"
            className={cn(
              tile ? "size-3" : "size-2.5",
              badge.icon === CircleNotchIcon && "motion-safe:animate-spin",
            )}
          />
        </span>
      )}
    </span>
  );
}
