/**
 * The Activity Island's projection contract and its pure rules (VC-256, from
 * the VC-248/VC-249 prototype under VC-247).
 *
 * The island is the at-a-glance surface for everything a Session manages that
 * cannot be told inside one chat stream: headless browser tabs, subagents, the
 * plan, background shells. It sits above the composer, as a sibling of the
 * interaction stack. This module is what it READS and what it can SAY; the
 * drawing is `activity-island-ui.tsx`. Nothing here touches a store, a bridge
 * or the DOM — the runtime that will feed it (browser-tab registry, subagent
 * promotion, plan state, shells) does not exist yet, and a future wiring
 * ticket projects into these types from wherever those facts end up living.
 *
 * TWO GRAMMARS, FIXED LIVE. The pill's closed state is CLUSTERS + NOW: one
 * cluster per element kind in a fixed reading order, and a "now" channel that
 * announces the latest event. Every announcement shares one grammar —
 * `event · payload` — so the drawing can weight it (quiet event, bold payload)
 * instead of decorating it; `flashLine` builds it and `splitFlash` reads it,
 * and nothing else may invent a separator. The card ↔ pill are one model: a
 * verb from a card (close, stop, kill…) is a real transition whose flash comes
 * back through the same channel, which is why the island needs no toast.
 *
 * THE EMPTY RULE. No island when nothing to model. A flash on its own is not
 * something to model — it is a change to something — so `islandEmpty` ignores
 * it; the pill is never a 32px bar announcing that it has nothing to say.
 *
 * FEEL IS DATA. The verdicts from the live rounds (Lively spring, popover
 * hover, payload voice, hover-revealed row actions, arming on, 1.6s hold) are
 * named constants here and the default `ActivityIslandFeel`. The alternatives
 * each verdict was chosen over survive as the type's other members — not to
 * re-litigate them in the app, but so the lab harness keeps its dials and a
 * later round can argue against the default in the same session that judges
 * it. `resolveFeel` is the one place an override meets the default.
 */

/* ------------------------------------------------------------- projection */

/** A headless browser tab the Session holds. */
export interface IslandTab {
  id: string;
  /** What the pill and the card name the tab by. */
  host: string;
  /** A CSS color the tab's chip wears — the favicon idiom, a toned square + letter. */
  tone: string;
  state: "loading" | "ready";
  /** Promoted to a Browser pane from its card row — the card and the pane are one model. */
  promoted: boolean;
}

/** A subagent the Session delegated to. */
export interface IslandAgent {
  id: string;
  label: string;
  /** A CSS color the agent's chip wears — the people idiom, a toned disk + initial. */
  tone: string;
  /** 0..1, meaningful while `working`. */
  progress: number;
  /**
   * `stopped` is ended-by-decision from the card: it dims like `failed` but
   * takes no badge — a person chose it, nothing went wrong.
   */
  state: "working" | "done" | "failed" | "stopped";
  /** Promoted to a full tab from its card row. */
  promoted: boolean;
}

/** The Session's plan: an ordered list of steps and how many are done. */
export interface IslandPlan {
  id: string;
  /** Distinct titles — a step is keyed by its title in the card, so a rename is a new row. */
  steps: readonly string[];
  /** Steps completed, from the top; `steps[done]` is the current one. */
  done: number;
}

/** A background shell the Session started. */
export interface IslandShell {
  id: string;
  command: string;
  state: "running" | "exited";
  /** Exit code once exited. */
  code: number | null;
}

/** The latest event for the now channel. A new `id` is a new announcement. */
export interface IslandFlash {
  id: string;
  /** `event · payload`, built by {@link flashLine}. */
  text: string;
}

export interface ActivityIslandModel {
  tabs: readonly IslandTab[];
  agents: readonly IslandAgent[];
  plan: IslandPlan | null;
  shells: readonly IslandShell[];
  flash: IslandFlash | null;
}

export const EMPTY_ACTIVITY_ISLAND: ActivityIslandModel = {
  tabs: [],
  agents: [],
  plan: null,
  shells: [],
  flash: null,
};

/* ------------------------------------------------------------------ verbs */

/**
 * What a card can do. Every row is its obvious promotion (row = verb): a tab
 * opens in the Browser pane, a subagent peeks in an overlay, a shell opens its
 * output, a plan step jumps. The destructive three — close, stop, kill — arm
 * on first press in the UI; by the time one of these is called the person has
 * pressed twice. The wiring ticket implements these against the runtime; the
 * island never learns what they do.
 */
export interface ActivityIslandActions {
  closeTab(id: string): void;
  promoteTab(id: string): void;
  peekAgent(id: string): void;
  promoteAgent(id: string): void;
  stopAgent(id: string): void;
  openShell(id: string): void;
  killShell(id: string): void;
  jumpStep(index: number): void;
}

/* ------------------------------------------------------------------- feel */

export type IslandGrammar = "clusters-now" | "now-only" | "clusters-only";
export type IslandHover = "none" | "tooltip" | "popover";
/** Voice of the now channel: all quiet, quiet event + bold payload, all loud. */
export type IslandNowVoice = "quiet" | "payload" | "loud";
/** When a card row's action buttons show: on row hover, only while pinned, or always. */
export type IslandRevealMode = "hover" | "pinned" | "always";

export interface ActivityIslandFeel {
  grammar: IslandGrammar;
  /** Spring settle time, seconds — the ONE spring for pill layout, cluster presence and the drop. */
  springDuration: number;
  /** Spring bounce, 0..0.4. */
  springBounce: number;
  /** Seconds a now-channel flash holds before receding. */
  flashHoldSeconds: number;
  hover: IslandHover;
  nowVoice: IslandNowVoice;
  reveal: IslandRevealMode;
  /** Destructive row actions (close / stop / kill) arm on first press, fire on second. */
  armDestructive: boolean;
  /** Preview reduced motion regardless of the OS setting (a lab dial). */
  forceReducedMotion: boolean;
}

/**
 * "Lively" — 0.55s / 0.25 bounce, chosen in round 3 over "Crisp" (0.35 /
 * 0.08). One spring drives everything that moves in the pill so the width
 * morph, a cluster's entrance and the drop's rise read as one material.
 */
export const ISLAND_SPRING = { duration: 0.55, bounce: 0.25 } as const;
/** How long the now channel holds an announcement before the drop is reabsorbed. */
export const ISLAND_FLASH_HOLD_SECONDS = 1.6;
/** A destructive action stays armed this long, then quietly disarms. */
export const ISLAND_ARM_WINDOW_MS = 1800;
/** Leaving a cluster to nothing waits this long before the card closes — crossing the gap must not flicker it. */
export const ISLAND_HOVER_LEAVE_GRACE_MS = 140;
/** The agents cluster shows this many chips before collapsing the rest into `+n`. */
export const ISLAND_AGENT_CHIP_CAP = 4;

export const ACTIVITY_ISLAND_FEEL: ActivityIslandFeel = {
  grammar: "clusters-now",
  springDuration: ISLAND_SPRING.duration,
  springBounce: ISLAND_SPRING.bounce,
  flashHoldSeconds: ISLAND_FLASH_HOLD_SECONDS,
  hover: "popover",
  nowVoice: "payload",
  reveal: "hover",
  armDestructive: true,
  forceReducedMotion: false,
};

export function resolveFeel(override?: Partial<ActivityIslandFeel>): ActivityIslandFeel {
  return override ? { ...ACTIVITY_ISLAND_FEEL, ...override } : ACTIVITY_ISLAND_FEEL;
}

/* ------------------------------------------------------------- the rules */

/** No island when nothing to model. A lone flash is not something to model. */
export function islandEmpty(model: ActivityIslandModel): boolean {
  return (
    model.tabs.length === 0 &&
    model.agents.length === 0 &&
    model.shells.length === 0 &&
    model.plan === null
  );
}

export type IslandCluster = "tabs" | "agents" | "plan" | "shells";

/**
 * The clusters the pill draws, in reading order. The divider rule ("a leading
 * hairline on every cluster but the first") needs the LIST, not four
 * independent conditionals, so this is the one place membership is decided.
 */
export function islandClusters(model: ActivityIslandModel): IslandCluster[] {
  const clusters: IslandCluster[] = [];
  if (model.tabs.length > 0) clusters.push("tabs");
  if (model.agents.length > 0) clusters.push("agents");
  if (model.plan) clusters.push("plan");
  if (model.shells.length > 0) clusters.push("shells");
  return clusters;
}

/* ---------------------------------------------------------------- grammar */

const FLASH_SEPARATOR = " · ";

/** `event · payload` — the now channel's one grammar. */
export function flashLine(event: string, payload: string): string {
  return `${event}${FLASH_SEPARATOR}${payload}`;
}

/** Splits a flash back into its two registers; `null` when it was not built by {@link flashLine}. */
export function splitFlash(text: string): { event: string; payload: string } | null {
  const at = text.indexOf(FLASH_SEPARATOR);
  if (at === -1) return null;
  return { event: text.slice(0, at), payload: text.slice(at + FLASH_SEPARATOR.length) };
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/* ------------------------------------------------------------------- tabs */

export function tabsLoading(tabs: readonly IslandTab[]): boolean {
  return tabs.some((tab) => tab.state === "loading");
}

/** The tabs cluster's one-line caption. */
export function tabsLine(tabs: readonly IslandTab[]): string {
  const [only] = tabs;
  return tabs.length === 1 && only ? `1 browser tab · ${only.host}` : `${tabs.length} browser tabs`;
}

/** The tabs card's heading. */
export function tabsHeading(tabs: readonly IslandTab[]): string {
  return `Browser · ${plural(tabs.length, "tab")}`;
}

/** The state word riding a tab row's name; `null` when there is nothing to say. */
export function tabStateWord(tab: IslandTab): string | null {
  if (tab.state === "loading") return "loading";
  return tab.promoted ? "in pane" : null;
}

/* ----------------------------------------------------------------- agents */

export function agentsDone(agents: readonly IslandAgent[]): number {
  return agents.filter((agent) => agent.state === "done").length;
}

/**
 * A counter, not a mood. "x/y done" everywhere the group is named — "settled"
 * was the pill editorialising about a group whose members each already say
 * what they are.
 */
export function agentsLine(agents: readonly IslandAgent[]): string {
  return `${agentsDone(agents)}/${agents.length} subagents done`;
}

export function agentsHeading(agents: readonly IslandAgent[]): string {
  return `Subagents · ${agentsDone(agents)}/${agents.length} done`;
}

/** `72%` while working, the state otherwise; `· tab` once promoted. */
export function agentStateWord(agent: IslandAgent): string {
  const base = agent.state === "working" ? `${Math.round(agent.progress * 100)}%` : agent.state;
  return agent.promoted ? `${base} · tab` : base;
}

/** Ended without finishing — dims the chip. `stopped` takes no badge; `failed` does. */
export function agentDimmed(agent: IslandAgent): boolean {
  return agent.state === "failed" || agent.state === "stopped";
}

/* ------------------------------------------------------------------- plan */

export function planTotal(plan: IslandPlan): number {
  return plan.steps.length;
}

/** The step in progress; `null` once every step is done. */
export function planCurrent(plan: IslandPlan): string | null {
  return plan.steps[plan.done] ?? null;
}

/** `done`/`total` as the pill and the card heading both print it. */
export function planCount(plan: IslandPlan): string {
  return `${plan.done}/${planTotal(plan)}`;
}

/** 0..100 for the hairline under the card header. */
export function planPercent(plan: IslandPlan): number {
  const total = planTotal(plan);
  return total === 0 ? 0 : (plan.done / total) * 100;
}

export function planLine(plan: IslandPlan): string {
  const current = planCurrent(plan);
  return current ? `Plan ${planCount(plan)} · ${current}` : `Plan ${planCount(plan)} · done`;
}

export function planHeading(plan: IslandPlan): string {
  return `Plan · ${planCount(plan)}`;
}

export type PlanStepState = "done" | "current" | "pending";

export function planStepState(plan: IslandPlan, index: number): PlanStepState {
  if (index < plan.done) return "done";
  return index === plan.done ? "current" : "pending";
}

/* ----------------------------------------------------------------- shells */

export function shellsRunning(shells: readonly IslandShell[]): number {
  return shells.filter((shell) => shell.state === "running").length;
}

export function shellsLine(shells: readonly IslandShell[]): string {
  const running = shellsRunning(shells);
  return running > 0
    ? `${plural(running, "shell")} running`
    : `${plural(shells.length, "shell")} · exited`;
}

export function shellsHeading(shells: readonly IslandShell[]): string {
  const running = shellsRunning(shells);
  return running > 0 ? `Shells · ${running} running` : `Shells · ${shells.length} exited`;
}

/** `exit 137` once exited; `null` while running. */
export function shellStateWord(shell: IslandShell): string | null {
  return shell.state === "exited" ? `exit ${shell.code ?? 0}` : null;
}

/* ---------------------------------------------------------------- summary */

/**
 * What the inline ticker says between flashes in the `now-only` grammar — the
 * countable elements in one muted line (shells have no count worth a word; a
 * running one announces itself through the flash). Not drawn by the default
 * grammar, where the clusters already say all of this.
 */
export function summaryLine(model: ActivityIslandModel): string {
  const parts: string[] = [];
  if (model.tabs.length > 0) parts.push(plural(model.tabs.length, "tab"));
  const working = model.agents.filter((agent) => agent.state === "working");
  if (working.length > 0) {
    const mean = working.reduce((sum, agent) => sum + agent.progress, 0) / working.length;
    parts.push(`agents ${Math.round(mean * 100)}%`);
  } else if (model.agents.length > 0) {
    parts.push(`agents ${agentsDone(model.agents)}/${model.agents.length}`);
  }
  if (model.plan) parts.push(`plan ${planCount(model.plan)}`);
  return parts.join(FLASH_SEPARATOR);
}
