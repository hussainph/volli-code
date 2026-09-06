/**
 * Activity Island · the feel harness (VC-248 / VC-249, ported in VC-256; map
 * VC-247).
 *
 * The island itself now lives in the app — `components/chat/activity-island-
 * ui.tsx` over the projection contract in `@volli/session-presentation`'s
 * `activity-island.ts` — and
 * this scratch is the harness around it: a simulated session, drivers to
 * mutate it, a live transcript above the pill so it is judged in context, and
 * the feel dials that let the settled verdicts be argued against in one
 * sitting rather than across commits. It is the island's visual regression
 * surface: the component draws here exactly as it will above the composer,
 * because it is the same component.
 *
 * What is settled (records on VC-248 and VC-249): clusters + now grammar, the
 * Lively spring, payload voice, popover hover with click-to-pin, hover-revealed
 * row actions, arming on. The dials below default to those verdicts through
 * `ACTIVITY_ISLAND_FEEL`; every other position is kept as a dial so the next
 * round can feel the difference, not read about it.
 *
 * Everything here is fixture-driven — no runtime, no bridge. The sim's verbs
 * are what the island's `ActivityIslandActions` will one day call into the
 * runtime; here each one is a reducer transition with a flash, so the pill
 * echoes the card the way it will when the wiring lands.
 */
import * as React from "react";
import { PlayIcon } from "@phosphor-icons/react";
import {
  ACTIVITY_METADATA_KEY,
  type ActivityDescriptor,
  type ActivityKind,
  type ActivityOutcome,
} from "@volli/shared";
import type { DynamicToolUIPart } from "ai";

import type { BundleRow } from "@volli/session-presentation";
import {
  ACTIVITY_ISLAND_FEEL,
  type ActivityIslandActions,
  type ActivityIslandFeel,
  type ActivityIslandModel,
  type IslandAgent,
  type IslandFlash,
  type IslandPlan,
  type IslandShell,
  type IslandStep,
  type IslandTab,
  planCount,
  planCurrent,
} from "@volli/session-presentation";
import { ActivityIsland } from "@renderer/components/chat/activity-island-ui";
import { ActivityBundle } from "@renderer/components/chat/activity-ui";
import { GuardedResponse } from "@renderer/components/chat/markdown-boundary";
import { Message, MessageContent } from "@renderer/components/ui/ai-elements/message";

import { SessionComposer, type ComposerModel } from "@renderer/components/chat/composer-ui";
import { ContentColumn } from "@renderer/components/layout/content-column";
import { Button } from "@renderer/components/ui/button";
import { Segmented } from "@renderer/components/ui/segmented";
import { TooltipProvider } from "@renderer/components/ui/tooltip";

export const title = "Activity Island · feel harness";
export const note =
  "The ported component over a simulated session — drivers, live transcript, and the feel dials the verdicts can be argued against";
export const viewport = "stage" as const;

/* ---------------------------------------------------------------- fixtures */

const TAB_HOSTS = [
  "localhost:5177",
  "github.com",
  "easing.dev",
  "motion.dev",
  "npmjs.com",
] as const;

const AGENT_LABELS = ["Audit icon weights", "Grep theme tokens", "Draft smoke plan"] as const;

const SHELL_COMMANDS = [
  "pnpm lab",
  "vp check",
  // Deliberately obscene: the fixture that PROVES the truncation chain instead
  // of asserting it. The pill never shows a command at all (glyph + pulse); the
  // drop caps at max-w-72 and ellipsizes; the card row ellipsizes inside its
  // own width. `truncate` is nowrap, so even the newlines of a real multiline
  // loop could not wrap any of those surfaces.
  'for f in $(git ls-files "*.tsx"); do grep -l "useReducedMotion" "$f" && pnpm exec tsc --noEmit "$f" || echo "skipped $f"; done',
  "pnpm test",
] as const;

const PLAN_STEPS: readonly IslandStep[] = [
  { id: "step-1", title: "Read composer stack", state: "in_progress" },
  { id: "step-2", title: "Sketch closed pill", state: "pending" },
  { id: "step-3", title: "Wire feel dials", state: "pending" },
  { id: "step-4", title: "Cluster drawings", state: "pending" },
  { id: "step-5", title: "Hover treatments", state: "pending" },
  // Dropped rather than done: the lab needs a cancelled row on screen, since
  // it is the one plan state a person cannot produce with the advance dial.
  { id: "step-6", title: "Reduced motion pass", state: "cancelled" },
  { id: "step-7", title: "Record verdicts", state: "pending" },
];

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

/* ------------------------------------------------------------ sim reducer */

/**
 * All sim state lives in one PURE reducer, flash included — the flash a
 * mutation announces is part of the state transition itself, never a second
 * `setState` fired from inside an updater. The first cut did exactly that and
 * StrictMode's double-invocation of updaters made announcements fire out of
 * order; a reducer is immune by construction, and it makes the demo script
 * deterministic besides. The island owns the flash's HOLD (it decides how long
 * an announcement reads), so the sim only ever sets the latest one.
 */
interface Sim extends ActivityIslandModel {
  tabs: IslandTab[];
  agents: IslandAgent[];
  plan: IslandPlan | null;
  shells: IslandShell[];
  flash: IslandFlash | null;
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
  | { type: "reset" }
  // The cards' verbs — the sim's answer to `ActivityIslandActions`. Each is
  // one verb, one subject id, one flash; the real ones will be runtime calls.
  | { type: "close-tab"; id: string }
  | { type: "promote-tab"; id: string }
  | { type: "peek-agent"; id: string }
  | { type: "promote-agent"; id: string }
  | { type: "stop-agent"; id: string }
  | { type: "open-shell"; id: string }
  | { type: "kill-shell"; id: string }
  | { type: "jump-step"; id: string };

/**
 * The transition plus its announcement, atomically. The two registers stay
 * apart all the way from the transition to the drawing — the island weights
 * them, so nothing here joins them into a line first.
 */
function flashed(sim: Sim, event: string, payload = ""): Sim {
  return { ...sim, flash: { id: `flash-${sim.seq}`, event, payload }, seq: sim.seq + 1 };
}

function simReducer(sim: Sim, action: SimAction): Sim {
  switch (action.type) {
    case "add-tab": {
      const host = TAB_HOSTS[sim.tabs.length % TAB_HOSTS.length] ?? "localhost";
      const next = flashed(sim, "Opened", host);
      return {
        ...next,
        tabs: [...sim.tabs, { id: `tab-${next.seq}`, host, state: "loading", promoted: false }],
        seq: next.seq + 1,
      };
    }
    case "settle-tabs":
      return sim.tabs.some((tab) => tab.state === "loading")
        ? {
            ...flashed(sim, "Page loaded", "all tabs"),
            tabs: sim.tabs.map((tab) => ({ ...tab, state: "ready" as const })),
          }
        : sim;
    case "drop-tab": {
      const last = sim.tabs[sim.tabs.length - 1];
      if (!last) return sim;
      return { ...flashed(sim, "Closed", last.host), tabs: sim.tabs.slice(0, -1) };
    }
    case "spawn-agent": {
      const label = AGENT_LABELS[sim.agents.length % AGENT_LABELS.length] ?? "Subagent";
      const next = flashed(sim, "Subagent started", label);
      return {
        ...next,
        agents: [
          ...sim.agents,
          { id: `agent-${next.seq}`, label, progress: 0.08, state: "working", promoted: false },
        ],
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
        ...flashed(sim, "Subagent finished", target.label),
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
        ...flashed(sim, "Subagent failed", target.label),
        agents: sim.agents.map((agent, at) =>
          at === index ? { ...agent, state: "failed" as const } : agent,
        ),
      };
    }
    case "clear-agents":
      return { ...sim, agents: [] };
    case "start-plan": {
      const next = flashed(sim, "Plan drafted", `${PLAN_STEPS.length} steps`);
      return {
        ...next,
        plan: { id: `plan-${next.seq}`, steps: [...PLAN_STEPS], done: 0 },
        seq: next.seq + 1,
      };
    }
    case "advance-plan": {
      if (!sim.plan) return sim;
      // Ticks the step in hand and starts the next one, because a step carries
      // its own state now (VC-6) — bumping `done` alone moved the number and
      // left every row drawn exactly as it was. `done` stays the COUNT the
      // pill prints, derived rather than incremented.
      const current = planCurrent(sim.plan);
      const ticked: IslandStep[] = [];
      for (const step of sim.plan.steps) {
        ticked.push(step.id === current?.id ? { ...step, state: "completed" } : step);
      }
      const next = ticked.find((step) => step.state === "pending");
      const steps: IslandStep[] = [];
      for (const step of ticked) {
        steps.push(step.id === next?.id ? { ...step, state: "in_progress" } : step);
      }
      const plan = {
        ...sim.plan,
        steps,
        done: steps.filter((step) => step.state === "completed").length,
      };
      return {
        ...flashed(sim, `Plan ${planCount(plan)}`, planCurrent(plan)?.title ?? "Wrap up"),
        plan,
      };
    }
    case "clear-plan":
      return { ...sim, plan: null };
    case "run-shell": {
      const command = SHELL_COMMANDS[sim.shells.length % SHELL_COMMANDS.length] ?? "sh";
      const next = flashed(sim, "Shell started", command);
      return {
        ...next,
        shells: [...sim.shells, { id: `shell-${next.seq}`, command, state: "running", code: null }],
        seq: next.seq + 1,
      };
    }
    case "exit-shells":
      return sim.shells.some((shell) => shell.state === "running")
        ? {
            ...flashed(sim, "Shell exited", "0"),
            shells: sim.shells.map((shell) =>
              shell.state === "running" ? { ...shell, state: "exited" as const, code: 0 } : shell,
            ),
          }
        : sim;
    case "drop-shells":
      return { ...sim, shells: [] };
    case "reset":
      return INITIAL_SIM;
    case "close-tab": {
      const tab = sim.tabs.find((candidate) => candidate.id === action.id);
      if (!tab) return sim;
      return {
        ...flashed(sim, "Closed", tab.host),
        tabs: sim.tabs.filter((candidate) => candidate.id !== action.id),
      };
    }
    case "promote-tab": {
      const tab = sim.tabs.find((candidate) => candidate.id === action.id);
      if (!tab) return sim;
      return {
        ...flashed(sim, tab.promoted ? "Focused pane" : "Opened in pane", tab.host),
        tabs: sim.tabs.map((candidate) =>
          candidate.id === action.id ? { ...candidate, promoted: true } : candidate,
        ),
      };
    }
    case "peek-agent": {
      const agent = sim.agents.find((candidate) => candidate.id === action.id);
      return agent ? flashed(sim, "Overlay", agent.label) : sim;
    }
    case "promote-agent": {
      const agent = sim.agents.find((candidate) => candidate.id === action.id);
      if (!agent) return sim;
      return {
        ...flashed(sim, agent.promoted ? "Focused tab" : "Opened as tab", agent.label),
        agents: sim.agents.map((candidate) =>
          candidate.id === action.id ? { ...candidate, promoted: true } : candidate,
        ),
      };
    }
    case "stop-agent": {
      const agent = sim.agents.find((candidate) => candidate.id === action.id);
      if (!agent || agent.state !== "working") return sim;
      return {
        ...flashed(sim, "Stopped", agent.label),
        agents: sim.agents.map((candidate) =>
          candidate.id === action.id ? { ...candidate, state: "stopped" as const } : candidate,
        ),
      };
    }
    case "open-shell": {
      const shell = sim.shells.find((candidate) => candidate.id === action.id);
      return shell ? flashed(sim, "Output", shell.command) : sim;
    }
    case "kill-shell": {
      const shell = sim.shells.find((candidate) => candidate.id === action.id);
      if (!shell || shell.state !== "running") return sim;
      return {
        ...flashed(sim, "Killed", shell.command),
        shells: sim.shells.map((candidate) =>
          candidate.id === action.id
            ? { ...candidate, state: "exited" as const, code: 137 }
            : candidate,
        ),
      };
    }
    case "jump-step": {
      const step = sim.plan?.steps.find((candidate) => candidate.id === action.id);
      return step ? flashed(sim, "Jump", step.title) : sim;
    }
  }
}

/* -------------------------------------------------------------------- feed */

/**
 * The transcript above the island is the SAME model seen from the other side.
 * Each tab is a `fetch-url` row, each subagent a `delegate` row, each shell a
 * `run-command` row, the plan a `plan` row — drawn with the real
 * `ActivityBundle`, in the order the sim created them. The island summarises
 * what the transcript narrates; judging the pill against skeleton bars was
 * judging it out of context.
 *
 * The builders below are the chat-activity scratch's, trimmed to the three
 * tool states this feed reaches.
 */
function activityOutcome(patch: Partial<ActivityOutcome>): ActivityOutcome {
  return {
    exitCode: null,
    matchCount: null,
    fileCount: null,
    lineCount: null,
    bytes: null,
    addedLines: null,
    removedLines: null,
    diff: null,
    summary: null,
    ...patch,
  };
}

function activityTool(
  id: string,
  kind: ActivityKind,
  label: string,
  state: "live" | "done" | "failed",
  options: { outcome?: Partial<ActivityOutcome>; errorText?: string; nativeToolName?: string } = {},
): DynamicToolUIPart {
  const descriptor: ActivityDescriptor = {
    kind,
    nativeToolName: options.nativeToolName ?? kind,
    subject: { label, path: null, lineRange: null },
    outcome: options.outcome ? activityOutcome(options.outcome) : null,
    startedAt: 0,
    endedAt: state === "live" ? null : 2400,
  };
  const base = {
    type: "dynamic-tool" as const,
    toolName: descriptor.nativeToolName,
    toolCallId: `island-${id}`,
    // The SDK types `toolMetadata` as `JSONObject`; a descriptor is one structurally.
    toolMetadata: { [ACTIVITY_METADATA_KEY]: descriptor } as DynamicToolUIPart["toolMetadata"],
    input: null,
  };
  switch (state) {
    case "live":
      return { ...base, state: "input-available" };
    case "failed":
      return { ...base, state: "output-error", errorText: options.errorText ?? "Failed" };
    default:
      return { ...base, state: "output-available", output: null };
  }
}

/** Sim ids are `<kind>-<seq>`; the seq is the creation order the feed sorts by. */
function seqOf(id: string): number {
  return Number(id.slice(id.lastIndexOf("-") + 1));
}

function feedRows(sim: Sim): BundleRow[] {
  const entries: { id: string; part: DynamicToolUIPart }[] = [];
  if (sim.plan) {
    entries.push({
      id: sim.plan.id,
      part: activityTool(
        sim.plan.id,
        "plan",
        `${planCount(sim.plan)} steps`,
        sim.plan.done >= sim.plan.steps.length ? "done" : "live",
      ),
    });
  }
  for (const tab of sim.tabs) {
    entries.push({
      id: tab.id,
      part: activityTool(
        tab.id,
        "fetch-url",
        tab.host,
        tab.state === "loading" ? "live" : "done",
        tab.state === "ready" ? { outcome: { bytes: 12_800 } } : {},
      ),
    });
  }
  for (const agent of sim.agents) {
    const state = agent.state === "working" ? "live" : agent.state === "done" ? "done" : "failed";
    entries.push({
      id: agent.id,
      part: activityTool(agent.id, "delegate", agent.label, state, {
        nativeToolName: "delegate",
        outcome: agent.state === "done" ? { summary: "3 tools" } : undefined,
        errorText: agent.state === "stopped" ? "Stopped" : "Subagent failed",
      }),
    });
  }
  for (const shell of sim.shells) {
    entries.push({
      id: shell.id,
      part: activityTool(
        shell.id,
        "run-command",
        shell.command,
        shell.state === "running" ? "live" : "done",
        shell.state === "exited" ? { outcome: { exitCode: shell.code ?? 0 } } : {},
      ),
    });
  }
  entries.sort((a, b) => seqOf(a.id) - seqOf(b.id));
  if (entries.length === 0) return [];
  return [
    {
      kind: "reasoning",
      key: "thought",
      streaming: false,
      part: {
        type: "reasoning",
        state: "done",
        text: "**Splitting the audit**\n\nA tab for the lab, one subagent per grep, a shell for the checks.",
      },
    },
    ...entries.map(({ id, part }) => ({ kind: "tool" as const, key: `tool-${id}`, part })),
  ];
}

const USER_PROMPT =
  "Audit the icon weights across the composer and open the lab on :5177 so I can see it. Split the grep work into subagents.";

function Feed({ sim }: { sim: Sim }) {
  const rows = React.useMemo(() => feedRows(sim), [sim]);
  const working =
    sim.tabs.some((tab) => tab.state === "loading") ||
    sim.agents.some((agent) => agent.state === "working") ||
    sim.shells.some((shell) => shell.state === "running");
  return (
    // Bottom-anchored and top-clipped, the way a followed transcript sits.
    <div className="flex min-h-0 flex-1 flex-col justify-end gap-6 overflow-hidden pb-4">
      <Message from="user" className="relative max-w-full">
        <MessageContent className="gap-0 group-[.is-user]:rounded-xl group-[.is-user]:bg-muted group-[.is-user]:px-4 group-[.is-user]:py-2">
          <GuardedResponse>{USER_PROMPT}</GuardedResponse>
        </MessageContent>
      </Message>
      <Message from="assistant" className="relative max-w-full">
        <MessageContent className="gap-0">
          <div className="space-y-4">
            <GuardedResponse>
              I'll open the lab in a tab, split the grep work across subagents, and run the checks
              in the background while they work.
            </GuardedResponse>
            {rows.length > 0 ? <ActivityBundle rows={rows} /> : null}
            {rows.length > 0 ? (
              <GuardedResponse isAnimating={working}>
                {working
                  ? "Folding their findings in as they land."
                  : "Everything has landed — here is what the audit found."}
              </GuardedResponse>
            ) : null}
          </div>
        </MessageContent>
      </Message>
    </div>
  );
}

/* ------------------------------------------------------------- the scratch */

export default function ActivityIslandHarness() {
  const [feel, setFeel] = React.useState<ActivityIslandFeel>(ACTIVITY_ISLAND_FEEL);
  const [sim, dispatch] = React.useReducer(simReducer, INITIAL_SIM);
  const [composerValue, setComposerValue] = React.useState("");

  const timers = React.useRef<number[]>([]);
  React.useEffect(
    () => () => {
      for (const timer of timers.current) window.clearTimeout(timer);
    },
    [],
  );

  /** The island's verbs, answered by the sim. */
  const actions = React.useMemo<ActivityIslandActions>(
    () => ({
      closeTab: (id) => dispatch({ type: "close-tab", id }),
      promoteTab: (id) => dispatch({ type: "promote-tab", id }),
      peekAgent: (id) => dispatch({ type: "peek-agent", id }),
      promoteAgent: (id) => dispatch({ type: "promote-agent", id }),
      stopAgent: (id) => dispatch({ type: "stop-agent", id }),
      openShell: (id) => dispatch({ type: "open-shell", id }),
      killShell: (id) => dispatch({ type: "kill-shell", id }),
      jumpStep: (id) => dispatch({ type: "jump-step", id }),
    }),
    [],
  );

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

  const dial = <K extends keyof ActivityIslandFeel>(key: K, value: ActivityIslandFeel[K]) =>
    setFeel((current) => ({ ...current, [key]: value }));

  return (
    <TooltipProvider>
      <div className="flex flex-col gap-6">
        {/* ------------------------------------------------ the stage */}
        {/* Height is inline: it is the room the cards have above the pill, and
            a dropped utility here would silently flip every tall card below
            the island. 640 leaves ~400px, a short real chat pane. */}
        <div
          className="flex flex-col rounded-xl border border-border bg-background px-4 pt-4"
          style={{ height: 640 }}
        >
          <ContentColumn className="flex min-h-0 flex-1 flex-col">
            <Feed sim={sim} />
            <ActivityIsland model={sim} actions={actions} feel={feel} className="mb-2" />
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
                value={feel.grammar}
                size="sm"
                options={[
                  { key: "clusters-now", label: "Clusters + now" },
                  { key: "now-only", label: "Now only" },
                  { key: "clusters-only", label: "Clusters only" },
                ]}
                onChange={(grammar) => dial("grammar", grammar)}
              />
            </Dial>
            <Dial label="Hover">
              <Segmented
                ariaLabel="Hover treatment"
                value={feel.hover}
                size="sm"
                options={[
                  { key: "none", label: "None" },
                  { key: "tooltip", label: "Tooltip" },
                  { key: "popover", label: "Popover" },
                ]}
                onChange={(hover) => dial("hover", hover)}
              />
            </Dial>
            <Dial label="Now text">
              <Segmented
                ariaLabel="Now channel text voice"
                value={feel.nowVoice}
                size="sm"
                options={[
                  { key: "quiet", label: "Quiet" },
                  { key: "payload", label: "Payload" },
                  { key: "loud", label: "Loud" },
                ]}
                onChange={(nowVoice) => dial("nowVoice", nowVoice)}
              />
            </Dial>
            <Dial label="Row actions">
              <Segmented
                ariaLabel="Card row action reveal"
                value={feel.reveal}
                size="sm"
                options={[
                  { key: "hover", label: "Hover" },
                  { key: "pinned", label: "Pinned" },
                  { key: "always", label: "Always" },
                ]}
                onChange={(reveal) => dial("reveal", reveal)}
              />
            </Dial>
            <Slider
              label="Spring duration"
              value={feel.springDuration}
              display={`${feel.springDuration.toFixed(2)}s`}
              min={0.25}
              max={0.8}
              step={0.05}
              onChange={(value) => dial("springDuration", value)}
            />
            <Slider
              label="Spring bounce"
              value={feel.springBounce}
              display={feel.springBounce.toFixed(2)}
              min={0}
              max={0.4}
              step={0.02}
              onChange={(value) => dial("springBounce", value)}
            />
            <Slider
              label="Flash hold"
              value={feel.flashHoldSeconds}
              display={`${feel.flashHoldSeconds.toFixed(1)}s`}
              min={0.8}
              max={3}
              step={0.1}
              onChange={(value) => dial("flashHoldSeconds", value)}
            />
            <div className="flex items-center gap-1">
              <Button
                size="xs"
                variant={feel.forceReducedMotion ? "secondary" : "ghost"}
                onClick={() => dial("forceReducedMotion", !feel.forceReducedMotion)}
              >
                Reduced motion
              </Button>
              <Button
                size="xs"
                variant={feel.armDestructive ? "secondary" : "ghost"}
                onClick={() => dial("armDestructive", !feel.armDestructive)}
              >
                Arm destructive
              </Button>
              <span className="ml-2 text-label text-muted-foreground">Presets</span>
              <Button
                size="xs"
                variant="ghost"
                onClick={() =>
                  setFeel((current) => ({ ...current, springDuration: 0.55, springBounce: 0.25 }))
                }
              >
                Lively
              </Button>
              <Button
                size="xs"
                variant="ghost"
                onClick={() =>
                  setFeel((current) => ({ ...current, springDuration: 0.35, springBounce: 0.08 }))
                }
              >
                Crisp
              </Button>
              <Button size="xs" variant="ghost" onClick={() => setFeel(ACTIVITY_ISLAND_FEEL)}>
                Verdicts
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
