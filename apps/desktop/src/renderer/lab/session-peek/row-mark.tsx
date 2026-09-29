/**
 * VC-30 — a Session row's leading mark, drawn three ways for comparison.
 *
 *   • `ink` — the VC-402 decision (owner, 2026-09-17; PR #568, closed unmerged
 *     for being stacked on a merged branch): the vendor's own mark takes the
 *     status dot's slot and carries its colour, breathing while it works. The
 *     Previous band draws it in the band's muted ink with no status.
 *   • `badge` — the v2 wireframe's composite: the vendor mark in its own
 *     colours with the state as a corner badge.
 *   • `dot` — what ships today: a 6px status dot in Active, the kind glyph in
 *     Previous.
 *
 * The ink map below is a LAB COPY of the `ink` column #568 added to
 * `ui/status-dot.tsx`. Production must read it from there — a second
 * status→colour map is exactly the drift that file exists to end — which is
 * why this copy is small, literal, and marked.
 */
import { ChatCircleIcon } from "@phosphor-icons/react/dist/csr/ChatCircle";
import { CircleNotchIcon } from "@phosphor-icons/react/dist/csr/CircleNotch";
import { QuestionIcon } from "@phosphor-icons/react/dist/csr/Question";
import { TerminalWindowIcon } from "@phosphor-icons/react/dist/csr/TerminalWindow";
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";

import { ModelMark, providerMark } from "@renderer/components/models/model-identity";
import { StatusDot, type StatusDotState } from "@renderer/components/ui/status-dot";
import { cn } from "@renderer/lib/utils";

import { VENDOR_LABEL, type VendorId } from "./sidebar-corpus";

export type MarkStyle = "ink" | "badge" | "dot";

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

const BADGE_INK: Partial<Record<StatusDotState, string>> = {
  working: "text-positive",
  waiting: "text-attention",
  interrupted: "text-destructive",
};

function InkMark({
  vendor,
  state,
  size,
}: {
  vendor: VendorId;
  state: StatusDotState | null;
  size: string;
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
          className="absolute size-5 rounded-full"
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
}: {
  vendor: VendorId;
  state: StatusDotState | null;
  size: string;
}) {
  const Badge =
    state === "working"
      ? CircleNotchIcon
      : state === "waiting"
        ? QuestionIcon
        : state === "interrupted"
          ? WarningIcon
          : null;
  return (
    <span className={cn("relative flex shrink-0 items-center justify-center", size)}>
      <ModelMark
        model={{ providerId: vendor, modelId: vendor, label: VENDOR_LABEL[vendor] }}
        providerLabel={VENDOR_LABEL[vendor]}
        by="provider"
        className={cn(size, state === null && "opacity-70 grayscale")}
      />
      {Badge === null || state === null ? null : (
        <span
          aria-hidden
          className={cn(
            "absolute -right-1 -bottom-1 rounded-full bg-sidebar p-px",
            BADGE_INK[state],
          )}
        >
          <Badge
            weight="bold"
            className={cn("size-2.5", state === "working" && "motion-safe:animate-spin")}
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
}: {
  style: MarkStyle;
  vendor: VendorId;
  kind: "chat" | "terminal";
  state: StatusDotState | null;
  name: string;
  /** `row` is the band's 14px slot; `card` is the peek header's 16px mark in a 24px tile. */
  size?: "row" | "card";
}) {
  const box = size === "row" ? "size-3.5" : "size-4";
  const mark =
    style === "ink" ? (
      <InkMark vendor={vendor} state={state} size={box} />
    ) : style === "badge" ? (
      <BadgeMark vendor={vendor} state={state} size={box} />
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
        size === "card" && "size-6 rounded-md bg-muted/50",
      )}
    >
      {mark}
    </span>
  );
}
