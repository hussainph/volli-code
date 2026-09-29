/**
 * VC-30 — a Session row's leading mark, drawn three ways for comparison.
 *
 *   • `ink` — the VC-402 decision (owner, 2026-09-17; PR #568, closed unmerged
 *     for being stacked on a merged branch): the vendor's own mark takes the
 *     status dot's slot and carries its colour, breathing while it works. The
 *     Previous band draws it in the band's muted ink with no status.
 *   • `badge` — the v2 wireframe's `SessionGlyph`, faithfully: the vendor
 *     mark in its own colours on a quiet tile, the state as a corner icon
 *     (spinner, question, warning, and a hollow circle for idle). Previous
 *     rows carry no state, so there it is the logo alone, muted.
 *   • `dot` — what ships today: a 6px status dot in Active, the kind glyph in
 *     Previous.
 *
 * The ink map below is a LAB COPY of the `ink` column #568 added to
 * `ui/status-dot.tsx`. Production must read it from there — a second
 * status→colour map is exactly the drift that file exists to end — which is
 * why this copy is small, literal, and marked.
 */
import { ChatCircleIcon } from "@phosphor-icons/react/dist/csr/ChatCircle";
import { CircleIcon } from "@phosphor-icons/react/dist/csr/Circle";
import { CircleNotchIcon } from "@phosphor-icons/react/dist/csr/CircleNotch";
import { QuestionIcon } from "@phosphor-icons/react/dist/csr/Question";
import { TerminalWindowIcon } from "@phosphor-icons/react/dist/csr/TerminalWindow";
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";

import { ModelMark, providerMark } from "@renderer/components/models/model-identity";
import { StatusDot, type StatusDotState } from "@renderer/components/ui/status-dot";
import { cn } from "@renderer/lib/utils";

import { VENDOR_LABEL, type VendorId } from "./sidebar-corpus";

export type MarkStyle = "ink" | "badge" | "dot";

/**
 * Where a mark sits, which fixes its box:
 *   • `row` — a one-line row (Previous, a folder's Sessions): 14px, as shipped.
 *   • `two-line` — a two-line row (Active, the rail, a ticket card's list):
 *     a 24px slot holding a 16px mark, centred on the row — v2's geometry, so
 *     every style lands its text at the same x.
 *   • `card` — the peek header: the same 24px slot, always on a tile.
 */
export type MarkSize = "row" | "two-line" | "card";

/** The badge's disc is cut out of whatever is behind the mark. */
export type MarkSurface = "sidebar" | "popover";

/** LAB COPY of #568's `STATUS_DOT_TONE[state].ink`. See the module comment. */
const STATUS_INK: Record<StatusDotState, string> = {
  working: "text-positive",
  setup: "text-positive",
  ready: "text-positive",
  waiting: "text-attention",
  error: "text-destructive",
  starting: "text-muted-foreground/50",
  idle: "text-muted-foreground/50",
  parked: "text-muted-foreground/30",
  exited: "text-muted-foreground/30",
  stopped: "text-muted-foreground/30",
  interrupted: "text-destructive",
};

/** The dot's own halo formula, on a disc around the mark (#568's `STATUS_LIVE_HALO_COLOR`). */
const LIVE_HALO = "color-mix(in oklab, var(--positive) 18%, transparent)";

/** v2's four badges (`card.tsx`'s `SessionGlyph`), over the dot's wider vocabulary. */
function badgeFor(state: StatusDotState): { icon: typeof CircleIcon; ink: string } {
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

const DISC: Record<MarkSurface, string> = { sidebar: "bg-sidebar", popover: "bg-popover" };

function InkMark({
  vendor,
  state,
  size,
  halo,
}: {
  vendor: VendorId;
  state: StatusDotState | null;
  size: string;
  halo: string;
}) {
  const mark = providerMark(vendor);
  const live = state === "working";
  return (
    <span
      data-state={state ?? "none"}
      className={cn(
        "relative flex shrink-0 items-center justify-center",
        size,
        live && "status-dot-live",
      )}
    >
      {live ? (
        <span
          aria-hidden
          className={cn("absolute rounded-full", halo)}
          style={{ background: LIVE_HALO }}
        />
      ) : null}
      {mark === null ? (
        <StatusDot state={state ?? "idle"} />
      ) : (
        <svg
          aria-hidden
          viewBox={mark.viewBox}
          className={cn("relative", size, state !== null && STATUS_INK[state])}
        >
          {mark.paths.map((path) => (
            <path key={path.slice(0, 24)} d={path} fill="currentColor" />
          ))}
        </svg>
      )}
    </span>
  );
}

function BadgeMark({
  vendor,
  state,
  size,
  tile,
  surface,
}: {
  vendor: VendorId;
  state: StatusDotState | null;
  size: string;
  tile: boolean;
  surface: MarkSurface;
}) {
  const badge = state === null ? null : badgeFor(state);
  return (
    <span
      className={cn(
        "relative flex shrink-0 items-center justify-center",
        tile && "size-6 rounded-md bg-muted/50",
      )}
    >
      <ModelMark
        model={{ providerId: vendor, modelId: vendor, label: VENDOR_LABEL[vendor] }}
        providerLabel={VENDOR_LABEL[vendor]}
        by="provider"
        className={cn(size, state === null && "opacity-70 grayscale")}
      />
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

function DotMark({
  kind,
  state,
  size,
}: {
  kind: "chat" | "terminal";
  state: StatusDotState | null;
  size: string;
}) {
  if (state !== null) {
    return (
      <span className={cn("flex shrink-0 items-center justify-center", size)}>
        <StatusDot state={state} />
      </span>
    );
  }
  const Glyph = kind === "chat" ? ChatCircleIcon : TerminalWindowIcon;
  return (
    <span className={cn("flex shrink-0 items-center justify-center", size)}>
      <Glyph weight="bold" aria-hidden className="size-3" />
    </span>
  );
}

/**
 * The mark, with the whole accessible name: the vendor plus the state words
 * the caller composed (`SESSION_ACTIVITY_LABEL`'s, never a copy here). It is
 * in the tree because it says something the row prints nowhere — which vendor.
 */
export function RowMark({
  style,
  vendor,
  kind,
  state,
  name,
  size = "row",
  surface = "sidebar",
}: {
  style: MarkStyle;
  vendor: VendorId;
  kind: "chat" | "terminal";
  state: StatusDotState | null;
  name: string;
  size?: MarkSize;
  surface?: MarkSurface;
}) {
  const box = size === "row" ? "size-3.5" : "size-4";
  const mark =
    style === "ink" ? (
      <InkMark
        vendor={vendor}
        state={state}
        size={box}
        halo={size === "row" ? "size-5" : "size-6"}
      />
    ) : style === "badge" ? (
      <BadgeMark vendor={vendor} state={state} size={box} tile={size !== "row"} surface={surface} />
    ) : (
      <DotMark kind={kind} state={state} size={box} />
    );
  return (
    <span
      role="img"
      aria-label={name}
      data-row-mark={style}
      className={cn(
        "inline-flex shrink-0 items-center justify-center",
        size !== "row" && "size-6",
        // The header's mark always sits on a tile; the badge brings its own.
        size === "card" && style !== "badge" && "rounded-md bg-muted/50",
      )}
    >
      {mark}
    </span>
  );
}
