/**
 * Activity Island · the closed-state feel playground (VC-248, map VC-247).
 *
 * The question this scratch resolves: which closed-state grammar and feel
 * parameters make the island read at a glance? It mounts a simulated session's
 * active elements — browser tabs, subagents, a plan, background shells — above
 * the REAL SessionComposer, and puts every contested feel decision behind a
 * dial so candidates are compared live in one sitting rather than across
 * commits:
 *
 *   • grammar — per-element clusters + a morphing "now" slot, now-only,
 *     or clusters-only
 *   • spring duration/bounce for the pill's width morphs
 *   • event-flash hold time
 *   • hover treatment — none, tooltip, or a rich status popover (dock-feel
 *     candidates; magnification belongs to VC-249 with the tray)
 *   • heartbeat on/off, and a force-reduced-motion preview
 *
 * Decisions already fixed upstream of the dials (charting round on VC-246):
 * the island is a sibling of the interaction stack sharing its material; it
 * does not exist when the session has nothing to model; excluded state
 * (model/effort/context/queue) stays in the composer footer; Motion +
 * hand-rolled SVG, no GSAP.
 *
 * Everything here is fixture-driven — no runtime, no bridge. The element
 * shapes are deliberately *presentational* stand-ins; the durable projection
 * contract is the migration effort's question, not this scratch's.
 */
import * as React from "react";
import {
  GlobeSimpleIcon,
  ListChecksIcon,
  PlayIcon,
  TerminalWindowIcon,
} from "@phosphor-icons/react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";

import { SessionComposer, type ComposerModel } from "@renderer/components/chat/composer-ui";
import { ContentColumn } from "@renderer/components/layout/content-column";
import { Button } from "@renderer/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover";
import { Segmented } from "@renderer/components/ui/segmented";
import { ThinkingOrbs } from "@renderer/components/ui/thinking-orbs";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@renderer/components/ui/tooltip";
import { cn } from "@renderer/lib/utils";

export const title = "Activity Island · feel playground";
export const note =
  "VC-248 — closed-state grammar, spring feel, flash hold and hover treatment as live dials";
export const viewport = "stage" as const;

/* ------------------------------------------------------------- simulation */

interface TabSim {
  id: number;
  host: string;
  tone: string;
  state: "loading" | "ready";
}

interface AgentSim {
  id: number;
  label: string;
  tone: string;
  /** 0..1 */
  progress: number;
  state: "working" | "done" | "failed";
}

interface PlanSim {
  done: number;
  total: number;
  current: string;
}

interface ShellSim {
  id: number;
  command: string;
  state: "running" | "exited";
}

interface Flash {
  id: number;
  text: string;
}

type Grammar = "clusters-now" | "now-only" | "clusters-only";
type HoverMode = "none" | "tooltip" | "popover";

interface Dials {
  grammar: Grammar;
  /** Spring settle time, seconds. */
  duration: number;
  /** Spring bounce, 0..0.4. */
  bounce: number;
  /** Seconds a now-slot flash holds before receding. */
  flashHold: number;
  hover: HoverMode;
  heartbeat: boolean;
  forceReduced: boolean;
}

const DEFAULT_DIALS: Dials = {
  grammar: "clusters-now",
  duration: 0.5,
  bounce: 0.2,
  flashHold: 1.6,
  hover: "popover",
  heartbeat: true,
  forceReduced: false,
};

/** Project-tile-ish tones — worn by the subagent chips. Fixture data, not tokens. */
const SIM_TONES = ["#e8652a", "#3577f2", "#2fa36b", "#a65cd6", "#d1a03c"] as const;

const TAB_HOSTS = [
  "localhost:5177",
  "github.com",
  "easing.dev",
  "motion.dev",
  "npmjs.com",
] as const;

const AGENT_LABELS = ["Audit icon weights", "Grep theme tokens", "Draft smoke plan"] as const;

const SHELL_COMMANDS = ["pnpm lab", "vp check", "pnpm test"] as const;

const PLAN_STEPS = [
  "Read composer stack",
  "Sketch closed pill",
  "Wire feel dials",
  "Cluster drawings",
  "Hover treatments",
  "Reduced motion pass",
  "Record verdicts",
] as const;

/* ------------------------------------------------------------ island atoms */

const EASE_OUT = [0.23, 1, 0.32, 1] as const;

/** The pill's one spring, from the dials — reduced motion collapses it to a fast fade-scale. */
function islandSpring(dials: Dials, reduce: boolean) {
  return reduce
    ? ({ duration: 0.15, ease: EASE_OUT } as const)
    : ({ type: "spring", duration: dials.duration, bounce: dials.bounce } as const);
}

/**
 * While anything is genuinely running the island carries a live arc; settled,
 * a quiet dot. Spin is CSS (`animate-spin`) so it stays smooth under load, and
 * both the OS preference and the force dial stop the rotation rather than the
 * indicator.
 */
/**
 * The heartbeat owns a FIXED 14px slot whether working or settled — the arc
 * collapses into the resting dot inside the same box. The first cut returned a
 * 6px dot or a 14px arc from the same position, so settling shifted every
 * cluster leftward and the pill read as misaligned (the thing VC-248's first
 * live round caught). Spin stays a CSS animation on the inner svg so Motion's
 * scale on the wrapper never fights the keyframed transform.
 */
function Heartbeat({ working, reduce }: { working: boolean; reduce: boolean }) {
  return (
    <span
      role="img"
      aria-label={working ? "Agent working" : "Agent settled"}
      className="relative flex size-3.5 shrink-0 items-center justify-center"
    >
      <AnimatePresence initial={false}>
        {working ? (
          <motion.span
            key="arc"
            initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.5 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.4 }}
            transition={{ duration: 0.18, ease: EASE_OUT }}
            className="absolute inset-0"
          >
            <svg
              viewBox="0 0 16 16"
              className={cn("block size-3.5 text-primary", reduce ? "" : "animate-spin")}
            >
              <circle
                cx="8"
                cy="8"
                r="5.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeDasharray="24 10.6"
              />
            </svg>
          </motion.span>
        ) : (
          <motion.span
            key="dot"
            initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.5 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.5 }}
            transition={{ duration: 0.18, ease: EASE_OUT }}
            className="absolute inset-0 flex items-center justify-center"
          >
            <span className="size-1.5 rounded-full bg-primary/70" />
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  );
}

/**
 * Hover coordination for the popover mode: ONE cluster's card at a time,
 * switched instantly. Radix keeps each popover its own root, so two shells
 * animating independently overlap during a hand-off; routing hover through
 * shared state means entering B closes A in the same frame, and the only
 * grace period is leaving to nothing (140ms, so crossing the gap between
 * clusters does not flicker the card).
 */
interface HoverCoordination {
  hovered: string | null;
  enter(id: string): void;
  leave(id: string): void;
}

const HoverContext = React.createContext<HoverCoordination | null>(null);

/** One cluster's hover shell: nothing, a one-line tooltip, or a rich status popover. */
function ClusterShell({
  mode,
  line,
  detail,
  children,
}: React.PropsWithChildren<{ mode: HoverMode; line: string; detail: React.ReactNode }>) {
  const id = React.useId();
  const coordination = React.useContext(HoverContext);

  if (mode === "tooltip") {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="flex items-center">{children}</span>
        </TooltipTrigger>
        <TooltipContent side="top">{line}</TooltipContent>
      </Tooltip>
    );
  }
  if (mode === "popover" && coordination) {
    const open = coordination.hovered === id;
    return (
      <Popover
        open={open}
        onOpenChange={(next) => {
          if (!next) coordination.leave(id);
        }}
      >
        <PopoverTrigger asChild>
          <span
            className="flex items-center"
            onMouseEnter={() => coordination.enter(id)}
            onMouseLeave={() => coordination.leave(id)}
          >
            {children}
          </span>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="center"
          sideOffset={10}
          className="w-64 p-2 data-[state=closed]:duration-75"
          onOpenAutoFocus={(event) => event.preventDefault()}
          onMouseEnter={() => coordination.enter(id)}
          onMouseLeave={() => coordination.leave(id)}
        >
          {detail}
        </PopoverContent>
      </Popover>
    );
  }
  return <span className="flex items-center">{children}</span>;
}

/** Entry/exit for anything living inside the pill; the pill's layout spring does the width. */
function clusterPresence(reduce: boolean) {
  return {
    initial: reduce ? { opacity: 0 } : { opacity: 0, scale: 0.6 },
    animate: { opacity: 1, scale: 1 },
    exit: reduce ? { opacity: 0 } : { opacity: 0, scale: 0.6 },
  } as const;
}

function TabsCluster({ tabs, dials, reduce }: { tabs: TabSim[]; dials: Dials; reduce: boolean }) {
  const line =
    tabs.length === 1 ? `1 browser tab · ${tabs[0]?.host ?? ""}` : `${tabs.length} browser tabs`;
  return (
    <ClusterShell
      mode={dials.hover}
      line={line}
      detail={
        <div className="flex flex-col gap-1">
          {tabs.map((tab) => (
            <div key={tab.id} className="flex items-center gap-2 px-2 py-1 text-ui">
              <span className="min-w-0 flex-1 truncate text-foreground">{tab.host}</span>
              <span className="text-label uppercase text-muted-foreground">
                {tab.state === "loading" ? "loading" : "ready"}
              </span>
            </div>
          ))}
        </div>
      }
    >
      {/* Tabs compress to namespace glyph + count — the colored chips belong
          to the SUBAGENTS now (they are the workers; circles + letters is the
          people idiom, and this pill has exactly one people-cluster). Identity
          per tab lives in the popover. While any tab is loading, the browser's
          own idiom — an arc — orbits the globe. */}
      <span className="flex items-center gap-1">
        <span className="relative flex size-5 shrink-0 items-center justify-center">
          <GlobeSimpleIcon className="block size-3.5 text-muted-foreground" />
          {tabs.some((tab) => tab.state === "loading") ? (
            <svg
              viewBox="0 0 20 20"
              className={cn(
                "absolute inset-0 block size-5 text-primary",
                reduce ? "" : "animate-spin",
              )}
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
          ) : null}
        </span>
        <span className="text-label font-medium tabular-nums text-foreground">{tabs.length}</span>
      </span>
    </ClusterShell>
  );
}

/**
 * One subagent as a round toned chip — the people idiom ON PURPOSE, because
 * subagents are the pill's workers. State rides the chip without moving it:
 * working wears the loading arc, failed dims and takes a destructive badge,
 * done just rests. Same drawing in the pill stack and the popover rows.
 */
function AgentDot({
  agent,
  reduce,
  className,
}: {
  agent: AgentSim;
  reduce: boolean;
  className?: string;
}) {
  return (
    <motion.span
      layout
      {...clusterPresence(reduce)}
      className={cn(
        "relative flex size-4 shrink-0 items-center justify-center rounded-full",
        agent.state === "failed" && "opacity-60",
        className,
      )}
      style={{ backgroundColor: agent.tone, borderRadius: 999 }}
    >
      <span className="text-label leading-none font-semibold text-white">
        {agent.label.charAt(0).toUpperCase()}
      </span>
      {agent.state === "working" ? (
        <svg
          viewBox="0 0 20 20"
          className={cn(
            "absolute -inset-0.5 block size-5 text-primary",
            reduce ? "" : "animate-spin",
          )}
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
      ) : null}
      {agent.state === "failed" ? (
        <span className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-destructive ring-2 ring-card" />
      ) : null}
    </motion.span>
  );
}

function AgentsCluster({
  agents,
  dials,
  reduce,
}: {
  agents: AgentSim[];
  dials: Dials;
  reduce: boolean;
}) {
  const working = agents.filter((agent) => agent.state === "working").length;
  const line =
    working > 0
      ? `${agents.length} subagent${agents.length === 1 ? "" : "s"} · ${working} working`
      : `${agents.length} subagent${agents.length === 1 ? "" : "s"} · settled`;
  return (
    <ClusterShell
      mode={dials.hover}
      line={line}
      detail={
        <div className="flex flex-col gap-1">
          {agents.map((agent) => (
            <div key={agent.id} className="flex items-center gap-2 px-2 py-1 text-ui">
              <AgentDot agent={agent} reduce={reduce} />
              <span className="min-w-0 flex-1 truncate text-foreground">{agent.label}</span>
              <span className="text-label uppercase text-muted-foreground">
                {agent.state === "working" ? `${Math.round(agent.progress * 100)}%` : agent.state}
              </span>
            </div>
          ))}
        </div>
      }
    >
      {/* Orbs lead as the life sign — breathing while any subagent works,
          resting as still dots when settled — and the toned chips carry
          identity, stacked with overlap and capped at four so the width stays
          bounded however many spawn. */}
      <span className="flex items-center gap-1">
        {/* The forced-reduced dial must still the orbs too — ThinkingOrbs only
            honors the real OS preference — so under `reduce` the working state
            keeps its color but loses its pulse. */}
        {working > 0 && !reduce ? (
          <ThinkingOrbs className="text-primary" />
        ) : (
          <span
            aria-hidden
            className={cn(
              "flex shrink-0 items-center gap-0.5",
              working > 0 ? "text-primary" : "text-muted-foreground",
            )}
          >
            <span className="size-1 rounded-full bg-current" />
            <span className="size-1 rounded-full bg-current" />
            <span className="size-1 rounded-full bg-current" />
          </span>
        )}
        <span className="flex items-center">
          {agents.slice(0, 4).map((agent, index) => (
            <AgentDot
              key={agent.id}
              agent={agent}
              reduce={reduce}
              className={cn("ring-2 ring-card", index > 0 && "-ml-1")}
            />
          ))}
          {agents.length > 4 ? (
            <span className="ml-1 text-label text-muted-foreground">+{agents.length - 4}</span>
          ) : null}
        </span>
      </span>
    </ClusterShell>
  );
}

function PlanCluster({ plan, dials, reduce }: { plan: PlanSim; dials: Dials; reduce: boolean }) {
  return (
    <ClusterShell
      mode={dials.hover}
      line={`Plan ${plan.done}/${plan.total} · ${plan.current}`}
      detail={
        <div className="flex flex-col gap-1 px-2 py-1">
          {PLAN_STEPS.slice(0, plan.total).map((step, index) => (
            <div key={step} className="flex items-center gap-2 text-ui">
              <span
                className={cn(
                  "size-1.5 rounded-full",
                  index < plan.done ? "bg-primary" : "bg-border",
                )}
              />
              <span
                className={cn(
                  index < plan.done ? "text-muted-foreground line-through" : "text-foreground",
                  index === plan.done && "font-medium",
                )}
              >
                {step}
              </span>
            </div>
          ))}
        </div>
      }
    >
      <motion.span layout {...clusterPresence(reduce)} className="flex items-center gap-1">
        <ListChecksIcon className="size-3.5 text-muted-foreground" />
        <span className="text-label font-medium tabular-nums text-foreground">
          {plan.done}/{plan.total}
        </span>
      </motion.span>
    </ClusterShell>
  );
}

function ShellsCluster({
  shells,
  dials,
  reduce,
}: {
  shells: ShellSim[];
  dials: Dials;
  reduce: boolean;
}) {
  const running = shells.filter((shell) => shell.state === "running").length;
  return (
    <ClusterShell
      mode={dials.hover}
      line={
        running > 0
          ? `${running} shell${running === 1 ? "" : "s"} running`
          : `${shells.length} shell${shells.length === 1 ? "" : "s"} · exited`
      }
      detail={
        <div className="flex flex-col gap-1">
          {shells.map((shell) => (
            <div key={shell.id} className="flex items-center gap-2 px-2 py-1 text-ui">
              <TerminalWindowIcon className="size-3.5 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate font-mono text-foreground">
                {shell.command}
              </span>
              <span className="text-label uppercase text-muted-foreground">{shell.state}</span>
            </div>
          ))}
        </div>
      }
    >
      <motion.span layout {...clusterPresence(reduce)} className="relative flex items-center">
        <TerminalWindowIcon className="size-3.5 text-muted-foreground" />
        {running > 0 ? (
          <span
            className={cn(
              "absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-primary",
              reduce ? "" : "animate-pulse",
            )}
          />
        ) : null}
      </motion.span>
    </ClusterShell>
  );
}

/* ----------------------------------------------------------------- island */

function summaryLine(tabs: TabSim[], agents: AgentSim[], plan: PlanSim | null): string {
  const parts: string[] = [];
  if (tabs.length > 0) parts.push(`${tabs.length} tab${tabs.length === 1 ? "" : "s"}`);
  const working = agents.filter((agent) => agent.state === "working");
  if (working.length > 0) {
    const mean = working.reduce((sum, agent) => sum + agent.progress, 0) / working.length;
    parts.push(`agents ${Math.round(mean * 100)}%`);
  } else if (agents.length > 0) parts.push("agents settled");
  if (plan) parts.push(`plan ${plan.done}/${plan.total}`);
  return parts.join(" · ");
}

function ActivityIsland({
  tabs,
  agents,
  plan,
  shells,
  flash,
  dials,
}: {
  tabs: TabSim[];
  agents: AgentSim[];
  plan: PlanSim | null;
  shells: ShellSim[];
  flash: Flash | null;
  dials: Dials;
}) {
  const osReduce = useReducedMotion() ?? false;
  const reduce = osReduce || dials.forceReduced;
  const populated = tabs.length > 0 || agents.length > 0 || shells.length > 0 || plan !== null;
  const working =
    tabs.some((tab) => tab.state === "loading") ||
    agents.some((agent) => agent.state === "working") ||
    shells.some((shell) => shell.state === "running");

  const clustersVisible = dials.grammar !== "now-only";
  /** clusters-now sends the channel to the bubble; now-only keeps it inline. */
  const bubble = dials.grammar === "clusters-now" ? flash : null;
  const inlineText =
    dials.grammar === "now-only" ? (flash?.text ?? summaryLine(tabs, agents, plan)) : null;
  const inlineKey = flash ? `flash-${flash.id}` : `summary-${inlineText ?? ""}`;
  const spring = islandSpring(dials, reduce);

  const [hoveredCluster, setHoveredCluster] = React.useState<string | null>(null);
  const leaveTimer = React.useRef<number | null>(null);
  React.useEffect(
    () => () => {
      if (leaveTimer.current !== null) window.clearTimeout(leaveTimer.current);
    },
    [],
  );
  const coordination = React.useMemo<HoverCoordination>(
    () => ({
      hovered: hoveredCluster,
      enter(id) {
        if (leaveTimer.current !== null) {
          window.clearTimeout(leaveTimer.current);
          leaveTimer.current = null;
        }
        setHoveredCluster(id);
      },
      leave(id) {
        if (leaveTimer.current !== null) window.clearTimeout(leaveTimer.current);
        leaveTimer.current = window.setTimeout(() => {
          setHoveredCluster((current) => (current === id ? null : current));
        }, 140);
      },
    }),
    [hoveredCluster],
  );

  return (
    <HoverContext.Provider value={coordination}>
      <div className="flex justify-center pb-2">
        <AnimatePresence initial={false}>
          {populated ? (
            <motion.div
              key="island"
              initial={
                reduce ? { opacity: 0 } : { opacity: 0, transform: "translateY(10px) scale(0.95)" }
              }
              animate={{ opacity: 1, transform: "translateY(0px) scale(1)" }}
              exit={
                reduce ? { opacity: 0 } : { opacity: 0, transform: "translateY(8px) scale(0.97)" }
              }
              transition={reduce ? { duration: 0.15, ease: EASE_OUT } : spring}
              role="status"
              aria-label="Agent activity"
              className="relative will-change-transform"
            >
              {/* The now-channel: a drop that buds off the pill upward, hangs
                while the message reads, and merges back. `mode="wait"` IS the
                metaphor: a new event waits for the old drop to return first.
                TWO hard rules, learned the hard way (a drop once sat at full
                opacity across the pill's face for its whole hold):
                • geometry is INLINE STYLE — `bottom-full`/`-z-10` are used
                  nowhere else in the app, and a first-use utility a stale
                  Tailwind scan drops is a silent lie (lab.css's own warning);
                  inline `bottom`/`zIndex` cannot be dropped.
                • the travel NEVER crosses the pill's top edge — the drop rises
                  and fades entirely inside the gap, so no stacking rule in any
                  browser decides what the reader sees. The wrapper carries no
                  transform of its own (flex-centering, not translate), because
                  Motion owns `transform` on the drop. */}
              {dials.grammar === "clusters-now" ? (
                <span
                  className="pointer-events-none absolute inset-x-0 flex justify-center"
                  style={{ bottom: "100%", paddingBottom: 8, zIndex: -1 }}
                >
                  <AnimatePresence initial={false} mode="wait">
                    {bubble ? (
                      <motion.span
                        key={bubble.id}
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
                        className="flex h-7 max-w-72 items-center rounded-full border border-border bg-card px-2 shadow-raised"
                      >
                        <span className="truncate text-ui text-muted-foreground">
                          {bubble.text}
                        </span>
                      </motion.span>
                    ) : null}
                  </AnimatePresence>
                </span>
              ) : null}
              <motion.div
                layout
                transition={spring}
                style={{ borderRadius: 999 }}
                className="flex h-8 items-center gap-2 border border-border bg-card px-2 shadow-raised"
              >
                {dials.heartbeat ? <Heartbeat working={working} reduce={reduce} /> : null}

                {clustersVisible ? (
                  <AnimatePresence mode="popLayout" initial={false}>
                    {tabs.length > 0 ? (
                      <motion.span
                        key="tabs"
                        layout
                        className="flex shrink-0 items-center"
                        {...clusterPresence(reduce)}
                      >
                        <TabsCluster tabs={tabs} dials={dials} reduce={reduce} />
                      </motion.span>
                    ) : null}
                    {agents.length > 0 ? (
                      <motion.span
                        key="agents"
                        layout
                        className="flex shrink-0 items-center"
                        {...clusterPresence(reduce)}
                      >
                        <AgentsCluster agents={agents} dials={dials} reduce={reduce} />
                      </motion.span>
                    ) : null}
                    {plan ? (
                      <motion.span
                        key="plan"
                        layout
                        className="flex shrink-0 items-center"
                        {...clusterPresence(reduce)}
                      >
                        <PlanCluster plan={plan} dials={dials} reduce={reduce} />
                      </motion.span>
                    ) : null}
                    {shells.length > 0 ? (
                      <motion.span
                        key="shells"
                        layout
                        className="flex shrink-0 items-center"
                        {...clusterPresence(reduce)}
                      >
                        <ShellsCluster shells={shells} dials={dials} reduce={reduce} />
                      </motion.span>
                    ) : null}
                  </AnimatePresence>
                ) : null}

                {/* Inline ticker — now-only grammar only; clusters-now sends the
                  channel to the bubble above. NO `layout` prop and no string
                  transforms on these spans — `layout` owns transform, so a
                  string-transform exit never resolves and AnimatePresence
                  keeps the zombie forever (the accumulating-flashes bug). */}
                <AnimatePresence initial={false} mode="wait">
                  {inlineText ? (
                    <motion.span
                      key={inlineKey}
                      initial={reduce ? { opacity: 0 } : { opacity: 0, y: 7, filter: "blur(4px)" }}
                      animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                      exit={reduce ? { opacity: 0 } : { opacity: 0, y: -7, filter: "blur(4px)" }}
                      transition={reduce ? { duration: 0.1 } : { duration: 0.18, ease: EASE_OUT }}
                      className="max-w-56 truncate text-ui text-muted-foreground"
                    >
                      {inlineText}
                    </motion.span>
                  ) : null}
                </AnimatePresence>
              </motion.div>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    </HoverContext.Provider>
  );
}

/* ---------------------------------------------------------------- fixtures */

const MODELS: ComposerModel[] = [
  {
    id: "anthropic/claude-sonnet-4-5",
    label: "sonnet-4.5",
    providerId: "anthropic",
    providerLabel: "Anthropic",
    modelId: "claude-sonnet-4-5",
    reasoningLevels: ["low", "medium", "high"],
  },
];

/** A quiet stand-in transcript so the island reads against content, not void. */
function FakeFeed() {
  return (
    <div className="flex min-h-0 flex-1 flex-col justify-end gap-4 overflow-hidden pb-4">
      <div className="ml-auto max-w-96 rounded-container bg-muted/40 px-4 py-2 text-sm text-muted-foreground">
        Try the browser tab on :5177 and split the audit into subagents.
      </div>
      <div className="flex flex-col gap-2">
        <div className="h-3 w-4/5 rounded-full bg-muted/40" />
        <div className="h-3 w-3/5 rounded-full bg-muted/40" />
        <div className="h-3 w-2/3 rounded-full bg-muted/30" />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ sim reducer */

/**
 * All sim state lives in one PURE reducer, flash included — the flash a
 * mutation announces is part of the state transition itself, never a second
 * `setState` fired from inside an updater. The first cut did exactly that and
 * StrictMode's double-invocation of updaters made announcements fire out of
 * order; a reducer is immune by construction, and it makes the demo script
 * deterministic besides.
 */
interface Sim {
  tabs: TabSim[];
  agents: AgentSim[];
  plan: PlanSim | null;
  shells: ShellSim[];
  flash: Flash | null;
  seq: number;
}

const INITIAL_SIM: Sim = { tabs: [], agents: [], plan: null, shells: [], flash: null, seq: 1 };

type SimAction =
  | { type: "add-tab" }
  | { type: "settle-tabs" }
  | { type: "drop-tab" }
  | { type: "spawn-agent" }
  | { type: "advance-agents" }
  | { type: "complete-agent" }
  | { type: "fail-agent" }
  | { type: "clear-agents" }
  | { type: "start-plan" }
  | { type: "advance-plan" }
  | { type: "clear-plan" }
  | { type: "run-shell" }
  | { type: "exit-shells" }
  | { type: "drop-shells" }
  | { type: "clear-flash"; id: number }
  | { type: "reset" };

/** The transition plus its announcement, atomically. */
function flashed(sim: Sim, text: string): Sim {
  return { ...sim, flash: { id: sim.seq, text }, seq: sim.seq + 1 };
}

function simReducer(sim: Sim, action: SimAction): Sim {
  switch (action.type) {
    case "add-tab": {
      const host = TAB_HOSTS[sim.tabs.length % TAB_HOSTS.length] ?? "localhost";
      const tone = SIM_TONES[sim.tabs.length % SIM_TONES.length] ?? "#3577f2";
      const next = flashed(sim, `Opened ${host}`);
      return {
        ...next,
        tabs: [...sim.tabs, { id: next.seq, host, tone, state: "loading" }],
        seq: next.seq + 1,
      };
    }
    case "settle-tabs":
      return sim.tabs.some((tab) => tab.state === "loading")
        ? {
            ...flashed(sim, "Page loaded"),
            tabs: sim.tabs.map((tab) => ({ ...tab, state: "ready" as const })),
          }
        : sim;
    case "drop-tab": {
      const last = sim.tabs[sim.tabs.length - 1];
      if (!last) return sim;
      return { ...flashed(sim, `Closed ${last.host}`), tabs: sim.tabs.slice(0, -1) };
    }
    case "spawn-agent": {
      const label = AGENT_LABELS[sim.agents.length % AGENT_LABELS.length] ?? "Subagent";
      const tone = SIM_TONES[sim.agents.length % SIM_TONES.length] ?? "#3577f2";
      const next = flashed(sim, `Subagent started · ${label}`);
      return {
        ...next,
        agents: [...sim.agents, { id: next.seq, label, tone, progress: 0.08, state: "working" }],
        seq: next.seq + 1,
      };
    }
    case "advance-agents":
      return {
        ...sim,
        agents: sim.agents.map((agent) =>
          agent.state === "working"
            ? { ...agent, progress: Math.min(1, agent.progress + 0.27) }
            : agent,
        ),
      };
    case "complete-agent": {
      const index = sim.agents.findIndex((agent) => agent.state === "working");
      const target = index === -1 ? undefined : sim.agents[index];
      if (!target) return sim;
      return {
        ...flashed(sim, `Subagent finished · ${target.label}`),
        agents: sim.agents.map((agent, at) =>
          at === index ? { ...agent, progress: 1, state: "done" as const } : agent,
        ),
      };
    }
    case "fail-agent": {
      const index = sim.agents.findIndex((agent) => agent.state === "working");
      const target = index === -1 ? undefined : sim.agents[index];
      if (!target) return sim;
      return {
        ...flashed(sim, `Subagent failed · ${target.label}`),
        agents: sim.agents.map((agent, at) =>
          at === index ? { ...agent, state: "failed" as const } : agent,
        ),
      };
    }
    case "clear-agents":
      return { ...sim, agents: [] };
    case "start-plan":
      return {
        ...flashed(sim, `Plan drafted · ${PLAN_STEPS.length} steps`),
        plan: { done: 0, total: PLAN_STEPS.length, current: PLAN_STEPS[0] ?? "Start" },
      };
    case "advance-plan": {
      if (!sim.plan) return sim;
      const done = Math.min(sim.plan.total, sim.plan.done + 1);
      const current = PLAN_STEPS[done] ?? "Wrap up";
      return {
        ...flashed(sim, `Plan ${done}/${sim.plan.total} · ${current}`),
        plan: { ...sim.plan, done, current },
      };
    }
    case "clear-plan":
      return { ...sim, plan: null };
    case "run-shell": {
      const command = SHELL_COMMANDS[sim.shells.length % SHELL_COMMANDS.length] ?? "sh";
      const next = flashed(sim, `Shell started · ${command}`);
      return {
        ...next,
        shells: [...sim.shells, { id: next.seq, command, state: "running" }],
        seq: next.seq + 1,
      };
    }
    case "exit-shells":
      return sim.shells.some((shell) => shell.state === "running")
        ? {
            ...flashed(sim, "Shell exited · 0"),
            shells: sim.shells.map((shell) => ({ ...shell, state: "exited" as const })),
          }
        : sim;
    case "drop-shells":
      return { ...sim, shells: [] };
    case "clear-flash":
      // Only the flash that asked to be cleared: a newer announcement wins.
      return sim.flash?.id === action.id ? { ...sim, flash: null } : sim;
    case "reset":
      return INITIAL_SIM;
  }
}

/* -------------------------------------------------------------- the scratch */

export default function ActivityIslandPlayground() {
  const [dials, setDials] = React.useState<Dials>(DEFAULT_DIALS);
  const [sim, dispatch] = React.useReducer(simReducer, INITIAL_SIM);
  const [composerValue, setComposerValue] = React.useState("");

  const timers = React.useRef<number[]>([]);
  React.useEffect(
    () => () => {
      for (const timer of timers.current) window.clearTimeout(timer);
    },
    [],
  );

  /** The flash recedes on its own; in now-only the summary takes the slot back. */
  React.useEffect(() => {
    const flash = sim.flash;
    if (!flash) return;
    const timer = window.setTimeout(
      () => dispatch({ type: "clear-flash", id: flash.id }),
      dials.flashHold * 1000,
    );
    return () => window.clearTimeout(timer);
  }, [sim.flash, dials.flashHold]);

  /* ------------------------------------------------ element mutators */

  const addTab = () => dispatch({ type: "add-tab" });
  const settleTabs = () => dispatch({ type: "settle-tabs" });
  const dropTab = () => dispatch({ type: "drop-tab" });
  const spawnAgent = () => dispatch({ type: "spawn-agent" });
  const advanceAgents = () => dispatch({ type: "advance-agents" });
  const completeAgent = () => dispatch({ type: "complete-agent" });
  const failAgent = () => dispatch({ type: "fail-agent" });
  const clearAgents = () => dispatch({ type: "clear-agents" });
  const startPlan = () => dispatch({ type: "start-plan" });
  const advancePlan = () => dispatch({ type: "advance-plan" });
  const clearPlan = () => dispatch({ type: "clear-plan" });
  const runShell = () => dispatch({ type: "run-shell" });
  const exitShells = () => dispatch({ type: "exit-shells" });
  const dropShells = () => dispatch({ type: "drop-shells" });

  const reset = () => {
    for (const timer of timers.current) window.clearTimeout(timer);
    timers.current = [];
    dispatch({ type: "reset" });
  };

  /** A scripted session so morphing is judged as a sequence, not a pose. */
  const playDemo = () => {
    reset();
    const at = (ms: number, run: () => void) => {
      timers.current.push(window.setTimeout(run, ms));
    };
    at(300, startPlan);
    at(1400, addTab);
    at(2600, settleTabs);
    at(3400, spawnAgent);
    at(4200, advancePlan);
    at(4900, advanceAgents);
    at(5600, addTab);
    at(6400, advanceAgents);
    at(6900, settleTabs);
    at(7600, spawnAgent);
    at(8300, advanceAgents);
    at(9000, advancePlan);
    at(9800, completeAgent);
    at(10800, runShell);
    at(11900, advanceAgents);
    at(12600, completeAgent);
    at(13400, exitShells);
    at(14200, advancePlan);
  };

  return (
    <TooltipProvider>
      <div className="flex flex-col gap-6">
        {/* ------------------------------------------------ the stage */}
        <div className="flex h-120 flex-col rounded-xl border border-border bg-background px-4 pt-4">
          <ContentColumn className="flex min-h-0 flex-1 flex-col">
            <FakeFeed />
            <ActivityIsland
              tabs={sim.tabs}
              agents={sim.agents}
              plan={sim.plan}
              shells={sim.shells}
              flash={sim.flash}
              dials={dials}
            />
            <div className="pb-4">
              <SessionComposer
                value={composerValue}
                onValueChange={setComposerValue}
                models={MODELS}
                selection={{
                  providerId: "anthropic",
                  modelId: "claude-sonnet-4-5",
                  reasoningLevel: "high",
                }}
                onSelectionChange={() => undefined}
                working={false}
                ready
                queued={[]}
                onQueuedChange={() => undefined}
                onSteerQueued={() => undefined}
                onSubmit={() => setComposerValue("")}
                onStop={() => undefined}
              />
            </div>
          </ContentColumn>
        </div>

        {/* ------------------------------------------------ drive it */}
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          <section className="flex flex-col gap-2">
            <h2 className="text-label uppercase text-muted-foreground">Drive the session</h2>
            <div className="flex flex-wrap items-center gap-1">
              <Button size="xs" variant="secondary" onClick={playDemo}>
                <PlayIcon /> Play demo
              </Button>
              <Button size="xs" variant="ghost" onClick={reset}>
                Reset
              </Button>
            </div>
            <Row label="Tabs">
              <Button size="xs" variant="ghost" onClick={addTab}>
                + tab
              </Button>
              <Button size="xs" variant="ghost" onClick={settleTabs}>
                loaded
              </Button>
              <Button size="xs" variant="ghost" onClick={dropTab}>
                − tab
              </Button>
            </Row>
            <Row label="Subagents">
              <Button size="xs" variant="ghost" onClick={spawnAgent}>
                spawn
              </Button>
              <Button size="xs" variant="ghost" onClick={advanceAgents}>
                advance
              </Button>
              <Button size="xs" variant="ghost" onClick={completeAgent}>
                complete
              </Button>
              <Button size="xs" variant="ghost" onClick={failAgent}>
                fail
              </Button>
              <Button size="xs" variant="ghost" onClick={clearAgents}>
                clear
              </Button>
            </Row>
            <Row label="Plan">
              <Button size="xs" variant="ghost" onClick={startPlan}>
                draft
              </Button>
              <Button size="xs" variant="ghost" onClick={advancePlan}>
                advance
              </Button>
              <Button size="xs" variant="ghost" onClick={clearPlan}>
                clear
              </Button>
            </Row>
            <Row label="Shells">
              <Button size="xs" variant="ghost" onClick={runShell}>
                run
              </Button>
              <Button size="xs" variant="ghost" onClick={exitShells}>
                exit
              </Button>
              <Button size="xs" variant="ghost" onClick={dropShells}>
                clear
              </Button>
            </Row>
          </section>

          {/* ------------------------------------------------ the dials */}
          <section className="flex flex-col gap-3">
            <h2 className="text-label uppercase text-muted-foreground">Feel dials</h2>
            <Dial label="Grammar">
              <Segmented
                ariaLabel="Closed-state grammar"
                value={dials.grammar}
                size="sm"
                options={[
                  { key: "clusters-now", label: "Clusters + now" },
                  { key: "now-only", label: "Now only" },
                  { key: "clusters-only", label: "Clusters only" },
                ]}
                onChange={(grammar) => setDials((current) => ({ ...current, grammar }))}
              />
            </Dial>
            <Dial label="Hover">
              <Segmented
                ariaLabel="Hover treatment"
                value={dials.hover}
                size="sm"
                options={[
                  { key: "none", label: "None" },
                  { key: "tooltip", label: "Tooltip" },
                  { key: "popover", label: "Popover" },
                ]}
                onChange={(hover) => setDials((current) => ({ ...current, hover }))}
              />
            </Dial>
            <Slider
              label="Spring duration"
              value={dials.duration}
              display={`${dials.duration.toFixed(2)}s`}
              min={0.25}
              max={0.8}
              step={0.05}
              onChange={(duration) => setDials((current) => ({ ...current, duration }))}
            />
            <Slider
              label="Spring bounce"
              value={dials.bounce}
              display={dials.bounce.toFixed(2)}
              min={0}
              max={0.4}
              step={0.02}
              onChange={(bounce) => setDials((current) => ({ ...current, bounce }))}
            />
            <Slider
              label="Flash hold"
              value={dials.flashHold}
              display={`${dials.flashHold.toFixed(1)}s`}
              min={0.8}
              max={3}
              step={0.1}
              onChange={(flashHold) => setDials((current) => ({ ...current, flashHold }))}
            />
            <div className="flex items-center gap-1">
              <Button
                size="xs"
                variant={dials.heartbeat ? "secondary" : "ghost"}
                onClick={() =>
                  setDials((current) => ({ ...current, heartbeat: !current.heartbeat }))
                }
              >
                Heartbeat
              </Button>
              <Button
                size="xs"
                variant={dials.forceReduced ? "secondary" : "ghost"}
                onClick={() =>
                  setDials((current) => ({ ...current, forceReduced: !current.forceReduced }))
                }
              >
                Reduced motion
              </Button>
              <span className="ml-2 text-label text-muted-foreground">Presets</span>
              <Button
                size="xs"
                variant="ghost"
                onClick={() =>
                  setDials((current) => ({ ...current, duration: 0.55, bounce: 0.25 }))
                }
              >
                Lively
              </Button>
              <Button
                size="xs"
                variant="ghost"
                onClick={() =>
                  setDials((current) => ({ ...current, duration: 0.35, bounce: 0.08 }))
                }
              >
                Crisp
              </Button>
            </div>
          </section>
        </div>
      </div>
    </TooltipProvider>
  );
}

function Row({ label, children }: React.PropsWithChildren<{ label: string }>) {
  return (
    <div className="flex items-center gap-1">
      <span className="w-20 shrink-0 text-label uppercase text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

function Dial({ label, children }: React.PropsWithChildren<{ label: string }>) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-28 shrink-0 text-label uppercase text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

function Slider({
  label,
  value,
  display,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  display: string;
  min: number;
  max: number;
  step: number;
  onChange(value: number): void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-28 shrink-0 text-label uppercase text-muted-foreground">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        onChange={(event) => onChange(Number(event.target.value))}
        className="w-44"
      />
      <span className="text-label tabular-nums text-muted-foreground">{display}</span>
    </div>
  );
}
