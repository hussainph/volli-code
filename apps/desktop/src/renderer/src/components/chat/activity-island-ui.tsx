/**
 * The Activity Island (VC-256, ported from the VC-248/VC-249 prototype).
 *
 * A pill above the composer that models what the Session is holding beyond
 * the chat stream — browser tabs, subagents, the plan, background shells — in
 * one place the person is already looking at, and discloses each of them
 * progressively: a glance at the pill, a hover for the card, a click to pin it
 * and work it, a row to promote its subject to a full surface. It consumes an
 * `ActivityIslandModel` and an `ActivityIslandActions` (`activity-island-
 * model.ts`) and nothing else; it is not mounted anywhere yet, and it knows no
 * store or bridge.
 *
 * What is settled, and why (decided live with the dev over several rounds;
 * the records are on VC-248 and VC-249 — do not re-litigate here):
 *
 *  • CLUSTERS + NOW. One cluster per element kind in the pill, in a fixed
 *    reading order, and a now channel — a drop that buds out of the pill
 *    upward on the island's spring, hangs while the announcement reads, and is
 *    reabsorbed. `mode="wait"` IS the metaphor: a new event waits for the old
 *    drop to return first.
 *  • ONE SPRING. Lively (0.55s / 0.25) drives pill layout, cluster presence
 *    and the drop, so a width morph, an entrance and a rise read as one
 *    material. Reduced motion collapses it to a fast fade.
 *  • PAYLOAD VOICE. Every flash is `event · payload`; the event stays quiet
 *    and the payload — the thing that actually changed — carries the weight.
 *  • POPOVER HOVER, CLICK PINS. Hover is the glance channel (140ms leave-grace
 *    so crossing the gap between clusters does not flicker); a click is the
 *    work channel — the card stays open regardless of the pointer, which is
 *    what lets it grow real controls. One card at a time through shared
 *    coordination, so a hand-off closes the old card in the same frame.
 *  • ROW = VERB, actions revealed on row hover, destructive arms first. The
 *    now channel is the confirmation; there is no toast.
 *  • CLUSTER GRAMMAR: globe + count for tabs (arc orbits while loading), toned
 *    round chips for subagents (the people idiom; arc while working, dim +
 *    badge on fail, cap 4 + "+n"), n/n checklist, terminal glyph with state IN
 *    the glyph. Leading hairlines travel with their cluster.
 *
 * Decided OUT, each tried and liked: a pill-level heartbeat (rented width that
 * read as blank when idle), orbs as the subagent group glyph (a second
 * working-state tier), a shimmer rim (every element already signs its own
 * status). ONE LIFE-SIGN PER TIER.
 *
 * FIVE LAWS, each paid for with a live-round bug:
 *  1. One life-sign per tier.
 *  2. Load-bearing geometry is INLINE STYLE, never a first-use utility — a
 *     stale Tailwind scan dropped one and served a silent lie for two rounds.
 *  3. The now-drop's travel never crosses the pill's rim; stacking is never
 *     load-bearing.
 *  4. Only entering/leaving elements change pill width; drawings may change
 *     at will.
 *  5. No island when nothing to model.
 *
 * TRAPS (inherited; each is marked at the line that avoids it): `mode="wait"`
 * on the ticker · no `layout` + string transforms (zombie exits) · clusters
 * under `popLayout` · `PopoverAnchor`, not `PopoverTrigger`, and
 * `onInteractOutside` exempts the anchor · cap card heights or Radix flips
 * them below the island · tooltips over stacked rows are pointer-transparent
 * (now `ui/tooltip.tsx`'s default).
 *
 * Material: `COMPOSER_STACK_SHELL` with the pill's own radius — the island is
 * a sibling of `ComposerInteractionStack`, sharing its chrome, never absorbing
 * it. Reduced motion via the app's `use-reduced-motion`.
 */
import * as React from "react";
import {
  ArrowSquareOutIcon,
  CheckCircleIcon,
  CircleIcon,
  EyeIcon,
  GlobeSimpleIcon,
  type Icon as PhosphorIcon,
  ListChecksIcon,
  PushPinSimpleIcon,
  StopIcon,
  TerminalWindowIcon,
  UsersIcon,
  XIcon,
} from "@phosphor-icons/react";
import { COMPOSER_STACK_SHELL } from "@volli/session-presentation";
import { AnimatePresence, motion } from "motion/react";

import {
  type ActivityIslandActions,
  type ActivityIslandFeel,
  type ActivityIslandModel,
  agentDimmed,
  agentsHeading,
  agentsLine,
  agentStateWord,
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
  splitFlash,
  summaryLine,
  tabsHeading,
  tabsLine,
  tabsLoading,
  tabStateWord,
} from "./activity-island-model";
import { Button } from "@renderer/components/ui/button";
import { ListRow } from "@renderer/components/ui/list-row";
import { Popover, PopoverAnchor, PopoverContent } from "@renderer/components/ui/popover";
import { StatusDot } from "@renderer/components/ui/status-dot";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip";
import { useReducedMotion } from "@renderer/hooks/use-reduced-motion";
import { cn } from "@renderer/lib/utils";

/* ------------------------------------------------------------------ motion */

const EASE_OUT = [0.23, 1, 0.32, 1] as const;

/** The pill's one spring — reduced motion collapses it to a fast fade-scale. */
function islandSpring(feel: ActivityIslandFeel, reduce: boolean) {
  return reduce
    ? ({ duration: 0.15, ease: EASE_OUT } as const)
    : ({ type: "spring", duration: feel.springDuration, bounce: feel.springBounce } as const);
}

/** Entry/exit for anything living inside the pill; the pill's layout spring does the width. */
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
function useHeldFlash(flash: IslandFlash | null, holdSeconds: number): IslandFlash | null {
  const [expiredId, setExpiredId] = React.useState<string | null>(null);
  // Keyed on the id, not the object: a re-projection that hands the same
  // announcement in a new object must not restart its hold.
  const flashId = flash?.id ?? null;
  React.useEffect(() => {
    if (flashId === null) return;
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
}

const CARD_UNFRAMED: CardFrame = { pinned: false, reveal: "always", arm: false, togglePin() {} };
const CardContext = React.createContext<CardFrame>(CARD_UNFRAMED);

/** Cards act through the verbs directly — the clusters never learn them. */
const ActionsContext = React.createContext<ActivityIslandActions | null>(null);

function useActions(): ActivityIslandActions {
  const actions = React.useContext(ActionsContext);
  if (!actions) throw new Error("ActivityIsland cards render only inside the island");
  return actions;
}

/* ----------------------------------------------------------- cluster shell */

/** One cluster's hover shell: nothing, a one-line tooltip, or a rich card. */
function ClusterShell({
  cluster,
  feel,
  line,
  detail,
  cardClassName,
  children,
}: React.PropsWithChildren<{
  cluster: IslandCluster;
  feel: ActivityIslandFeel;
  line: string;
  detail: React.ReactNode;
  /** Card width — the agents card earns more room for three row actions. */
  cardClassName?: string;
}>) {
  const id = React.useId();
  const coordination = React.useContext(HoverContext);
  const anchorRef = React.useRef<HTMLSpanElement>(null);
  const contentRef = React.useRef<HTMLDivElement>(null);
  const focusOnPin = React.useRef(false);
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
    }),
    [pinned, feel.reveal, feel.armDestructive, coordination, id],
  );

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
    const open = pinned || coordination.hovered === id;
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
          className={cn("p-1 data-[state=closed]:duration-75", cardClassName ?? "w-72")}
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
 *  • ROW = VERB. Activating a row does the obvious promotion — tab → Browser
 *    pane, subagent → overlay, shell → output, plan step → jump — on
 *    `ListRow`'s own activatable branch, so hover fill and focus ring come
 *    for free and an inert row cannot lie.
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
}: React.PropsWithChildren<{ glyph: PhosphorIcon; heading: string }>) {
  const frame = React.useContext(CardContext);
  return (
    <div className="flex cursor-default flex-col select-none">
      <div className="flex h-6 items-center gap-1.5 px-2">
        <Glyph className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-label font-medium text-muted-foreground uppercase">
          {heading}
        </span>
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
              <PushPinSimpleIcon weight={frame.pinned ? "fill" : "regular"} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">{frame.pinned ? "Unpin · Esc" : "Pin open"}</TooltipContent>
        </Tooltip>
      </div>
      {children}
    </div>
  );
}

function CardRows({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col", className)}>
      <AnimatePresence mode="popLayout" initial={false}>
        {children}
      </AnimatePresence>
    </div>
  );
}

/** A `ListRow` that enters, leaves and reflows as its subject does. */
function CardRow({ reduce, ...row }: { reduce: boolean } & React.ComponentProps<typeof ListRow>) {
  return (
    <motion.div
      layout
      initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.97 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.97 }}
      transition={{ duration: 0.16, ease: EASE_OUT }}
    >
      <ListRow data-card-row="" {...row} />
    </motion.div>
  );
}

/** The state word riding the name's line — `· loading`, `· 72%`, `· exit 137`. Nothing when there is nothing to say. */
function RowState({ children }: { children: string | null }) {
  if (children === null) return null;
  return <span className="shrink-0 text-label text-muted-foreground">· {children}</span>;
}

function RowActions({ children }: React.PropsWithChildren) {
  const { reveal, pinned } = React.useContext(CardContext);
  if (reveal === "pinned" && !pinned) return null;
  return (
    <span
      className={cn(
        "flex shrink-0 items-center",
        reveal === "hover" &&
          "opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100",
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
  onPress,
  children,
}: React.PropsWithChildren<{
  label: string;
  armedLabel?: string;
  destructive?: boolean;
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
            if (destructive && arm && !armed) {
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
      style={{ backgroundColor: tab.tone }}
    >
      {tab.host.charAt(0).toUpperCase()}
    </span>
  );
}

function TabsCard({ tabs, reduce }: { tabs: readonly IslandTab[]; reduce: boolean }) {
  const actions = useActions();
  return (
    <Card glyph={GlobeSimpleIcon} heading={tabsHeading(tabs)}>
      <CardRows>
        {tabs.map((tab) => (
          <CardRow
            key={tab.id}
            reduce={reduce}
            data-island-row={tab.id}
            leading={<TabChip tab={tab} />}
            primary={tab.host}
            primaryTrailing={<RowState>{tabStateWord(tab)}</RowState>}
            onActivate={() => actions.promoteTab(tab.id)}
            actions={
              <RowActions>
                <ActionButton
                  label={tab.promoted ? "Focus Browser pane" : "Open in Browser pane"}
                  onPress={() => actions.promoteTab(tab.id)}
                >
                  <ArrowSquareOutIcon />
                </ActionButton>
                <ActionButton
                  label="Close tab"
                  armedLabel="Click again to close"
                  destructive
                  onPress={() => actions.closeTab(tab.id)}
                >
                  <XIcon />
                </ActionButton>
              </RowActions>
            }
          />
        ))}
      </CardRows>
    </Card>
  );
}

function AgentsCard({ agents, reduce }: { agents: readonly IslandAgent[]; reduce: boolean }) {
  const actions = useActions();
  return (
    <Card glyph={UsersIcon} heading={agentsHeading(agents)}>
      <CardRows>
        {agents.map((agent) => (
          <CardRow
            key={agent.id}
            reduce={reduce}
            data-island-row={agent.id}
            leading={<AgentDot agent={agent} reduce={reduce} />}
            primary={agent.label}
            primaryTrailing={<RowState>{agentStateWord(agent)}</RowState>}
            onActivate={() => actions.peekAgent(agent.id)}
            actions={
              <RowActions>
                <ActionButton label="Peek in overlay" onPress={() => actions.peekAgent(agent.id)}>
                  <EyeIcon />
                </ActionButton>
                <ActionButton
                  label={agent.promoted ? "Focus tab" : "Open as tab"}
                  onPress={() => actions.promoteAgent(agent.id)}
                >
                  <ArrowSquareOutIcon />
                </ActionButton>
                {agent.state === "working" ? (
                  <ActionButton
                    label="Stop subagent"
                    armedLabel="Click again to stop"
                    destructive
                    onPress={() => actions.stopAgent(agent.id)}
                  >
                    <StopIcon weight="fill" />
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

function PlanCard({ plan, reduce }: { plan: IslandPlan; reduce: boolean }) {
  const actions = useActions();
  return (
    <Card glyph={ListChecksIcon} heading={planHeading(plan)}>
      {/* Progress as a hairline under the header — the header's number says
          it, the bar lets a glance read it without parsing. */}
      <div className="mx-2 mb-1 h-0.5 overflow-hidden rounded-full bg-border">
        <motion.div
          className="h-full rounded-full bg-primary"
          initial={false}
          animate={{ width: `${planPercent(plan)}%` }}
          transition={reduce ? { duration: 0.1 } : { type: "spring", duration: 0.55, bounce: 0 }}
        />
      </div>
      {/* Compact rows and a scroll cap: a plan is the one list that can run
          to twenty entries, and a card taller than the room above the pill
          makes Radix flip it BELOW the island, over the composer. Seven steps
          fit without scrolling; twenty scroll inside the same card. */}
      <CardRows className="max-h-72 overflow-y-auto">
        {plan.steps.map((step, index) => {
          const state = planStepState(plan, index);
          return (
            <CardRow
              key={step}
              reduce={reduce}
              data-island-row={`step-${index}`}
              className="py-1"
              leading={
                state === "done" ? (
                  <CheckCircleIcon weight="fill" className="size-3.5 shrink-0 text-primary" />
                ) : (
                  <CircleIcon
                    weight={state === "current" ? "bold" : "regular"}
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
                    "min-w-0 truncate text-ui",
                    state === "done" && "text-muted-foreground line-through",
                    state === "current" && "font-medium",
                  )}
                >
                  {step}
                </span>
              }
              primaryTrailing={<RowState>{state === "current" ? "now" : null}</RowState>}
              onActivate={() => actions.jumpStep(index)}
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
    <Card glyph={TerminalWindowIcon} heading={shellsHeading(shells)}>
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
                  <ArrowSquareOutIcon />
                </ActionButton>
                {shell.state === "running" ? (
                  <ActionButton
                    label="Kill shell"
                    armedLabel="Click again to kill"
                    destructive
                    onPress={() => actions.killShell(shell.id)}
                  >
                    <StopIcon weight="fill" />
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
}

function TabsCluster({ tabs, feel, reduce }: ClusterProps & { tabs: readonly IslandTab[] }) {
  return (
    <ClusterShell
      cluster="tabs"
      feel={feel}
      line={tabsLine(tabs)}
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
          <GlobeSimpleIcon className="block size-3.5 text-muted-foreground" />
          {tabsLoading(tabs) ? <WorkingArc reduce={reduce} inset={3} /> : null}
        </span>
        <span className="text-label font-medium tabular-nums text-foreground">{tabs.length}</span>
      </span>
    </ClusterShell>
  );
}

/**
 * One subagent as a round toned chip — the people idiom ON PURPOSE, because
 * subagents are the pill's workers. State rides the chip without moving it:
 * working wears the arc, failed dims and takes a destructive badge, stopped
 * dims without one, done just rests. Same drawing in the pill stack and the
 * card rows.
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
    <motion.span
      layout
      {...clusterPresence(reduce)}
      data-agent-state={agent.state}
      className={cn(
        "relative flex size-4 shrink-0 items-center justify-center rounded-full",
        agentDimmed(agent) && "opacity-60",
        className,
      )}
      style={{ backgroundColor: agent.tone, borderRadius: 999 }}
    >
      <span className="text-label leading-none font-semibold text-white">
        {agent.label.charAt(0).toUpperCase()}
      </span>
      {agent.state === "working" ? <WorkingArc reduce={reduce} inset={2} /> : null}
      {agent.state === "failed" ? (
        <span className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-destructive ring-2 ring-card" />
      ) : null}
    </motion.span>
  );
}

function AgentsCluster({
  agents,
  feel,
  reduce,
}: ClusterProps & { agents: readonly IslandAgent[] }) {
  return (
    <ClusterShell
      cluster="agents"
      feel={feel}
      line={agentsLine(agents)}
      cardClassName="w-80"
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

function PlanCluster({ plan, feel, reduce }: ClusterProps & { plan: IslandPlan }) {
  return (
    <ClusterShell
      cluster="plan"
      feel={feel}
      line={planLine(plan)}
      detail={<PlanCard plan={plan} reduce={reduce} />}
    >
      <motion.span layout {...clusterPresence(reduce)} className="flex items-center gap-1">
        <ListChecksIcon className="size-3.5 text-muted-foreground" />
        <span className="text-label font-medium tabular-nums text-foreground">
          {plan.done}/{plan.steps.length}
        </span>
      </motion.span>
    </ClusterShell>
  );
}

function ShellsCluster({
  shells,
  feel,
  reduce,
}: ClusterProps & { shells: readonly IslandShell[] }) {
  const running = shellsRunning(shells) > 0;
  return (
    <ClusterShell
      cluster="shells"
      feel={feel}
      line={shellsLine(shells)}
      detail={<ShellsCard shells={shells} reduce={reduce} />}
    >
      {/* State lives IN the glyph — fill + primary while running, outline +
          muted at rest. The corner badge died of geometry: a dot needs a
          filled shape to sit on, and a line icon's corner gives it nothing.
          The agent chips keep their badges — they are filled disks. */}
      <motion.span layout {...clusterPresence(reduce)} className="flex items-center">
        <TerminalWindowIcon
          weight={running ? "fill" : "regular"}
          data-running={running ? "" : undefined}
          className={cn(
            "size-3.5",
            running ? "text-primary" : "text-muted-foreground",
            running && !reduce && "animate-pulse",
          )}
        />
      </motion.span>
    </ClusterShell>
  );
}

/* ------------------------------------------------------------ now channel */

/**
 * The now channel's voice. Every flash shares one grammar — `event · payload`
 * — so weight can articulate it instead of decorating it: the event class
 * stays quiet and the payload (the thing that actually changed) carries the
 * emphasis. `quiet` and `loud` are the flat registers on either side.
 */
function FlashText({ text, voice }: { text: string; voice: IslandNowVoice }) {
  const split = voice === "payload" ? splitFlash(text) : null;
  if (!split) {
    return (
      <span
        className={cn(
          "min-w-0 truncate",
          voice === "loud" ? "font-medium text-foreground" : "text-muted-foreground",
        )}
      >
        {text}
      </span>
    );
  }
  return (
    <span className="min-w-0 truncate text-muted-foreground">
      {split.event}
      {" · "}
      <span className="font-medium text-foreground">{split.payload}</span>
    </span>
  );
}

/* ----------------------------------------------------------------- island */

export interface ActivityIslandProps {
  model: ActivityIslandModel;
  actions: ActivityIslandActions;
  /** Overrides on the baked verdicts — for the lab harness's dials. */
  feel?: Partial<ActivityIslandFeel>;
  /** On the centering wrapper; the mount decides the spacing to the composer. */
  className?: string;
}

export function ActivityIsland({
  model,
  actions,
  feel: feelOverride,
  className,
}: ActivityIslandProps) {
  const feel = resolveFeel(feelOverride);
  const osReduce = useReducedMotion();
  const reduce = osReduce || feel.forceReducedMotion;
  const populated = !islandEmpty(model);
  const flash = useHeldFlash(model.flash, feel.flashHoldSeconds);
  const spring = islandSpring(feel, reduce);

  const clustersVisible = feel.grammar !== "now-only";
  /** clusters-now sends the channel to the drop; now-only keeps it inline. */
  const drop = feel.grammar === "clusters-now" ? flash : null;
  const inlineText = feel.grammar === "now-only" ? (flash?.text ?? summaryLine(model)) : null;
  const inlineKey = flash ? `flash-${flash.id}` : `summary-${inlineText ?? ""}`;

  const coordination = useHoverCoordination();

  const clusterProps = { feel, reduce };
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
        <div className={cn("flex justify-center", className)}>
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
                  reduce ? { opacity: 0 } : { opacity: 0, transform: "translateY(8px) scale(0.97)" }
                }
                transition={reduce ? { duration: 0.15, ease: EASE_OUT } : spring}
                role="status"
                aria-label="Agent activity"
                data-activity-island=""
                className="relative will-change-transform"
              >
                {/* The now channel: a drop that buds off the pill upward, hangs
                    while the message reads, and merges back. `mode="wait"` IS
                    the metaphor: a new event waits for the old drop to return
                    first. TWO hard rules, learned the hard way (a drop once sat
                    at full opacity across the pill's face for its whole hold):
                    • geometry is INLINE STYLE — `bottom-full`/`-z-10` are used
                      nowhere else in the app, and a first-use utility a stale
                      Tailwind scan drops is a silent lie; inline `bottom`/
                      `zIndex` cannot be dropped.
                    • the travel NEVER crosses the pill's top edge — the drop
                      rises and fades entirely inside the gap, so no stacking
                      rule in any browser decides what the reader sees. The
                      wrapper carries no transform of its own (flex-centering,
                      not translate), because Motion owns `transform` on the
                      drop. */}
                {feel.grammar === "clusters-now" ? (
                  <span
                    className="pointer-events-none absolute inset-x-0 flex justify-center"
                    style={{ bottom: "100%", paddingBottom: 8, zIndex: -1 }}
                  >
                    <AnimatePresence initial={false} mode="wait">
                      {drop ? (
                        <motion.span
                          key={drop.id}
                          data-island-flash=""
                          initial={
                            reduce
                              ? { opacity: 0 }
                              : { opacity: 0, y: 10, scale: 0.6, filter: "blur(2px)" }
                          }
                          animate={{ opacity: 1, y: 0, scale: 1, filter: "blur(0px)" }}
                          exit={
                            reduce
                              ? { opacity: 0, transition: { duration: 0.1 } }
                              : {
                                  opacity: 0,
                                  y: 8,
                                  scale: 0.55,
                                  filter: "blur(2px)",
                                  transition: { duration: 0.18, ease: EASE_OUT },
                                }
                          }
                          transition={
                            reduce
                              ? { duration: 0.15 }
                              : {
                                  y: spring,
                                  scale: spring,
                                  opacity: { duration: 0.15, ease: EASE_OUT },
                                  filter: { duration: 0.18, ease: EASE_OUT },
                                }
                          }
                          style={{ originY: 1 }}
                          className={cn(
                            "flex h-7 max-w-72 items-center rounded-full px-2 text-ui",
                            COMPOSER_STACK_SHELL,
                          )}
                        >
                          <FlashText text={drop.text} voice={feel.nowVoice} />
                        </motion.span>
                      ) : null}
                    </AnimatePresence>
                  </span>
                ) : null}
                {/* `rounded-full` over the stack shell's container radius (the
                    `rounded` group is registered with tailwind-merge, so the
                    later class wins); the inline `borderRadius` is what Motion
                    corrects during the layout spring so the corners do not
                    stretch mid-morph. */}
                <motion.div
                  layout
                  transition={spring}
                  style={{ borderRadius: 999 }}
                  className={cn(
                    "flex h-8 items-center gap-2 rounded-full px-2",
                    COMPOSER_STACK_SHELL,
                  )}
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
                    {inlineText ? (
                      <motion.span
                        key={inlineKey}
                        data-island-ticker=""
                        initial={
                          reduce ? { opacity: 0 } : { opacity: 0, y: 7, filter: "blur(4px)" }
                        }
                        animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                        exit={reduce ? { opacity: 0 } : { opacity: 0, y: -7, filter: "blur(4px)" }}
                        transition={reduce ? { duration: 0.1 } : { duration: 0.18, ease: EASE_OUT }}
                        className="flex max-w-56 items-center text-ui"
                      >
                        {flash ? (
                          <FlashText text={inlineText} voice={feel.nowVoice} />
                        ) : (
                          <span className="min-w-0 truncate text-muted-foreground">
                            {inlineText}
                          </span>
                        )}
                      </motion.span>
                    ) : null}
                  </AnimatePresence>
                </motion.div>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
      </HoverContext.Provider>
    </ActionsContext.Provider>
  );
}
