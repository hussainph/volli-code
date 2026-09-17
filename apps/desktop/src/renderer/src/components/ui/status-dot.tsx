/**
 * The one dot every surface draws a Session's state with.
 *
 * It exists because there were two maps. The ticket tab strip
 * (`ticket/ticket-tabs.tsx`) painted a live turn with the ACCENT and a failure
 * with `--destructive`; the rail's roster (`ticket/ticket-sessions-panel.tsx`)
 * painted the same live turn emerald and a blocked agent amber; the sidebar's
 * Active band wrote a third copy inline. So one Session could be an ember dot
 * in the strip, a green dot in the rail and an amber dot in the sidebar at the
 * same instant, and nothing in the type system had an opinion about it.
 *
 * The fix is not a shared constant — it is one component that owns the map, so
 * a surface can choose to draw a dot but cannot choose what the dot means.
 *
 * The two vocabularies are unioned rather than reconciled upstream, and that is
 * deliberate: `TicketTabStatus` and `TicketSessionStatus` describe genuinely
 * different plumbing (a chat slice's lifecycle, a PTY's activity), and merging
 * them at the source would force one of them to carry states it can never be
 * in. What must agree is the COLOUR, which is this file's whole surface area.
 */

import * as React from "react";

import { cn } from "@renderer/lib/utils";

/**
 * Every state either vocabulary can be in, in severity order.
 *
 * Exhaustive on purpose: {@link STATUS_DOT_TONE} is a `Record` over this union,
 * so a sixth chat lifecycle or a seventh activity state fails to compile until
 * someone has decided what colour it is. That is the same discipline Session
 * Events get on write, for the same reason — a status colour chosen by
 * `?? "grey"` is a state nobody ever notices is missing.
 */
export type StatusDotState =
  /** Producing output right now — the live turn. */
  | "working"
  /** The worktree's ensure pipeline is running its setup script. Working, named. */
  | "setup"
  /** Attached and available, between turns. */
  | "ready"
  /** Connecting. Nothing is wrong and nothing is happening yet. */
  | "starting"
  /** Blocked on a human — a permission prompt, a question. Declared, never inferred. */
  | "waiting"
  /** The Session's plumbing failed. */
  | "error"
  /** Running and quiet. */
  | "idle"
  /** Idle and SIGSTOP'd for the warm tier. */
  | "parked"
  /** Over. */
  | "exited"
  /** Ended on purpose — a supervisor, the person, or the watchdog (VC-86). */
  | "stopped"
  /** The last turn died rather than finished — nobody ended it (VC-324). */
  | "interrupted";

/** One state's tone: the fill a DISC takes, and the ink a GLYPH takes. */
interface StatusTone {
  /** The disc's fill — {@link StatusDot}. */
  dot: string;
  /** The glyph's ink — {@link statusToneInk}, for a mark drawn in `currentColor`. */
  ink: string;
}

/**
 * The map, and the only place a Session state becomes a colour.
 *
 * Read down the severity column rather than site by site — that is what the
 * three hand-written copies could not be read as:
 *
 *  - **positive** for every healthy state. `working`, `setup` and `ready` are
 *    one family because they are one fact ("this Session is fine"); the halo,
 *    not the hue, is what separates a live turn from a resting one. `working`
 *    was the accent in the strip, which put a status dot in the same colour as
 *    the selected-tab indicator two pixels away — the collision this map ends.
 *  - **attention** for `waiting`, the only state that is asking for a person.
 *    It is the sidebar's amber, now on a token, and it stays the loudest thing
 *    in a resting rail.
 *  - **destructive** for `error`, unchanged: a failure is destructive-adjacent
 *    and already had the right token.
 *  - **neutral** for the rest, at two weights rather than the four the two maps
 *    had between them (`/50 · /35 · /25` in the rail, full-strength in the
 *    strip). Live-but-quiet reads at /50; not-running reads at /30. Nothing in
 *    a resting Session justified a third step.
 *
 * `starting` sits in neutral rather than in `info` on purpose. Blue would be a
 * new signal in a strip that has never had one, and "connecting" does not want
 * a person's eye — `--info` is spent on facts about *changes* (a renamed file),
 * where it replaces sky, and spending it here too would make it mean nothing.
 *
 * **Each entry is a PAIR, not a class**, because the sidebar's bands no longer
 * draw a disc: since VC-402 an Active row's status rides the vendor's own mark
 * (`ui/session-mark.tsx`), which is filled with `currentColor` and so needs
 * `text-*` where the dot needs `bg-*`. A second map transposed by hand is
 * precisely the drift this module was created to end — only now with the two
 * copies a colour apart rather than a surface apart. Both halves are written
 * out as literals and neither is built from the other at runtime: Tailwind
 * reads source text, so a class assembled from a prefix and a token is a name
 * that never gets generated and a mark that paints nothing.
 */
const STATUS_DOT_TONE: Record<StatusDotState, StatusTone> = {
  // The halo rides `working` alone, so one live turn is findable in a strip of
  // resting tabs without the resting ones competing for the same attention.
  // The mark's own halo is a disc BEHIND the glyph rather than a spread shadow
  // ({@link STATUS_LIVE_HALO_COLOR}), because a glyph's box is a square and the
  // same shadow would ring a rounded rectangle around it.
  working: {
    dot: "bg-positive shadow-[0_0_0_3px_color-mix(in_oklab,var(--positive)_18%,transparent)]",
    ink: "text-positive",
  },
  setup: { dot: "bg-positive", ink: "text-positive" },
  ready: { dot: "bg-positive", ink: "text-positive" },
  waiting: { dot: "bg-attention", ink: "text-attention" },
  error: { dot: "bg-destructive", ink: "text-destructive" },
  starting: { dot: "bg-muted-foreground/50", ink: "text-muted-foreground/50" },
  idle: { dot: "bg-muted-foreground/50", ink: "text-muted-foreground/50" },
  parked: { dot: "bg-muted-foreground/30", ink: "text-muted-foreground/30" },
  exited: { dot: "bg-muted-foreground/30", ink: "text-muted-foreground/30" },
  // Ended-by-decision is not an error and asks for nobody: it rests at the
  // same not-running weight as `exited`. The label, not the dot, says who.
  stopped: { dot: "bg-muted-foreground/30", ink: "text-muted-foreground/30" },
  // A turn that DIED is the plumbing failing, so it takes `error`'s colour
  // rather than a fifth one: the two are one family (something broke), and
  // the state word beside the dot is what separates them. It is deliberately
  // NOT `stopped`'s resting neutral — reading a dead turn as an ended-on-
  // purpose one is the exact confusion VC-324 exists to remove.
  interrupted: { dot: "bg-destructive", ink: "text-destructive" },
};

/** The same verdict as the dot's fill, for a mark that paints in `currentColor`. */
export function statusToneInk(state: StatusDotState): string {
  return STATUS_DOT_TONE[state].ink;
}

/** 6px in a row of text, 8px on a tab. The two the app already draws. */
const STATUS_DOT_SIZE = { sm: "size-1.5", md: "size-2" } as const;

/**
 * The one state that MOVES, and it is decided here for the same reason the
 * colours are: a live turn was a static dot with a halo, which is the same
 * amount of ink as a resting one and told a reader scanning a strip of tabs
 * nothing they could catch without stopping. Motion is the channel a glance
 * actually reads.
 *
 * It rides `working` alone. `setup` is work too, and deliberately still: it is
 * a worktree script rather than an agent, it ends on its own, and a band where
 * several kinds of busy all breathe is a band with no signal left in it.
 *
 * The breath itself — what it costs, how slow, and why it is not a ping — is
 * `globals.css`, beside the transcript's own running mark. The two are one
 * decision seen from two distances.
 */
export const STATUS_DOT_LIVE = "status-dot-live";

/**
 * The live halo's colour, for a mark that cannot wear the dot's.
 *
 * The same formula as `working`'s `shadow-` above — 18% of `--positive` mixed
 * to transparent — painted as a disc BEHIND the glyph instead of as a spread
 * around it. The mechanism has to differ because the dot IS a circle and a
 * glyph's box is a square: the same spread would ring a rounded rectangle
 * around a mark nowhere near filling it. The colour must not differ, which is
 * why the two sit together and this is exported rather than retyped.
 *
 * A raw value rather than a `bg-[…]` class, and the duplication above is the
 * reason: Tailwind reads source TEXT, so the dot's arbitrary shadow has to
 * stay a literal in its own map however it is expressed here. One of the two
 * has to be plain CSS; the one nothing else can share is the class.
 */
export const STATUS_LIVE_HALO_COLOR = "color-mix(in oklab, var(--positive) 18%, transparent)";

export interface StatusDotProps extends React.ComponentProps<"span"> {
  state: StatusDotState;
  size?: keyof typeof STATUS_DOT_SIZE;
}

/**
 * Always `aria-hidden`. The dot is never the only place its state is said — the
 * rail prints the label beside it, the tab strip names the Session — so a
 * second announcement would make a screen reader read the status twice.
 */
export function StatusDot({ state, size = "sm", className, ...props }: StatusDotProps) {
  return (
    <span
      aria-hidden
      data-slot="status-dot"
      data-state={state}
      className={cn(
        "shrink-0 rounded-full",
        STATUS_DOT_SIZE[size],
        STATUS_DOT_TONE[state].dot,
        state === "working" && STATUS_DOT_LIVE,
        className,
      )}
      {...props}
    />
  );
}
