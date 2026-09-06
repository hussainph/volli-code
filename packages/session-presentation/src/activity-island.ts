/**
 * The Activity Island's projection contract and its pure rules (VC-256, from
 * the VC-248/VC-249 prototype under VC-247).
 *
 * The island is the at-a-glance surface for everything a Session manages that
 * cannot be told inside one chat stream: headless Browser Tabs, subagent
 * Sessions, the plan, background shells. It sits above the composer, as a
 * sibling of the interaction stack. This module is what it READS and what it
 * can SAY; the drawing is the desktop renderer's `activity-island-ui.tsx`.
 *
 * WHY IT LIVES IN THIS PACKAGE. It is a Session Surface Model in CONTEXT.md's
 * sense — "active ephemeral affordances… each client maps it to its own
 * components" — so it belongs on the portable side of the Session Presentation
 * Contract, beside `interaction.ts` and `activity.ts`, not in one client's
 * component folder. This package strips the DOM lib and declares neither React
 * nor Electron, so the purity this file needs is enforced by typecheck rather
 * than by review. The runtime that will feed it (Browser Tab registry,
 * subagent promotion, plan state, shells) does not exist yet; a future wiring
 * ticket projects into these types from wherever those facts end up living,
 * and a second client renders the same projection its own way.
 *
 * TWO GRAMMARS, FIXED LIVE. The pill's closed state is CLUSTERS + NOW: one
 * cluster per element kind in a fixed reading order, and a "now" channel that
 * announces the latest event. Every announcement carries its two registers
 * SEPARATELY — a quiet `event` and the `payload` that actually changed — so a
 * client weights them instead of decorating them, and so a client that
 * translates has two strings to translate rather than one it must parse.
 * `flashLine` renders the one-line form where a single string is required (a
 * caption, an announcement); nothing else may join the two registers.
 * The card ↔ pill are one model: a verb from a card (close, stop, kill…) is a
 * real transition whose flash comes back through the same channel, which is
 * why the island needs no toast.
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

import { todoListCompleted, type TodoStatus } from "@volli/shared";

/* ------------------------------------------------------------- projection */

/**
 * A headless Browser Tab the Session holds.
 *
 * `id` is the host's own opaque tab id, never a render index: it is what every
 * verb below addresses, and what survives a re-projection that reorders the
 * list. The chip's colour is NOT here — a tint is the drawing's business, and
 * a host has no opinion about hex (docs/BOUNDARIES.md: shared vocabulary, not
 * presentation).
 */
export interface IslandTab {
  id: string;
  /** What the pill and the card name the tab by. */
  host: string;
  state: "loading" | "ready";
  /**
   * Somewhere a person can see it — the card and that surface are one model.
   * One boolean, because that is all the pill asks; WHICH surface is
   * {@link surface}'s answer, and only the card's caption needs it.
   */
  promoted: boolean;
  /**
   * Where a promoted tab is drawn (VC-268): `preview` is pinned above this
   * chat's composer, `tab` is out in the workspace strip, `null` is headless.
   * The two visible places are different answers to "where is it", so the
   * state word says which rather than printing one word for both.
   */
  surface: "preview" | "tab" | null;
  /**
   * Whose tab it is, as the card says it: `null` for this Session's own, a
   * child Session's title otherwise. A parent watching its children's tabs
   * could not otherwise tell whose is whose — the whole point of the inventory
   * the island replaced (VC-238 §8). The projection decides the words; this
   * contract only carries them.
   */
  owner: string | null;
}

/** A subagent Session the Session delegated to. */
export interface IslandAgent {
  id: string;
  label: string;
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

/**
 * One step of the plan.
 *
 * A step carries its own id because the card addresses it by one. Keying and
 * jumping by TITLE made "distinct titles" a load-bearing rule that only a
 * comment enforced: two steps named the same collided as React keys and sent
 * the jump to the wrong row. An id also lets a rename stay the same step.
 */
export interface IslandStep {
  id: string;
  title: string;
  /**
   * Where this step stands, in the model's own words (VC-6).
   *
   * Per step rather than derived from {@link IslandPlan.done}, and the widening
   * is the one edit VC-6 made to VC-246's work. The original model was a
   * straight run down the list: `steps[done]` was current and everything before
   * it was finished. Real todo tools do not behave that way — `todo_write` lets
   * the model finish the third item first and abandon the second — and a count
   * of completed prefixes drew that as the wrong row ticked.
   *
   * It is {@link TodoStatus} ITSELF rather than a union re-spelled to match, so
   * the projection is a rename and not a translation — and so a status added to
   * the vocabulary cannot leave a step unable to carry it. What this is NOT is
   * {@link PlanStepState}, the drawing state: `current` lives there because
   * which row is current is a fact about the whole plan, not about one step.
   */
  state: TodoStatus;
}

/** The Session's plan: an ordered list of steps and how many are done. */
export interface IslandPlan {
  id: string;
  steps: readonly IslandStep[];
  /**
   * How many steps are COMPLETED — a count, not a cursor.
   *
   * It stayed a count when the steps gained their own state (VC-6), because
   * everything that reads it wants a count: `planCount` prints `n/n`,
   * `planPercent` fills the hairline, and the pill's grammar is "1/3". What it
   * is no longer is a POSITION: `steps[done]` names nothing in particular once
   * the model may finish items out of order, which is why {@link planCurrent}
   * and {@link planStepState} read the steps instead.
   */
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

/**
 * The latest event for the now channel. A new `id` is a new announcement.
 *
 * The two registers stay APART. A pre-joined string would have to be parsed
 * back before it could be weighted, which is what the drawing did until the
 * separator became the contract's only way to tell an event from its payload —
 * a line that arrived by any other route silently lost its voice, and no
 * client could translate either half. {@link flashLine} joins them where one
 * string is genuinely needed.
 */
export interface IslandFlash {
  id: string;
  /** The quiet register: what happened. */
  event: string;
  /** The register that carries the weight: the thing it happened to. */
  payload: string;
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
 * is pinned as this chat's preview, a subagent peeks in an overlay, a shell
 * opens its output, a plan step jumps. The destructive three — close, stop,
 * kill — arm on first press in the UI; by the time one of these is called the
 * person has pressed twice. The wiring ticket implements these against the
 * runtime; the island never learns what they do.
 */
export interface ActivityIslandActions {
  closeTab(id: string): void;
  /**
   * Pin the tab above this chat's composer — VC-238's Show, the cheap reveal.
   * "Open as tab" stays where VC-238 put it, on the preview chrome and the
   * transcript card; the island never promotes straight to the strip.
   */
  promoteTab(id: string): void;
  peekAgent(id: string): void;
  promoteAgent(id: string): void;
  stopAgent(id: string): void;
  openShell(id: string): void;
  killShell(id: string): void;
  /**
   * By step id, like every other verb here. A position would be a promise the
   * projection cannot keep: the list it was read from may already have been
   * re-projected by the time the click lands, and index 3 would then name a
   * different step (docs/BOUNDARIES.md rule 2 — never adjacency as position).
   *
   * NOT CALLED BY THE CARD TODAY (VC-268). It was designed against a sim where
   * each step had a place to jump to; on main one `todo_write` writes the whole
   * list and a step has no message of its own, so the plan card's rows draw
   * inert rather than activatable-and-idle. The verb stays in the contract for
   * the condition that reopens it: per-step targets exist once plan activity
   * rows render per step in the transcript.
   */
  jumpStep(id: string): void;
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

/**
 * The one separator this surface joins registers with. Captions and headings
 * below spell the same middle dot for the same reason the now channel does —
 * one voice — but only this constant is the GRAMMAR, and only {@link flashLine}
 * applies it to a flash.
 */
const FLASH_SEPARATOR = " · ";

/**
 * `event · payload` — the one-line form, for the places that can hold only a
 * string: a tooltip, an aria announcement, the inline ticker. A drawing that
 * can weight the two registers should read {@link IslandFlash} directly and
 * never rebuild this line to take it apart again.
 */
export function flashLine(flash: IslandFlash): string {
  return `${flash.event}${FLASH_SEPARATOR}${flash.payload}`;
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
  return tabs.length === 1 && only
    ? `1 browser tab${FLASH_SEPARATOR}${only.host}`
    : `${tabs.length} browser tabs`;
}

/** The tabs card's heading. */
export function tabsHeading(tabs: readonly IslandTab[]): string {
  return `Browser${FLASH_SEPARATOR}${plural(tabs.length, "tab")}`;
}

/**
 * The state word riding a tab row's name; `null` when there is nothing to say.
 *
 * Reads {@link IslandTab.surface}, not `promoted`: the pill's boolean says
 * "visible somewhere", and a caption that said only that would print the same
 * word for a preview above this composer and a tab in the strip. In the card's
 * own caption grammar: `pinned here` / `as a tab`.
 */
export function tabStateWord(tab: IslandTab): string | null {
  if (tab.state === "loading") return "loading";
  if (tab.surface === "preview") return "pinned here";
  if (tab.surface === "tab") return "as a tab";
  return null;
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
  return `Subagents${FLASH_SEPARATOR}${agentsDone(agents)}/${agents.length} done`;
}

/** `72%` while working, the state otherwise; `· tab` once promoted. */
export function agentStateWord(agent: IslandAgent): string {
  const base = agent.state === "working" ? `${Math.round(agent.progress * 100)}%` : agent.state;
  return agent.promoted ? `${base}${FLASH_SEPARATOR}tab` : base;
}

/** Ended without finishing — dims the chip. `stopped` takes no badge; `failed` does. */
export function agentDimmed(agent: IslandAgent): boolean {
  return agent.state === "failed" || agent.state === "stopped";
}

/* ------------------------------------------------------------------- plan */

export function planTotal(plan: IslandPlan): number {
  return plan.steps.length;
}

/**
 * The step in progress; `null` once nothing is left to do.
 *
 * Two answers in priority order, because a model writes both shapes. The one
 * it means is `in_progress` — the item it says it is on. But a model that ticks
 * an item and rewrites the list before starting the next one leaves NO item in
 * progress and several still pending, and a card that answered `null` there
 * would say the plan was finished while two steps waited. So the first pending
 * step is the fallback, and `null` is reserved for a list with neither.
 *
 * A `cancelled` step is never current: it is a step the model decided against,
 * and pointing the card at it would be reporting abandoned work as the work in
 * hand.
 */
export function planCurrent(plan: IslandPlan): IslandStep | null {
  return (
    plan.steps.find((step) => step.state === "in_progress") ??
    plan.steps.find((step) => step.state === "pending") ??
    null
  );
}

/** `done`/`total` as the pill and the card heading both print it. */
export function planCount(plan: IslandPlan): string {
  return `${plan.done}/${planTotal(plan)}`;
}

/**
 * 0..100 for the hairline under the card header. Clamped at both ends: a plan
 * that counts more done than it holds is an upstream bug, but the hairline may
 * not run past the end of its own track while that bug is on screen.
 */
export function planPercent(plan: IslandPlan): number {
  const total = planTotal(plan);
  if (total === 0) return 0;
  return Math.min(100, (plan.done / total) * 100);
}

export function planLine(plan: IslandPlan): string {
  const current = planCurrent(plan);
  return `Plan ${planCount(plan)}${FLASH_SEPARATOR}${current ? current.title : "done"}`;
}

export function planHeading(plan: IslandPlan): string {
  return `Plan${FLASH_SEPARATOR}${planCount(plan)}`;
}

export type PlanStepState = "done" | "current" | "pending" | "cancelled";

/**
 * How one row draws, from the step's own state (VC-6).
 *
 * `current` is the one answer that is not a straight rename, and it has to be
 * asked of the PLAN rather than the step: exactly one row may be current, and
 * which one it is is {@link planCurrent}'s single decision. Asking the step
 * alone would draw every pending row as current in a list with none in
 * progress.
 */
export function planStepState(plan: IslandPlan, index: number): PlanStepState {
  const step = plan.steps[index];
  if (step === undefined) return "pending";
  if (step.state === "completed") return "done";
  if (step.state === "cancelled") return "cancelled";
  return planCurrent(plan)?.id === step.id ? "current" : "pending";
}

/**
 * The Session's current todo list as the plan card's model (VC-6).
 *
 * The one place the todo vocabulary becomes island vocabulary, so no client
 * re-derives it and no second reading of "done" can appear. It is a projection
 * and not a fold: `list` is already the answer to "what is the plan now", read
 * from durable history by `currentTodoList`.
 *
 * `null` and `[]` both mean NO CARD, which is the one place this surface may
 * collapse the distinction the fold works to keep: a Session that cleared its
 * list has nothing to draw, exactly like one that never wrote a list. The
 * difference matters upstream, where reviving the previous list would be wrong,
 * and stops mattering here.
 *
 * Step ids are positional because a todo list has no ids of its own — the model
 * sends words and a status. They are scoped to the Session so two open chats
 * cannot collide as React keys, and they are stable for as long as the list is,
 * which is all `jumpStep` needs: the next call replaces the whole list anyway.
 */
export function islandPlanFromTodos(
  sessionId: string,
  list: readonly { content: string; status: IslandStep["state"] }[] | null,
): IslandPlan | null {
  if (list === null || list.length === 0) return null;
  return {
    id: sessionId,
    steps: list.map((todo, index) => ({
      id: `${sessionId}:${index}`,
      title: todo.content,
      state: todo.status,
    })),
    // Completed only, and counted by the vocabulary's own function rather than
    // by a filter repeated here. A cancelled step is not progress — counting it
    // would let a model reach 100% by dropping the work it did not do.
    done: todoListCompleted(list),
  };
}

/* ----------------------------------------------------------------- shells */

export function shellsRunning(shells: readonly IslandShell[]): number {
  return shells.filter((shell) => shell.state === "running").length;
}

export function shellsLine(shells: readonly IslandShell[]): string {
  const running = shellsRunning(shells);
  return running > 0
    ? `${plural(running, "shell")} running`
    : `${plural(shells.length, "shell")}${FLASH_SEPARATOR}exited`;
}

export function shellsHeading(shells: readonly IslandShell[]): string {
  const running = shellsRunning(shells);
  return running > 0
    ? `Shells${FLASH_SEPARATOR}${running} running`
    : `Shells${FLASH_SEPARATOR}${shells.length} exited`;
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
