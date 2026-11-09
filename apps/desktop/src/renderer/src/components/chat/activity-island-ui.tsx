/**
 * The Activity Island (VC-256, ported from the VC-248/VC-249 prototype).
 *
 * A pill above the composer that models what the Session is holding beyond
 * the chat stream — browser tabs, subagents, the plan, background shells — in
 * one place the person is already looking at, and discloses each of them
 * progressively: a glance at the pill, a hover for the card, a click to pin it
 * and work it, a row to promote its subject to a full surface. It consumes an
 * `ActivityIslandModel` and an `ActivityIslandActions` (`activity-island-
 * model.ts`), plus the ephemeral turn activity. `ChatPlane` mounts it; it
 * knows no store or bridge.
 *
 * What is settled, and why (decided live with the dev over several rounds;
 * the records are on VC-248 and VC-249 — do not re-litigate here):
 *
 *  • CLUSTERS + NOW. One cluster per element kind in the pill, in a fixed
 *    reading order, and one sessile bead for the turn and now channel. A flash
 *    swells that same bead, then returns to the verb. `mode="wait"` keeps
 *    word changes to one drop. Alone, the turn is a plain pill; clusters
 *    grow beneath it before fillets attach it to the rim.
 *  • ONE SPRING. Lively (stiffness 130 / damping ratio .66) drives geometry
 *    and cluster presence. Abort draws a slow .55s syrup thread before the
 *    snap. Reduced motion uses instant sizes and a picture crossfade.
 *  • PAYLOAD VOICE. Every flash is `event · payload`; the event stays quiet
 *    and the payload — the thing that actually changed — carries the weight.
 *  • POPOVER HOVER, CLICK PINS. Hover is the glance channel (140ms leave-grace
 *    so crossing the gap between clusters does not flicker); a click is the
 *    work channel — the card stays open regardless of the pointer, which is
 *    what lets it grow real controls. One card at a time through shared
 *    coordination, so a hand-off closes the old card in the same frame.
 *  • ROW = VERB. Browser rows always show the tab and carry a one-press close
 *    with Undo; other destructive actions arm first. Mutation failures toast.
 *  • CLUSTER GRAMMAR: globe + count for tabs (arc orbits while loading), toned
 *    round chips for subagents (the people idiom; arc while working, dim +
 *    badge on fail, cap 4 + "+n"), n/n checklist, terminal glyph with state IN
 *    the glyph. Leading hairlines travel with their cluster.
 *
 * Decided OUT, each tried and liked: a pill-level heartbeat (rented width that
 * read as blank when idle), orbs as the subagent group glyph (a second
 * working-state tier), a shimmer rim (every element already signs its own
 * status). ONE LIFE-SIGN PER TIER: clusters sign their subjects; the turn
 * signs itself with shimmer on the verb only. The shell never pulses.
 *
 * FIVE LAWS, each learned from a bug seen in the running app:
 *  1. One life-sign per tier.
 *  2. Load-bearing geometry is INLINE STYLE, never a first-use utility — a
 *     stale Tailwind scan dropped one and served a silent lie.
 *  3. The bead is an always-attached drawn union with the rim, not a floating
 *     overlapping shell. Stacking never hides a seam; text never blurs.
 *  4. Only entering/leaving elements change pill width; drawings may change
 *     at will.
 *  5. No island when nothing to model — a running turn is itself a subject.
 *
 * TRAPS: `PopoverAnchor`, not `PopoverTrigger`, and
 * `onInteractOutside` exempts the anchor · cap card heights or Radix flips
 * them below the island · tooltips over stacked rows are pointer-transparent
 * (now `ui/tooltip.tsx`'s default).
 *
 * Material: `LiquidIslandShell` draws a single union in generated `--card`
 * and `--border`, with the generated shadow hue. The island is a sibling of
 * `ComposerInteractionStack`, never absorbing it. Disclosure cards retain the
 * shared popover's glass. Reduced motion via the app's `use-reduced-motion`.
 */
import * as React from "react";
import { AnimatePresence, motion, MotionConfig } from "motion/react";
import {
  ExternalIcon,
  SuccessIcon,
  CircleIcon,
  BlockedIcon,
  PreviewIcon,
  GlobeIcon,
  type IconComponent,
  ChecklistIcon,
  PinIcon,
  StopIcon,
  TerminalIcon,
  TeamIcon,
  CloseIcon,
} from "@renderer/components/ui/icon";

import {
  type ActivityIslandActions,
  type ActivityIslandFeel,
  type ActivityIslandModel,
  agentDimmed,
  agentsHeading,
  agentsLine,
  agentStateWord,
  flashLine,
  type IslandAgent,
  ISLAND_AGENT_CHIP_CAP,
  ISLAND_ARM_WINDOW_MS,
  ISLAND_HOVER_LEAVE_GRACE_MS,
  type IslandCluster,
  type IslandFlash,
  type IslandNowVoice,
  type IslandPlan,
  type IslandRevealMode,
  type IslandShell,
  type IslandTab,
  islandClusters,
  islandEmpty,
  planHeading,
  planLine,
  planPercent,
  planStepState,
  resolveFeel,
  shellsHeading,
  shellsLine,
  shellsRunning,
  shellStateWord,
  summaryLine,
  tabsHeading,
  tabsLine,
  tabsLoading,
  tabStateWord,
} from "@volli/session-presentation";

import { AgentModelLine } from "@renderer/components/chat/agent-model-ui";
import { Button } from "@renderer/components/ui/button";
import { ListRow } from "@renderer/components/ui/list-row";
import { Popover, PopoverAnchor, PopoverContent } from "@renderer/components/ui/popover";
import { StatusDot } from "@renderer/components/ui/status-dot";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip";
import { useReducedMotion } from "@renderer/hooks/use-reduced-motion";
import { cn } from "@renderer/lib/utils";
import type { TurnActivity } from "@renderer/chat/turn-activity";
import { LiquidIslandShell, LIQUID_SPRING, useLingeringTurn } from "./liquid-island-shell";

/* ------------------------------------------------------------------ motion */

const EASE_OUT = [0.23, 1, 0.32, 1] as const;

/* ------------------------------------------------------------------- tone */

/**
 * The tints a tab chip and a subagent chip wear.
 *
 * They live HERE, not in the projection: a hex value is the drawing's
 * business, and a host that one day feeds this island has no opinion about
 * colour (docs/BOUNDARIES.md — `@volli/shared` carries domain vocabulary, not
 * presentation). Deliberately NOT `PROJECT_COLORS`, for the reason
 * `lab/automation/harness-identity.tsx` already records: a swatch in this app
 * already means "which project", so borrowing that palette would make a
 * browser tab read as one. Each tint is chosen dark enough to carry the white
 * initial the chips draw, which is what makes that literal safe here.
 */
const ISLAND_TONES = ["#3577F2", "#8B5E7A", "#4F7D6B", "#A96A4F", "#5E7A8B", "#7A6AA9"] as const;

/**
 * A stable tint for an id. Same id, same colour, every render and every
 * client — a chip that changed colour when the list reordered would be reading
 * as a different tab.
 */
function islandTone(id: string): string {
  let hash = 0;
  for (let at = 0; at < id.length; at += 1) hash = (hash * 31 + id.charCodeAt(at)) | 0;
  return ISLAND_TONES[Math.abs(hash) % ISLAND_TONES.length]!;
}

/** The pill's one spring — reduced motion collapses it to a fast fade-scale. */
function islandSpring(reduce: boolean) {
  return reduce ? ({ duration: 0.15, ease: EASE_OUT } as const) : LIQUID_SPRING;
}

/**
 * Entry/exit for anything living inside the pill; the pill's layout spring
 * does the width.
 *
 * It names no transition ON PURPOSE: the island root wraps everything in a
 * `MotionConfig` carrying the one spring, so every drawing in here inherits it
 * without being handed `feel`. Motion resolves a child's presence and layout
 * against its OWN transition, never its parent's, so before that config the
 * clusters entered on Motion's default while the pill around them used the
 * chosen spring — two springs in one material, which is the thing "ONE SPRING"
 * was decided to prevent, and a half no `feel` override could reach.
 */
function clusterPresence(reduce: boolean) {
  return {
    initial: reduce ? { opacity: 0 } : { opacity: 0, scale: 0.6 },
    animate: { opacity: 1, scale: 1 },
    exit: reduce ? { opacity: 0 } : { opacity: 0, scale: 0.6 },
  } as const;
}

/**
 * The now channel's hold, owned here rather than by whoever projects the
 * model: the projection says "this is the latest event", the island decides
 * how long an announcement reads. Derived, not mirrored — the held flash is
 * the model's flash until a timer says that id has expired, so a new id shows
 * on the render that brings it and no effect ever sets state synchronously.
 */
function useHeldFlash(
  flash: IslandFlash | null,
  holdSeconds: number,
  turnActive: boolean,
): IslandFlash | null {
  const [expiredId, setExpiredId] = React.useState<string | null>(null);
  // Keyed on the id, not the object: a re-projection that hands the same
  // announcement in a new object must not restart its hold.
  const flashId = flash?.id ?? null;
  const previousTurnActive = React.useRef(turnActive);
  React.useLayoutEffect(() => {
    // A flash borrows the turn's bead; it may never keep that turn alive or
    // postpone its drain/pinch. Idle flashes still have their normal hold.
    if (previousTurnActive.current && !turnActive && flashId !== null) setExpiredId(flashId);
    previousTurnActive.current = turnActive;
  }, [flashId, turnActive]);
  React.useEffect(() => {
    // No flash means nothing is expired. Without this the last expired id sat
    // in state for the life of the island, so a runtime that reused an id
    // after a quiet gap could never announce under it again.
    if (flashId === null) {
      setExpiredId(null);
      return;
    }
    const timer = window.setTimeout(() => setExpiredId(flashId), holdSeconds * 1000);
    return () => window.clearTimeout(timer);
  }, [flashId, holdSeconds]);
  return flash && flash.id !== expiredId ? flash : null;
}

/* ------------------------------------------------------------ coordination */

/**
 * Hover + pin coordination for the popover mode: ONE cluster's card at a
 * time, switched instantly. Radix keeps each popover its own root, so two
 * shells animating independently overlap during a hand-off; routing state
 * through this context means entering B closes A in the same frame. Hover is
 * the GLANCE channel (leave-grace so crossing the gap between clusters does
 * not flicker the card); pin is the WORK channel — a click holds the card
 * open regardless of the pointer, which is what lets a popover grow real
 * controls instead of staying a read-only caption that dies under the cursor.
 */
interface HoverCoordination {
  hovered: string | null;
  pinned: string | null;
  enter(id: string): void;
  leave(id: string): void;
  togglePin(id: string): void;
  /** Outside click / Escape: clear BOTH channels at once, no grace. */
  dismiss(id: string): void;
}

const HoverContext = React.createContext<HoverCoordination | null>(null);

function useHoverCoordination(): HoverCoordination {
  const [hovered, setHovered] = React.useState<string | null>(null);
  const [pinned, setPinned] = React.useState<string | null>(null);
  const leaveTimer = React.useRef<number | null>(null);
  const clearLeave = () => {
    if (leaveTimer.current !== null) window.clearTimeout(leaveTimer.current);
    leaveTimer.current = null;
  };
  React.useEffect(() => clearLeave, []);
  return React.useMemo<HoverCoordination>(
    () => ({
      hovered,
      pinned,
      enter(id) {
        clearLeave();
        setHovered(id);
      },
      leave(id) {
        clearLeave();
        leaveTimer.current = window.setTimeout(() => {
          setHovered((current) => (current === id ? null : current));
        }, ISLAND_HOVER_LEAVE_GRACE_MS);
      },
      togglePin(id) {
        setPinned((current) => (current === id ? null : id));
      },
      dismiss(id) {
        clearLeave();
        setPinned((current) => (current === id ? null : current));
        setHovered((current) => (current === id ? null : current));
      },
    }),
    [hovered, pinned],
  );
}

/** What a card knows about the frame it is drawn in. */
interface CardFrame {
  pinned: boolean;
  reveal: IslandRevealMode;
  arm: boolean;
  togglePin(): void;
  /** A card action deliberately navigated away from its owning pane. */
  leaveFocus(): void;
}

const CARD_UNFRAMED: CardFrame = {
  pinned: false,
  reveal: "always",
  arm: false,
  togglePin() {},
  leaveFocus() {},
};
const CardContext = React.createContext<CardFrame>(CARD_UNFRAMED);

/** Cards act through the verbs directly — the clusters never learn them. */
const ActionsContext = React.createContext<ActivityIslandActions | null>(null);

function useActions(): ActivityIslandActions {
  const actions = React.useContext(ActionsContext);
  if (!actions) throw new Error("ActivityIsland cards render only inside the island");
  return actions;
}

/* ----------------------------------------------------------- cluster shell */

/**
 * Card widths (VC-384). The cards hang off a 32px pill but read against the
 * composer below, so they TRACK it: 75% of the composer's live width,
 * re-measured on every resize through `useIslandColumnWidth`. Before this the
 * cards were fixed `w-72`/`w-80`, which truncated plan steps and subagent
 * titles past reading — and the first cut at this ticket only swapped one
 * fixed width for a wider one, which never moved when the window did.
 *
 * Two bounds keep the proportion honest. The floor is the old fixed width —
 * the proven-usable row for that card's action count (two actions default,
 * three on the agents card) — so a narrow column degrades to the shipped
 * rows rather than to crushed ones. The ceiling is the viewport: a stale
 * measurement must never push a card past the window.
 *
 * The live width is an INLINE STYLE, for two reasons that are both Law 2.
 * First, a width the Tailwind scan could drop is exactly the silent lie the
 * law was written about. Second, the card is portalled to `document.body`,
 * where no CSS variable set on the chat plane could ever reach it — and one
 * set on `:root` would be shared across splits, every pane's cards wearing
 * one pane's width. React props cross portals; inheritance does not. The
 * fixed widths below are only the first-paint fallback before the measurement
 * lands (and the whole width where there is no ResizeObserver, e.g. jsdom).
 */
const ISLAND_CARD_WIDTH = "w-[min(32rem,calc(100vw-2rem))]";
const ISLAND_AGENTS_CARD_WIDTH = "w-[min(34rem,calc(100vw-2rem))]";
/** The share of the composer's width a card takes. */
const ISLAND_CARD_SHARE = 0.75;
/** Floors are the old fixed widths, in px. */
const ISLAND_CARD_MIN_PX = 288;
const ISLAND_AGENTS_CARD_MIN_PX = 320;
const ISLAND_VIEWPORT_MARGIN_PX = 32;

/** 75% of the measured composer, floored; null until there is a measurement. */
export function islandCardWidth(columnWidthPx: number | null, minPx: number): number | null {
  if (columnWidthPx === null || !(columnWidthPx > 0)) return null;
  return Math.max(minPx, Math.round(columnWidthPx * ISLAND_CARD_SHARE));
}

/** `parseFloat` that treats unparseable input (jsdom's empty strings) as zero. */
function parseCssPx(value: string): number {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Horizontal padding of an element, in px. */
function horizontalPadding(element: Element | null): number {
  if (!element) return 0;
  const style = window.getComputedStyle(element);
  return parseCssPx(style.paddingLeft) + parseCssPx(style.paddingRight);
}

/**
 * The composer's width as the island sees it: the full column width the
 * island's own centering wrapper fills, less the column gutter it is padded
 * with. The gutter is read off the wrapper's PARENT — the `ContentColumn`
 * both this island and the composer below it sit in — rather than named from
 * the token, so a gutter change (or a root font-size change moving every rem)
 * moves the measurement with it instead of silently dating it.
 */
function measuredColumnWidth(node: HTMLElement): number {
  return Math.max(0, node.clientWidth - horizontalPadding(node.parentElement));
}

/** Live width of the column the island (and the composer below it) fills. Null until measured. */
function useIslandColumnWidth<T extends HTMLElement>(
  ref: React.RefObject<T | null>,
): number | null {
  const [width, setWidth] = React.useState<number | null>(null);
  React.useLayoutEffect(() => {
    const node = ref.current;
    // No ResizeObserver, no measurement (jsdom): the cards keep their
    // fallback widths, and every test below proves they still work.
    if (!node || typeof ResizeObserver === "undefined") return;
    const update = () => {
      const next = measuredColumnWidth(node);
      setWidth((prev) => (prev === next ? prev : next));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

/** One cluster's hover shell: nothing, a one-line tooltip, or a rich card. */
function ClusterShell({
  cluster,
  feel,
  line,
  detail,
  cardClassName,
  columnWidth,
  cardMinWidth = ISLAND_CARD_MIN_PX,
  children,
}: React.PropsWithChildren<{
  cluster: IslandCluster;
  feel: ActivityIslandFeel;
  line: string;
  detail: React.ReactNode;
  /** Card width — the agents card earns more room for three row actions. */
  cardClassName?: string;
  /** Live column width from the island root; null until measured. */
  columnWidth: number | null;
  /** Floor for the measured width — the agents card's rows carry three actions. */
  cardMinWidth?: number;
}>) {
  const id = React.useId();
  const coordination = React.useContext(HoverContext);
  const anchorRef = React.useRef<HTMLSpanElement>(null);
  const contentRef = React.useRef<HTMLDivElement>(null);
  const focusOnPin = React.useRef(false);
  // Whether focus is inside the card, and whether a pointer went elsewhere
  // while it was — the two facts that decide where focus goes when the card
  // closes (see `onCloseAutoFocus` below).
  const focusInCard = React.useRef(false);
  const interactedOutside = React.useRef(false);
  const latest = React.useRef(coordination);
  latest.current = coordination;
  const pinned = coordination?.pinned === id;

  // A cluster that leaves the pill takes its pin with it — otherwise a card
  // could outlive its own subject (close the last tab from the tabs card).
  React.useEffect(() => () => latest.current?.dismiss(id), [id]);

  // A KEYBOARD pin moves focus into the card's first row; a pointer pin never
  // does — the person is typing in the composer and the card is a glance.
  // Two doors, because the card may or may not exist when the pin lands: a
  // card already open from hover is focused by the effect; a card the pin
  // itself opens mounts in Radix's own Presence re-render AFTER this effect
  // has run and found nothing, so `onOpenAutoFocus` below takes the request
  // when the content arrives. Whichever door finds a row consumes the flag.
  const focusFirstRow = React.useCallback((): boolean => {
    if (!focusOnPin.current) return false;
    // Rows first — a single selector list answers in DOM order, where the
    // header's pin button comes before every row.
    const content = contentRef.current;
    const row =
      content?.querySelector<HTMLElement>("[data-card-row]") ??
      content?.querySelector<HTMLElement>("button");
    if (!row) return false;
    focusOnPin.current = false;
    row.focus();
    return true;
  }, []);
  React.useEffect(() => {
    if (pinned) focusFirstRow();
    else focusOnPin.current = false;
  }, [pinned, focusFirstRow]);

  const frame = React.useMemo<CardFrame>(
    () => ({
      pinned,
      reveal: feel.reveal,
      arm: feel.armDestructive,
      togglePin: () => coordination?.togglePin(id),
      leaveFocus: () => {
        interactedOutside.current = true;
      },
    }),
    [pinned, feel.reveal, feel.armDestructive, coordination, id],
  );

  // The live width (see the note on the width constants): exact px from the
  // island's own column measurement, viewport-capped so a stale value can
  // never push the card past the window. Null until the first measurement
  // lands — the fallback class below covers that paint.
  const measuredWidth = islandCardWidth(columnWidth, cardMinWidth);

  if (feel.hover === "tooltip") {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span data-island-cluster={cluster} className="flex items-center">
            {children}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top">{line}</TooltipContent>
      </Tooltip>
    );
  }
  if (feel.hover === "popover" && coordination) {
    // ONE card at a time, and a pin OUTRANKS a hover. `pinned || hovered === id`
    // read as one card only because each channel holds one id; across the two
    // it showed two — pin the agents cluster, sweep the pointer over tabs, and
    // both cards stood open, overlapping above a 32px pill. The pin is the work
    // channel: while it holds a card, a glance elsewhere may not open a second.
    const open = coordination.pinned === null ? coordination.hovered === id : pinned;
    return (
      <Popover
        open={open}
        onOpenChange={(next) => {
          // Only dismissals arrive here (outside click, Escape) — opening
          // belongs to the anchor span. Dismiss clears BOTH channels: killing
          // just the pin would let a still-hovering pointer reopen the card in
          // the same frame Escape closed it.
          if (!next) coordination.dismiss(id);
        }}
      >
        {/* PopoverAnchor, NOT PopoverTrigger: Radix's trigger owns click as
            open/close toggle, which would race the pin click (one handler
            pinning while the other closes). The anchor is positioning-only,
            so hover and pin stay the only two doors. */}
        <PopoverAnchor asChild>
          <span
            ref={anchorRef}
            role="button"
            tabIndex={0}
            aria-label={line}
            aria-expanded={open}
            aria-haspopup="dialog"
            data-island-cluster={cluster}
            className={cn(
              "-mx-1 flex items-center rounded-full px-1 transition-colors",
              open && "bg-muted",
            )}
            onMouseEnter={() => coordination.enter(id)}
            onMouseLeave={() => coordination.leave(id)}
            onClick={() => coordination.togglePin(id)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                focusOnPin.current = !pinned;
                coordination.togglePin(id);
              }
            }}
          >
            {children}
          </span>
        </PopoverAnchor>
        <PopoverContent
          ref={contentRef}
          side="top"
          align="center"
          sideOffset={10}
          collisionPadding={8}
          data-island-card={cluster}
          className={cn("flex flex-col p-1", cardClassName ?? ISLAND_CARD_WIDTH)}
          bodyClassName="flex max-h-[calc(var(--radix-popover-content-available-height)-0.5rem)] flex-col overflow-hidden"
          style={
            measuredWidth === null
              ? undefined
              : {
                  width: measuredWidth,
                  maxWidth: `calc(100vw - ${ISLAND_VIEWPORT_MARGIN_PX}px)`,
                }
          }
          // Radix would focus the first tabbable — the header's pin button.
          // Nothing is focused on open unless a keyboard pin asked for the
          // first row (see `focusFirstRow`).
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            focusFirstRow();
          }}
          // Radix counts the anchor as OUTSIDE (it is not a Trigger), so a
          // re-click on a pinned cluster dismissed on pointerdown and re-pinned
          // on click — a flicker that could never unpin. The anchor is ours.
          onInteractOutside={(event) => {
            if (anchorRef.current?.contains(event.target as Node)) event.preventDefault();
            else interactedOutside.current = true;
          }}
          // Where focus goes when the card closes. Radix hands it back to the
          // TRIGGER — and this card has none (see `PopoverAnchor` above), so
          // its default focused nothing and then suppressed FocusScope's own
          // fallback: Escape from a keyboard-pinned row dropped focus to the
          // document body. The anchor is the trigger in every sense but
          // Radix's, so it takes the focus back — but only when the card HAD
          // it, and only when no pointer went elsewhere in the meantime: a
          // glance card closing under a person typing in the composer must
          // not pull them up to the pill.
          onFocusCapture={() => {
            focusInCard.current = true;
          }}
          onBlurCapture={(event) => {
            // A blur whose destination is outside the card means focus left
            // by its own route. One with NO destination is the card being
            // removed from under the focused row — which is the case the
            // close handler has to know about, so it stays true.
            const to = event.relatedTarget as Node | null;
            if (to !== null && !event.currentTarget.contains(to)) focusInCard.current = false;
          }}
          onCloseAutoFocus={(event) => {
            const restore = focusInCard.current && !interactedOutside.current;
            focusInCard.current = false;
            interactedOutside.current = false;
            if (!restore) return;
            event.preventDefault();
            const anchor = anchorRef.current;
            // Revealing a tab can hide the owning chat before this card's
            // close autofocus runs. Focusing that resident-but-hidden anchor
            // would focus its old pane and undo the destination just selected.
            if (
              anchor?.isConnected &&
              anchor.checkVisibility?.({ checkVisibilityCSS: true }) !== false
            ) {
              anchor.focus();
            }
          }}
          onMouseEnter={() => coordination.enter(id)}
          onMouseLeave={() => coordination.leave(id)}
        >
          <CardContext.Provider value={frame}>{detail}</CardContext.Provider>
        </PopoverContent>
      </Popover>
    );
  }
  return (
    <span data-island-cluster={cluster} className="flex items-center">
      {children}
    </span>
  );
}

/* ------------------------------------------------------------------ cards */

/**
 * The card is where the island stops being a status display and becomes a
 * control surface. Three decisions:
 *
 *  • ROW = VERB. Activating a row shows its subject — tab → workspace,
 *    subagent → overlay, shell → output — on `ListRow`'s activatable branch.
 *    Only plan steps are inert: there is no per-step destination yet.
 *  • ACTIONS ARE SIBLINGS of the row target (a button inside a button is not
 *    markup), revealed on row hover by default. Hidden actions keep their
 *    width so hover never shifts the name. The verb also appears as the first
 *    action so it is discoverable — the row is just its bigger target.
 *  • DESTRUCTIVE ARMS FIRST. Close / stop / kill on a surface the pointer
 *    reached by glancing is one click from harm, so the first press arms
 *    (tint + relabel), the second fires; the arm quietly lapses.
 */

/**
 * Header + body. The pin lives in the header so the glance card carries its
 * own invitation to become a work card. `cursor-default select-none` is the
 * menu-item idiom (`ui/menu-classes.ts`): this is a control surface, and a
 * label that shows an I-beam is a surface lying about being prose.
 */
function Card({
  glyph: Glyph,
  heading,
  children,
}: React.PropsWithChildren<{ glyph: IconComponent; heading: string }>) {
  const frame = React.useContext(CardContext);
  return (
    <div className="flex min-h-0 cursor-default flex-col select-none">
      <div className="flex h-6 shrink-0 items-center gap-1.5 px-2">
        <Glyph className="size-3.5 shrink-0 text-muted-foreground" />
        <h3 className="min-w-0 flex-1 truncate text-ui font-semibold text-foreground">{heading}</h3>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-pressed={frame.pinned}
              aria-label={frame.pinned ? "Unpin card" : "Pin card open"}
              data-island-pin=""
              className={cn(frame.pinned && "text-primary hover:text-primary")}
              onClick={frame.togglePin}
            >
              <PinIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">{frame.pinned ? "Unpin · Esc" : "Pin open"}</TooltipContent>
        </Tooltip>
      </div>
      {children}
    </div>
  );
}

/**
 * A card's scrolling row list.
 *
 * THE CAP IS THE DEFAULT, not each card's job to remember. Radix flips a card
 * that is taller than the room above its anchor to BELOW the island — over the
 * composer, which is the one place this surface must never cover. Only the
 * plan card capped itself, because a plan was the only list anyone pictured
 * growing; a Session holding twenty Browser Tabs or a long shell history
 * reaches the same ceiling, and there the omission is invisible until it
 * happens. `max-h-72` is roughly seven rows: enough that nothing common
 * scrolls, low enough that nothing ever flips.
 */
function CardRows({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      data-island-rows=""
      className={cn("flex min-h-0 max-h-72 flex-col overflow-y-auto overscroll-contain", className)}
    >
      {children}
    </div>
  );
}

/** Data rows update immediately, preserving their actions and focus targets. */
function CardRow({
  reduce: _reduce,
  ...row
}: { reduce: boolean } & React.ComponentProps<typeof ListRow>) {
  return <ListRow data-card-row="" {...row} />;
}

/** The state word riding the name's line — `· loading`, `· 72%`, `· exit 137`. Nothing when there is nothing to say. */
function RowState({ children }: { children: string | null }) {
  if (children === null) return null;
  return <span className="shrink-0 text-label text-muted-foreground">· {children}</span>;
}

/**
 * Whose subject a row is, in the quiet register beside the state word — a
 * child Session's title on a tab it opened (VC-268). Nothing for this
 * Session's own: "this Session" on every row would be the default said aloud.
 * Truncates on its own so a long child title cannot push the host off the
 * line it names.
 */
function RowOwner({ children }: { children: string | null }) {
  if (children === null) return null;
  return <span className="min-w-0 truncate text-label text-muted-foreground/70">· {children}</span>;
}

function RowActions({ children }: React.PropsWithChildren) {
  const { reveal, pinned } = React.useContext(CardContext);
  if (reveal === "pinned" && !pinned) return null;
  return (
    <span
      className={cn(
        "flex shrink-0 items-center",
        reveal === "hover" && "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
      )}
    >
      {children}
    </span>
  );
}

/** An icon action; destructive ones arm on the first press when the feel says so. */
function ActionButton({
  label,
  armedLabel = "Click again",
  destructive = false,
  reversible = false,
  onPress,
  children,
}: React.PropsWithChildren<{
  label: string;
  armedLabel?: string;
  destructive?: boolean;
  /** Undo-backed closes act on the first press instead of arming. */
  reversible?: boolean;
  onPress(): void;
}>) {
  const { arm } = React.useContext(CardContext);
  const [armed, setArmed] = React.useState(false);
  React.useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(false), ISLAND_ARM_WINDOW_MS);
    return () => window.clearTimeout(timer);
  }, [armed]);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={armed ? armedLabel : label}
          data-armed={armed ? "" : undefined}
          className={cn(
            "text-muted-foreground",
            destructive && "hover:text-destructive",
            armed &&
              "bg-destructive/10 text-destructive hover:bg-destructive/10 hover:text-destructive",
          )}
          onClick={() => {
            if (destructive && !reversible && arm && !armed) {
              setArmed(true);
              return;
            }
            setArmed(false);
            onPress();
          }}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">{armed ? armedLabel : label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * The browser's own idiom — an arc — worn by whatever is loading or working.
 * It overhangs its subject by `inset` px; inline, because that overhang is the
 * geometry that keeps the arc from renting width while absent (law 2).
 */
function WorkingArc({ reduce, inset }: { reduce: boolean; inset: number }) {
  return (
    <svg
      viewBox="0 0 20 20"
      aria-hidden
      style={{ inset: -inset }}
      className={cn("absolute block size-5 text-primary", !reduce && "animate-spin")}
    >
      <circle
        cx="10"
        cy="10"
        r="8.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeDasharray="12 41"
      />
    </svg>
  );
}

/** Per-tab identity — the favicon idiom (rounded square + letter). Lives in the card, not the pill. */
function TabChip({ tab }: { tab: IslandTab }) {
  return (
    <span
      className="flex size-4 shrink-0 items-center justify-center rounded-sm text-label leading-none font-semibold text-white"
      style={{ backgroundColor: islandTone(tab.id) }}
    >
      {tab.host.charAt(0).toUpperCase()}
    </span>
  );
}

function TabsCard({ tabs, reduce }: { tabs: readonly IslandTab[]; reduce: boolean }) {
  const actions = useActions();
  const frame = React.useContext(CardContext);
  const promote = (id: string) => {
    // The owning chat can remain visible beside the destination. Returning
    // focus there when this card closes would nevertheless select that pane
    // again, undoing Show tab's choice of the Browser pane.
    frame.leaveFocus();
    actions.promoteTab(id);
  };
  return (
    <Card glyph={GlobeIcon} heading={tabsHeading(tabs)}>
      <CardRows>
        {tabs
          .toSorted((a, b) => Number(Boolean(b.needsAttention)) - Number(Boolean(a.needsAttention)))
          .map((tab) => {
            const showLabel = tab.surface === "tab" ? "Show tab" : "Open beside chat";
            return (
              <CardRow
                key={tab.id}
                reduce={reduce}
                data-island-row={tab.id}
                leading={<TabChip tab={tab} />}
                density="two-line"
                primary={tab.title ?? tab.host}
                primaryTrailing={<RowState>{tabStateWord(tab)}</RowState>}
                secondary={
                  <span className="flex min-w-0 items-center gap-1 text-ui text-muted-foreground">
                    <span className="truncate">{tab.detail ?? tab.host}</span>
                    <RowOwner>{tab.owner}</RowOwner>
                  </span>
                }
                title={`${showLabel}: ${tab.title ?? tab.host}\n${tab.detail ?? tab.host}`}
                aria-label={`${showLabel}: ${tab.title ?? tab.host}`}
                onActivate={() => promote(tab.id)}
                actions={
                  <span className="flex shrink-0 items-center">
                    <ActionButton label={showLabel} onPress={() => promote(tab.id)}>
                      <ExternalIcon />
                    </ActionButton>
                    <ActionButton
                      label="Close tab"
                      destructive
                      reversible
                      onPress={() => actions.closeTab(tab.id)}
                    >
                      <CloseIcon />
                    </ActionButton>
                  </span>
                }
              />
            );
          })}
      </CardRows>
    </Card>
  );
}

function AgentsCard({ agents, reduce }: { agents: readonly IslandAgent[]; reduce: boolean }) {
  const actions = useActions();
  return (
    <Card glyph={TeamIcon} heading={agentsHeading(agents)}>
      <CardRows>
        {agents.map((agent) => (
          <CardRow
            key={agent.id}
            reduce={reduce}
            data-island-row={agent.id}
            leading={<AgentDot agent={agent} reduce={reduce} />}
            primary={agent.label}
            primaryTrailing={<RowState>{agentStateWord(agent)}</RowState>}
            // THE POLICY TAKES ITS OWN LINE (VC-416), where the tab row's
            // owner rides the name's. The two additions are not the same
            // weight: an owner is one short title, and this is a model id plus
            // an effort word plus a glyph. The name's line is also the one with
            // no width to spare — at this card's {@link
            // ISLAND_AGENTS_CARD_MIN_PX} floor the row spends its 320px on
            // padding, a 16px dot, a state word and three action buttons before
            // the title gets any, and the title is the only part of the row a
            // person scans. So the policy goes where `ListRow` keeps a quieter
            // line for exactly this, and the title keeps the line it had.
            //
            // A row with no recorded policy draws no second line at all (the
            // component answers null), so the height is spent only by rows that
            // have something to say with it.
            // Provider names belong to the mark's long-hover/focus tag, not
            // this panel's policy line. Keep the shared caller for the peek too.
            secondary={<AgentModelLine agent={agent} />}
            onActivate={() => actions.peekAgent(agent.id)}
            actions={
              <RowActions>
                <ActionButton label="Peek in overlay" onPress={() => actions.peekAgent(agent.id)}>
                  <PreviewIcon />
                </ActionButton>
                <ActionButton
                  label={agent.promoted ? "Focus tab" : "Open as tab"}
                  onPress={() => actions.promoteAgent(agent.id)}
                >
                  <ExternalIcon />
                </ActionButton>
                {agent.state === "working" ? (
                  <ActionButton
                    label="Stop subagent"
                    armedLabel="Click again to stop"
                    destructive
                    onPress={() => actions.stopAgent(agent.id)}
                  >
                    <StopIcon />
                  </ActionButton>
                ) : null}
              </RowActions>
            }
          />
        ))}
      </CardRows>
    </Card>
  );
}

/**
 * READ-ONLY (VC-268). The rows are inert: `jumpStep` was designed against a
 * sim where each step had a place to jump to, and on main one `todo_write`
 * writes the whole list with no message behind any one step. A row that drew
 * activatable and did nothing is the lie the card's own rule forbids, and
 * anchoring every row to the same message would keep the row activatable
 * while changing what activation means — a different lie. The verb stays in
 * the contract; the rows take it back the day plan activity renders per step.
 */
function PlanCard({ plan, reduce }: { plan: IslandPlan; reduce: boolean }) {
  return (
    <Card glyph={ChecklistIcon} heading={planHeading(plan)}>
      {/* Progress as a hairline under the header — the header's number says
          it, the bar lets a glance read it without parsing. */}
      <div className="mx-2 mb-1 h-0.5 shrink-0 overflow-hidden rounded-full bg-border">
        <div
          data-island-progress=""
          className="h-full rounded-full bg-primary"
          style={{ transform: `scaleX(${planPercent(plan) / 100})`, transformOrigin: "left" }}
        />
      </div>
      {/* Compact rows and a scroll cap: a plan is the one list that can run
          to twenty entries, and a card taller than the room above the pill
          makes Radix flip it BELOW the island, over the composer. Seven steps
          fit without scrolling; twenty scroll inside the same card. */}
      <CardRows>
        {plan.steps.map((step, index) => {
          const state = planStepState(plan, index);
          return (
            <CardRow
              key={step.id}
              reduce={reduce}
              data-island-row={step.id}
              className="py-1"
              leading={
                state === "done" ? (
                  <SuccessIcon className="size-3.5 shrink-0 text-primary" />
                ) : state === "cancelled" ? (
                  // A step the model decided against (VC-6). Its own glyph,
                  // because the two it could have borrowed both lie: an empty
                  // circle reads as work still to come, and a tick reads as
                  // work that happened.
                  <BlockedIcon className="size-3.5 shrink-0 text-muted-foreground/50" />
                ) : (
                  <CircleIcon
                    strokeWidth={state === "current" ? 2.25 : 1.5}
                    className={cn(
                      "size-3.5 shrink-0",
                      state === "current" ? "text-primary" : "text-muted-foreground/50",
                    )}
                  />
                )
              }
              primary={
                <span
                  className={cn(
                    "min-w-0 flex-1 whitespace-normal break-words text-ui",
                    state === "done" && "text-muted-foreground line-through",
                    // Struck through like a done step, but dimmed further and
                    // never emphasised: the strike says "not on the list any
                    // more", the dimming says it was not finished.
                    state === "cancelled" && "text-muted-foreground/60 line-through",
                    state === "current" && "font-medium",
                  )}
                >
                  {step.title}
                </span>
              }
              primaryTrailing={
                <RowState>
                  {state === "current" ? "now" : state === "cancelled" ? "dropped" : null}
                </RowState>
              }
              onActivate={null}
            />
          );
        })}
      </CardRows>
    </Card>
  );
}

function ShellsCard({ shells, reduce }: { shells: readonly IslandShell[]; reduce: boolean }) {
  const actions = useActions();
  return (
    <Card glyph={TerminalIcon} heading={shellsHeading(shells)}>
      <CardRows>
        {shells.map((shell) => (
          <CardRow
            key={shell.id}
            reduce={reduce}
            data-island-row={shell.id}
            leading={
              <span className="flex size-4 shrink-0 items-center justify-center">
                <StatusDot state={shell.state === "running" ? "working" : "exited"} />
              </span>
            }
            primary={
              <span className="min-w-0 truncate font-mono text-ui text-foreground">
                {shell.command}
              </span>
            }
            primaryTrailing={<RowState>{shellStateWord(shell)}</RowState>}
            onActivate={() => actions.openShell(shell.id)}
            actions={
              <RowActions>
                <ActionButton label="Open output" onPress={() => actions.openShell(shell.id)}>
                  <ExternalIcon />
                </ActionButton>
                {shell.state === "running" ? (
                  <ActionButton
                    label="Kill shell"
                    armedLabel="Click again to kill"
                    destructive
                    onPress={() => actions.killShell(shell.id)}
                  >
                    <StopIcon />
                  </ActionButton>
                ) : null}
              </RowActions>
            }
          />
        ))}
      </CardRows>
    </Card>
  );
}

/* --------------------------------------------------------------- clusters */

interface ClusterProps {
  feel: ActivityIslandFeel;
  reduce: boolean;
  columnWidth: number | null;
}

function TabsCluster({
  tabs,
  feel,
  reduce,
  columnWidth,
}: ClusterProps & { tabs: readonly IslandTab[] }) {
  return (
    <ClusterShell
      cluster="tabs"
      feel={feel}
      line={tabsLine(tabs)}
      columnWidth={columnWidth}
      detail={<TabsCard tabs={tabs} reduce={reduce} />}
    >
      {/* Tabs compress to namespace glyph + count — the colored chips belong
          to the SUBAGENTS (they are the workers; circles + letters is the
          people idiom, and this pill has exactly one people-cluster). Identity
          per tab lives in the card. While any tab is loading, the browser's
          own idiom — an arc — orbits the globe. */}
      <span className="flex items-center gap-1">
        {/* The wrapper is exactly the glyph's box — a permanent size-5 stage
            for the arc left 6px of dead air beside the globe whenever nothing
            was loading. The arc overhangs via negative inset instead, which
            costs nothing while absent. */}
        <span className="relative flex shrink-0 items-center justify-center">
          <GlobeIcon className="block size-3.5 text-muted-foreground" />
          {tabsLoading(tabs) ? <WorkingArc reduce={reduce} inset={3} /> : null}
        </span>
        {/* The count as an attribute too: the headless smoke asserts it, and
            a number read back out of a text node is a brittle thing to aim
            an end-to-end check at. */}
        <span
          data-island-count={tabs.length}
          className="text-label font-medium tabular-nums text-foreground"
        >
          {tabs.length}
        </span>
      </span>
    </ClusterShell>
  );
}

/**
 * One subagent as a round toned chip — the people idiom ON PURPOSE, because
 * subagents are the pill's workers. State rides the chip without moving it:
 * working wears the arc, waiting takes an attention badge, failed dims and
 * takes a destructive badge, stopped dims without one, done just rests. Same
 * drawing in the pill stack and the card rows.
 *
 * The waiting badge is the same shape as the failed one in the other tone the
 * theme keeps for it (`bg-attention`, as `StatusDot` uses for the state that
 * is asking for a person). A child with no listing row is asking through this
 * chip or through nothing at all (VC-279), and a chip that only dimmed on
 * failure would draw a stalled delegation exactly like a busy one.
 */
function AgentDot({
  agent,
  reduce,
  className,
}: {
  agent: IslandAgent;
  reduce: boolean;
  className?: string;
}) {
  return (
    <span
      data-agent-state={agent.state}
      className={cn(
        "relative flex size-4 shrink-0 items-center justify-center rounded-full",
        agentDimmed(agent) && "opacity-60",
        className,
      )}
      style={{ backgroundColor: islandTone(agent.id), borderRadius: 999 }}
    >
      <span className="text-label leading-none font-semibold text-white">
        {agent.label.charAt(0).toUpperCase()}
      </span>
      {agent.state === "working" ? <WorkingArc reduce={reduce} inset={2} /> : null}
      {agent.state === "waiting" ? (
        <span className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-attention ring-2 ring-card" />
      ) : null}
      {agent.state === "failed" ? (
        <span className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-destructive ring-2 ring-card" />
      ) : null}
    </span>
  );
}

function AgentsCluster({
  agents,
  feel,
  reduce,
  columnWidth,
}: ClusterProps & { agents: readonly IslandAgent[] }) {
  return (
    <ClusterShell
      cluster="agents"
      feel={feel}
      line={agentsLine(agents)}
      cardClassName={ISLAND_AGENTS_CARD_WIDTH}
      columnWidth={columnWidth}
      cardMinWidth={ISLAND_AGENTS_CARD_MIN_PX}
      detail={<AgentsCard agents={agents} reduce={reduce} />}
    >
      {/* Chips only. Identity IS this cluster — the people idiom needs no
          namespace glyph — and each chip's arc is its own working state. The
          orbs went the way of the count: one life-sign per tier, and having
          heartbeat + orbs + arcs meant the same fact told three times. */}
      <span className="flex items-center">
        {agents.slice(0, ISLAND_AGENT_CHIP_CAP).map((agent, index) => (
          <AgentDot
            key={agent.id}
            agent={agent}
            reduce={reduce}
            className={cn("ring-2 ring-card", index > 0 && "-ml-1")}
          />
        ))}
        {agents.length > ISLAND_AGENT_CHIP_CAP ? (
          <span className="ml-1 text-label text-muted-foreground">
            +{agents.length - ISLAND_AGENT_CHIP_CAP}
          </span>
        ) : null}
      </span>
    </ClusterShell>
  );
}

function PlanCluster({ plan, feel, reduce, columnWidth }: ClusterProps & { plan: IslandPlan }) {
  return (
    <ClusterShell
      cluster="plan"
      feel={feel}
      line={planLine(plan)}
      columnWidth={columnWidth}
      detail={<PlanCard plan={plan} reduce={reduce} />}
    >
      <span className="flex items-center gap-1">
        <ChecklistIcon className="size-3.5 text-muted-foreground" />
        <span className="text-label font-medium tabular-nums text-foreground">
          {plan.done}/{plan.steps.length}
        </span>
      </span>
    </ClusterShell>
  );
}

function ShellsCluster({
  shells,
  feel,
  reduce,
  columnWidth,
}: ClusterProps & { shells: readonly IslandShell[] }) {
  const running = shellsRunning(shells) > 0;
  return (
    <ClusterShell
      cluster="shells"
      feel={feel}
      line={shellsLine(shells)}
      columnWidth={columnWidth}
      detail={<ShellsCard shells={shells} reduce={reduce} />}
    >
      {/* State lives in the ink: accent while running, muted at rest.
          Both keep the same outline drawing, without a corner badge. */}
      <span className="flex items-center">
        <TerminalIcon
          data-running={running ? "" : undefined}
          className={cn(
            "size-3.5",
            running ? "text-primary" : "text-muted-foreground",
            running && !reduce && "animate-pulse",
          )}
        />
      </span>
    </ClusterShell>
  );
}

/* ------------------------------------------------------------ now channel */

/**
 * The now channel's voice. A flash arrives as its two registers — so weight
 * can articulate it instead of decorating it: the event stays quiet and the
 * payload (the thing that actually changed) carries the emphasis. `quiet` and
 * `loud` are the flat registers on either side, and they are the only place
 * that needs the joined line.
 */
function FlashText({ flash, voice }: { flash: IslandFlash; voice: IslandNowVoice }) {
  if (voice !== "payload") {
    return (
      <span
        className={cn(
          "min-w-0 truncate",
          voice === "loud" ? "font-medium text-foreground" : "text-muted-foreground",
        )}
      >
        {flashLine(flash)}
      </span>
    );
  }
  return (
    <span className="min-w-0 truncate text-muted-foreground">
      {flash.event}
      {" · "}
      <span className="font-medium text-foreground">{flash.payload}</span>
    </span>
  );
}

/* ----------------------------------------------------------------- island */

export interface ActivityIslandProps {
  model: ActivityIslandModel;
  actions: ActivityIslandActions;
  activity?: TurnActivity | null;
  exitKind?: "done" | "abort";
  /** Overrides on the baked verdicts — for the lab harness's dials. */
  feel?: Partial<ActivityIslandFeel>;
  /**
   * On the island itself, so it LEAVES with the island. The mount decides the
   * spacing to the composer, and that spacing must not outlive the pill — on
   * the centering wrapper it held an empty band open over a chat with nothing
   * to model. Use margin rather than padding: it is the pill's own box.
   */
  className?: string;
}

export function ActivityIsland({
  model,
  actions,
  feel: feelOverride,
  className,
  activity = null,
  exitKind = "done",
}: ActivityIslandProps) {
  const feel = resolveFeel(feelOverride);
  const osReduce = useReducedMotion();
  const reduce = osReduce || feel.forceReducedMotion;
  const hasClusters = !islandEmpty(model);
  const lingeringTurn = useLingeringTurn(activity !== null);
  const populated = hasClusters || lingeringTurn;
  const flash = useHeldFlash(model.flash, feel.flashHoldSeconds, activity !== null);
  const spring = islandSpring(reduce);

  const clustersVisible = feel.grammar !== "now-only";
  /** clusters-now sends the channel to the drop; now-only keeps it inline. */
  const drop = feel.grammar === "clusters-now" ? flash : null;
  const inlineSummary = feel.grammar === "now-only" ? summaryLine(model) : null;
  const inlineFlash = feel.grammar === "now-only" ? flash : null;
  const inlineKey = flash ? `flash-${flash.id}` : `summary-${inlineSummary ?? ""}`;
  const inlineVisible = inlineFlash !== null || (inlineSummary ?? "") !== "";

  const coordination = useHoverCoordination();

  // The column this island (and the composer below it) fills — the cards
  // key their width to it, so they stay 75% of the composer at any window,
  // split or sidebar width. Measured here, on the wrapper that always spans
  // the column, rather than on the pill, which is only as wide as its
  // clusters.
  const centerRef = React.useRef<HTMLDivElement>(null);
  const columnWidth = useIslandColumnWidth(centerRef);

  const clusterProps = { feel, reduce, columnWidth };
  const clusterNode = (cluster: IslandCluster): React.ReactNode => {
    switch (cluster) {
      case "tabs":
        return <TabsCluster tabs={model.tabs} {...clusterProps} />;
      case "agents":
        return <AgentsCluster agents={model.agents} {...clusterProps} />;
      case "plan":
        return model.plan ? <PlanCluster plan={model.plan} {...clusterProps} /> : null;
      case "shells":
        return <ShellsCluster shells={model.shells} {...clusterProps} />;
    }
  };
  const clusters = clustersVisible ? islandClusters(model) : [];

  return (
    <ActionsContext.Provider value={actions}>
      <HoverContext.Provider value={coordination}>
        {/* ONE SPRING, stated once. Every drawing below inherits it, because a
            child resolves its own presence and layout against its own
            transition — clusters entering on Motion's default while the pill
            used the chosen spring was two materials pretending to be one. */}
        <MotionConfig transition={spring}>
          {/* Carries no spacing of its own. The centering wrapper outlives the
              pill so `AnimatePresence` can play its exit, which is exactly why
              the mount's spacing may not live here: it would hold a gap open
              over the composer for as long as the chat had nothing to model,
              and "no island when nothing to model" has to mean no band of
              nothing either. The spacing rides the pill instead. */}
          <div className="flex justify-center" ref={centerRef}>
            {/* Semantic activity, not synonym churn or percent ticks. This region
                survives the whole turn, including word-fit and flash transitions. */}
            <span role="status" className="sr-only">
              {activity?.announcement ?? (hasClusters && drop ? flashLine(drop) : "")}
            </span>
            <AnimatePresence initial={false}>
              {populated ? (
                <motion.div
                  key="island"
                  initial={
                    reduce
                      ? { opacity: 0 }
                      : { opacity: 0, transform: "translateY(10px) scale(0.95)" }
                  }
                  animate={{ opacity: 1, transform: "translateY(0px) scale(1)" }}
                  exit={
                    reduce
                      ? { opacity: 0 }
                      : { opacity: 0, transform: "translateY(8px) scale(0.97)" }
                  }
                  transition={reduce ? { duration: 0.15, ease: EASE_OUT } : spring}
                  // A GROUP, not a live region. `role="status"` here made the
                  // whole pill an assertive-ish announcement, so every tab
                  // count, every percent tick and every plan step re-read the
                  // entire island to a screen reader. Only the now channel is
                  // an announcement, and it carries the role itself.
                  role="group"
                  aria-label="Agent activity"
                  data-activity-island=""
                  className={cn("relative isolate will-change-transform", className)}
                >
                  {/* The verb and transient flash share ONE bead. Its drawn union
                      owns the shell; real cluster controls stay in a normal layer. */}
                  <LiquidIslandShell
                    activity={activity}
                    flash={drop}
                    populated={clusters.length > 0 || inlineVisible}
                    exitKind={exitKind}
                    reduce={reduce}
                  >
                    {/* Dividers travel WITH their cluster — each keyed wrapper
                      carries its own leading rule, so membership changes stay
                      one presence animation. The first cluster never has one;
                      when the first LEAVES, its successor's rule vanishes by
                      re-render rather than animation — an instant 1px change,
                      cheaper than choreographing divider presence separately. */}
                    {clusters.length > 0 ? (
                      <AnimatePresence mode="popLayout" initial={false}>
                        {clusters.map((cluster, index) => (
                          <motion.span
                            key={cluster}
                            layout
                            className="flex shrink-0 items-center gap-2"
                            {...clusterPresence(reduce)}
                          >
                            {index > 0 ? (
                              <span aria-hidden className="h-3 w-px shrink-0 bg-border" />
                            ) : null}
                            {clusterNode(cluster)}
                          </motion.span>
                        ))}
                      </AnimatePresence>
                    ) : null}

                    {/* Inline ticker — now-only grammar only; clusters-now sends
                      the channel to the drop above. NO `layout` prop and no
                      string transforms on these spans — `layout` owns
                      transform, so a string-transform exit never resolves and
                      AnimatePresence keeps the zombie forever (the
                      accumulating-flashes bug). */}
                    <AnimatePresence initial={false} mode="wait">
                      {inlineVisible ? (
                        <motion.span
                          key={inlineKey}
                          data-island-ticker=""
                          initial={
                            reduce ? { opacity: 0 } : { opacity: 0, y: 7, filter: "blur(4px)" }
                          }
                          animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                          exit={
                            reduce ? { opacity: 0 } : { opacity: 0, y: -7, filter: "blur(4px)" }
                          }
                          transition={
                            reduce ? { duration: 0.1 } : { duration: 0.18, ease: EASE_OUT }
                          }
                          className="flex max-w-56 items-center text-ui"
                        >
                          {inlineFlash ? (
                            <FlashText flash={inlineFlash} voice={feel.nowVoice} />
                          ) : (
                            <span className="min-w-0 truncate text-muted-foreground">
                              {inlineSummary}
                            </span>
                          )}
                        </motion.span>
                      ) : null}
                    </AnimatePresence>
                  </LiquidIslandShell>
                </motion.div>
              ) : null}
            </AnimatePresence>
          </div>
        </MotionConfig>
      </HoverContext.Provider>
    </ActionsContext.Provider>
  );
}
