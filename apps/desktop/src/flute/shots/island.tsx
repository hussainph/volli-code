/**
 * Shot: the Activity Island, exploded (VC-246, VC-268, VC-269, VC-270; plan
 * VC-6).
 *
 * Real: `ActivityIsland` over an `ActivityIslandModel`, above a real chat
 * (`Message`, `ActivityBundle`, `SessionComposer`). The pill rides its own
 * Surface in the slot the chat leaves for it. Each exploded layer is the
 * island's own card — the Radix popover the shipped hover opens — lifted onto
 * a Surface of its own:
 *
 *   • every layer mounts a real `ActivityIsland` (same model) whose pill is
 *     hidden, and hovers ONE cluster's anchor once, at mount, so the shipped
 *     `ClusterShell` opens that cluster's real card;
 *   • the card's popper wrapper, which Radix portals to `document.body`, is
 *     moved into the layer's slot the moment it appears, and handed back to
 *     `body` before React unmounts it. Its floating position is neutralised
 *     by the scoped style below — the Surface is the position now.
 *
 * Nothing is re-drawn: the card rows, the plan hairline, the working arcs and
 * the pill's springs are the component's own, fed a model computed from `t`.
 * Where the cards travel (explode, converge) is the recipe's surface tracks
 * (scripts/film/shots/island.mjs); what they say is `t` here.
 *
 * Subagent model + effort (VC-416) rides `IslandAgent.model`, which lands on
 * the agents card's second row line. The agent fixtures below carry it; the
 * card draws it once VC-416 is in this tree.
 */
import * as React from "react";
import { Surface } from "@webprodigies/flute";
import {
  ACTIVITY_METADATA_KEY,
  type ActivityDescriptor,
  type ActivityKind,
  type ActivityOutcome,
} from "@volli/shared";
import {
  planCount,
  type ActivityIslandActions,
  type ActivityIslandFeel,
  type ActivityIslandModel,
  type BundleRow,
  type IslandAgent,
  type IslandCluster,
  type IslandFlash,
  type IslandPlan,
  type IslandShell,
  type IslandTab,
} from "@volli/session-presentation";
import type { DynamicToolUIPart } from "ai";

import { ActivityIsland } from "@renderer/components/chat/activity-island-ui";
import { ActivityBundle } from "@renderer/components/chat/activity-ui";
import { SessionComposer, type ComposerModel } from "@renderer/components/chat/composer-ui";
import { GuardedResponse } from "@renderer/components/chat/markdown-boundary";
import { ContentColumn } from "@renderer/components/layout/content-column";
import { Message, MessageContent } from "@renderer/components/ui/ai-elements/message";
import { TooltipProvider } from "@renderer/components/ui/tooltip";

import { FrameLayer, Supers, useFilm, Vignette, type Cue, type Format } from "../kit/film";
import { Backdrop, useFilmTheme } from "../kit/world";

/* ---------------------------------------------------------------- geometry */

/**
 * World layout, in the lab's CSS px from the scene's centre. Mirrored by the
 * rig in scripts/film/shots/island.mjs — change one, change both.
 */
export const CHAT = { width: 640, height: 620, top: -250 };
/** The chat's padding above the feed, and the feed's fixed height. */
const CHAT_PAD = 16;
const FEED_HEIGHT = 404;
/** The island's slot: the pill (h-8) and its 8px to the composer. */
const PILL_HEIGHT = 32;
const SLOT_HEIGHT = 40;
/** Where the pill's top edge sits, in world y. */
export const PILL_TOP = CHAT.top + CHAT_PAD + FEED_HEIGHT;
/** The pill's Surface is taller than the pill, so the now-drop above it stays inside. */
const PILL_SURFACE = { width: 520, height: 88 };
/** The column the island measures (the chat's width less its padding) — cards take 75% of it. */
const COLUMN = CHAT.width - 2 * CHAT_PAD;

/** Each card's Surface box; the card sits on its bottom edge, the way it hangs above the pill. */
export const CARD = {
  width: Math.round(COLUMN * 0.75),
  height: { plan: 190, agents: 110, shells: 110, tabs: 110 } satisfies Record<
    IslandCluster,
    number
  >,
};

/* ---------------------------------------------------------------- fixtures */

const SESSION = "ses-dark-checkout";

const STEPS = [
  "Read checkout form styles",
  "Add dark theme tokens",
  "Wire dark variants",
  "Run the test suite",
  "Check it in the browser",
] as const;

/** The Session's script, in scene ms. */
export const T = {
  /** Steps 2–4 tick off; step 1 is done before the shot starts. */
  stepDone: [1040, 1420, 2140] as const,
  reviewDone: 1640,
  testExit: 2010,
  tabReady: 2330,
  /** The now-drop, as the layers land back in the pill. */
  flashAt: 3260,
  flashUntil: 4400,
};

/**
 * The Session's discrete state at `t`. Everything the island draws is a pure
 * function of this — and it is also the key that decides WHEN the island
 * re-renders (see `Settled`).
 */
interface Phase {
  done: number;
  reviewDone: boolean;
  testExited: boolean;
  tabReady: boolean;
  flash: boolean;
}

function phaseAt(t: number, withFlash: boolean): Phase {
  return {
    done: 1 + T.stepDone.filter((at) => t >= at).length,
    reviewDone: t >= T.reviewDone,
    testExited: t >= T.testExit,
    tabReady: t >= T.tabReady,
    flash: withFlash && t >= T.flashAt && t < T.flashUntil,
  };
}

function planOf(done: number): IslandPlan {
  return {
    id: `${SESSION}:plan`,
    steps: STEPS.map((title, index) => ({
      id: `${SESSION}:step-${index + 1}`,
      title,
      state: index < done ? "completed" : index === done ? "in_progress" : "pending",
    })),
    done,
  };
}

/**
 * What the delegating agent chose per child (VC-416). Returned from a helper
 * rather than written into a typed literal, so the fixture carries the field
 * whether or not this tree's `IslandAgent` has learned it yet.
 */
const REVIEW_POLICY = {
  providerId: "anthropic",
  modelId: "sonnet-4.5",
  reasoningLevel: "high",
} as const;
const AUDIT_POLICY = {
  providerId: "anthropic",
  modelId: "haiku-4.5",
  reasoningLevel: "low",
} as const;

function agent(
  id: string,
  label: string,
  state: IslandAgent["state"],
  policy: typeof REVIEW_POLICY | typeof AUDIT_POLICY,
): IslandAgent {
  const row = { id, label, progress: 0, state, promoted: false, model: policy };
  return row;
}

function modelOf(phase: Phase): ActivityIslandModel {
  const tabs: IslandTab[] = [
    {
      id: "tab-voltaic-local",
      host: "localhost:5173",
      state: "ready",
      promoted: true,
      surface: "preview",
      owner: null,
    },
    {
      id: "tab-voltaic-checkout",
      host: "voltaic.example",
      state: phase.tabReady ? "ready" : "loading",
      promoted: false,
      surface: null,
      owner: "Review diff",
    },
  ];
  const agents = [
    agent("agent-review-diff", "Review diff", phase.reviewDone ? "done" : "working", REVIEW_POLICY),
    agent("agent-audit-contrast", "Audit contrast", "working", AUDIT_POLICY),
  ];
  const shells: IslandShell[] = [
    { id: "shell-dev", command: "pnpm dev", state: "running", code: null },
    {
      id: "shell-test",
      command: "pnpm test",
      state: phase.testExited ? "exited" : "running",
      code: phase.testExited ? 0 : null,
    },
  ];
  const flash: IslandFlash | null = phase.flash
    ? { id: "flash-review-done", event: "Done", payload: "Review diff" }
    : null;
  return { tabs, agents, plan: planOf(phase.done), shells, flash };
}

/**
 * Commits a state change to the island ONE render after the frame's own
 * commit.
 *
 * The island's `layout` springs (the pill, every card row) measure their box
 * before and after each of their own re-renders and animate the difference.
 * In a frame the camera moves in the same commit, so a re-render there reads
 * the camera's travel as a layout change and flings the pill and the rows
 * across the card. Re-rendered on its own — from a layout effect, after the
 * camera has landed — the before and after share one camera, and only a real
 * change animates, on the real spring. Between state changes the island does
 * not re-render at all.
 */
const Settled = React.memo(
  function Settled({
    phase,
    render,
  }: {
    phase: string;
    render: (phase: Phase) => React.ReactNode;
  }) {
    const [shown, setShown] = React.useState(phase);
    React.useLayoutEffect(() => {
      if (shown !== phase) setShown(phase);
    }, [phase, shown]);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `render` is a pure function of the phase.
    return React.useMemo(() => render(JSON.parse(shown) as Phase), [shown]);
  },
  (a, b) => a.phase === b.phase,
);

const noop = () => undefined;
const ACTIONS: ActivityIslandActions = {
  closeTab: noop,
  promoteTab: noop,
  peekAgent: noop,
  promoteAgent: noop,
  stopAgent: noop,
  openShell: noop,
  killShell: noop,
  jumpStep: noop,
  replayTab: noop,
};

/**
 * The shipped verdicts, with the flash hold pushed past the shot: the hold is
 * a wall-clock timer, so the drop's life is decided by `t` (the model carries
 * the flash only inside its window) rather than by how fast frames render.
 */
const FEEL: Partial<ActivityIslandFeel> = { flashHoldSeconds: 3600 };

/* ---------------------------------------------------------------- the chat */

const COMPOSER_MODELS: ComposerModel[] = [
  {
    id: "anthropic/claude-sonnet-4-5",
    label: "sonnet-4.5",
    providerId: "anthropic",
    providerLabel: "Anthropic",
    modelId: "claude-sonnet-4-5",
    reasoningLevels: ["low", "medium", "high"],
  },
];

function outcome(patch: Partial<ActivityOutcome>): ActivityOutcome {
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

/** One transcript row, built the way the island scratch's feed builds them. */
function tool(
  id: string,
  kind: ActivityKind,
  label: string,
  live: boolean,
  done?: Partial<ActivityOutcome>,
): BundleRow {
  const descriptor: ActivityDescriptor = {
    kind,
    nativeToolName: kind,
    subject: { label, path: null, lineRange: null },
    outcome: !live && done ? outcome(done) : null,
    startedAt: 0,
    endedAt: live ? null : 2400,
  };
  const base = {
    type: "dynamic-tool" as const,
    toolName: kind,
    toolCallId: `island-${id}`,
    toolMetadata: { [ACTIVITY_METADATA_KEY]: descriptor } as DynamicToolUIPart["toolMetadata"],
    input: null,
  };
  const part: DynamicToolUIPart = live
    ? { ...base, state: "input-available" }
    : { ...base, state: "output-available", output: null };
  return { kind: "tool", key: `tool-${id}`, part };
}

function feedRows(model: ActivityIslandModel): BundleRow[] {
  const plan = model.plan!;
  return [
    tool("plan", "plan", `${planCount(plan)} steps`, true),
    ...model.agents.map((a) =>
      tool(a.id, "delegate", a.label, a.state === "working", { summary: "4 tools" }),
    ),
    ...model.shells.map((s) =>
      tool(s.id, "run-command", s.command, s.state === "running", { exitCode: s.code ?? 0 }),
    ),
    tool("tab", "fetch-url", "voltaic.example", model.tabs[1]!.state === "loading", {
      bytes: 14_200,
    }),
  ];
}

function ChatPane({ model }: { model: ActivityIslandModel }) {
  return (
    <div
      className="flex flex-col overflow-hidden rounded-xl border border-border bg-background shadow-overlay"
      style={{ width: CHAT.width, height: CHAT.height, padding: `${CHAT_PAD}px ${CHAT_PAD}px 0` }}
    >
      <ContentColumn className="flex min-h-0 flex-1 flex-col px-0">
        <div
          className="flex flex-col justify-end gap-6 overflow-hidden pb-4"
          style={{ height: FEED_HEIGHT, flex: "none" }}
        >
          <Message from="user" className="relative max-w-full">
            <MessageContent className="gap-0 group-[.is-user]:rounded-xl group-[.is-user]:bg-muted group-[.is-user]:px-4 group-[.is-user]:py-2">
              <GuardedResponse>
                Add a dark theme to the checkout form, then run the tests and show me it working.
              </GuardedResponse>
            </MessageContent>
          </Message>
          <Message from="assistant" className="relative max-w-full">
            <MessageContent className="gap-0">
              <div className="space-y-4">
                <GuardedResponse>
                  Planning it out. A subagent reviews the diff while the tests run in the
                  background.
                </GuardedResponse>
                <ActivityBundle rows={feedRows(model)} />
              </div>
            </MessageContent>
          </Message>
        </div>
        {/* The island's slot. The pill is its own Surface, laid exactly here. */}
        <div style={{ height: SLOT_HEIGHT, flex: "none" }} />
        <div className="pb-4">
          <SessionComposer
            value=""
            onValueChange={noop}
            models={COMPOSER_MODELS}
            selection={{
              providerId: "anthropic",
              modelId: "claude-sonnet-4-5",
              reasoningLevel: "high",
            }}
            onSelectionChange={noop}
            working
            ready
            queued={[]}
            onQueuedChange={noop}
            onSteerQueued={noop}
            onSubmit={noop}
            onStop={noop}
          />
        </div>
      </ContentColumn>
    </div>
  );
}

/* ---------------------------------------------------------------- a layer */

/**
 * The popper wrapper Radix portals to `body` is floated by inline style; in
 * a layer the Surface is the position, so the wrapper sits in normal flow. A
 * wrapper still on `body` (the one frame before it is adopted) never paints.
 */
const LAYER_STYLE = `
body > [data-radix-popper-content-wrapper]:has([data-island-card]) { visibility: hidden !important; }
.film-island-slot > [data-radix-popper-content-wrapper] {
  position: relative !important;
  inset: auto !important;
  transform: none !important;
  min-width: 0 !important;
  z-index: auto !important;
}
`;

function CardLayer({ cluster, model }: { cluster: IslandCluster; model: ActivityIslandModel }) {
  const anchors = React.useRef<HTMLDivElement>(null);
  const slot = React.useRef<HTMLDivElement>(null);
  const adopted = React.useRef<HTMLElement | null>(null);

  React.useLayoutEffect(() => {
    const host = slot.current;
    if (host === null) return;
    const adopt = () => {
      if (adopted.current?.isConnected && adopted.current.parentElement === host) return;
      const card = document.querySelector<HTMLElement>(
        `body > [data-radix-popper-content-wrapper] > [data-island-card="${cluster}"]`,
      );
      const wrapper = card?.parentElement;
      if (!wrapper) return;
      host.append(wrapper);
      adopted.current = wrapper;
    };
    // The card mounts a render or two after the hover (Radix's Presence and
    // Portal each take one), so watch for it rather than poll.
    const observer = new MutationObserver(adopt);
    observer.observe(document.body, { childList: true });
    // The shipped hover: React's onMouseEnter is synthesised from `mouseover`.
    const anchor = anchors.current?.querySelector<HTMLElement>(
      `[data-island-cluster="${cluster}"]`,
    );
    anchor?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: null }));
    adopt();
    return () => {
      observer.disconnect();
      // Hand the wrapper back before React removes it from the portal's container.
      if (adopted.current !== null) document.body.append(adopted.current);
      adopted.current = null;
    };
  }, [cluster]);

  return (
    <div className="relative" style={{ width: CARD.width, height: CARD.height[cluster] }}>
      <div
        ref={anchors}
        aria-hidden
        className="pointer-events-none absolute bottom-0 left-1/2"
        style={{ width: COLUMN, marginLeft: -COLUMN / 2, visibility: "hidden" }}
      >
        <ActivityIsland model={model} actions={ACTIONS} feel={FEEL} />
      </div>
      <div
        ref={slot}
        className="film-island-slot absolute inset-x-0 bottom-0 flex flex-col justify-end"
      />
    </div>
  );
}

/* ---------------------------------------------------------------- supers */

const CUE = {
  at: 900,
  until: 3050,
  eyebrow: "Smarter agents",
  lines: ["See everything", "your agent does."],
  weights: [800, 320],
  sub: "Subagents, shells, browser tabs.",
} as const;

const CUES: Record<Format, Cue[]> = {
  landscape: [{ ...CUE, lines: [...CUE.lines], weights: [...CUE.weights], place: "lower" }],
  // 9:16: out before the pill climbs back into the eyebrow (~2600ms).
  portrait: [
    { ...CUE, until: 2450, lines: [...CUE.lines], weights: [...CUE.weights], place: "lower" },
  ],
};

/* ---------------------------------------------------------------- the shot */

/** Card layers, in world position: centred over the pill, stacked up and toward the camera. */
export const LAYERS: IslandCluster[] = ["tabs", "shells", "agents", "plan"];

function cardBox(cluster: IslandCluster) {
  // Mirrors LAYOUT in island.mjs: the stack's CSS slots; z is the recipe's.
  const gap = 22;
  let bottom = PILL_TOP - 14;
  for (const layer of LAYERS) {
    const height = CARD.height[layer];
    if (layer === cluster) return { top: bottom - height, height };
    bottom -= height + gap;
  }
  throw new Error(cluster);
}

function place(x: number, top: number, width: number, height: number): React.CSSProperties {
  return {
    position: "absolute",
    left: `calc(50% + ${x - width / 2}px)`,
    top: `calc(50% + ${top}px)`,
    width,
    height,
  };
}

export function IslandShot({ format }: { format: Format }) {
  useFilmTheme("cobalt");
  const t = useFilm();
  const pillPhase = JSON.stringify(phaseAt(t, true));
  const phase = JSON.stringify(phaseAt(t, false));

  return (
    <TooltipProvider>
      <style>{LAYER_STYLE}</style>
      <Surface
        id="chat"
        style={place(0, CHAT.top, CHAT.width, CHAT.height)}
        content={<Settled phase={phase} render={(p) => <ChatPane model={modelOf(p)} />} />}
      />
      <Surface
        id="island-pill"
        style={place(
          0,
          PILL_TOP + PILL_HEIGHT - PILL_SURFACE.height,
          PILL_SURFACE.width,
          PILL_SURFACE.height,
        )}
        content={
          <div
            className="flex flex-col justify-end"
            style={{ width: PILL_SURFACE.width, height: PILL_SURFACE.height }}
          >
            <Settled
              phase={pillPhase}
              render={(p) => <ActivityIsland model={modelOf(p)} actions={ACTIONS} feel={FEEL} />}
            />
          </div>
        }
      />
      {LAYERS.map((cluster) => {
        const box = cardBox(cluster);
        return (
          <Surface
            key={cluster}
            id={`card-${cluster}`}
            style={place(0, box.top, CARD.width, box.height)}
            content={
              <Settled
                phase={phase}
                render={(p) => <CardLayer cluster={cluster} model={modelOf(p)} />}
              />
            }
          />
        );
      })}
      <Backdrop t={t} theme="cobalt" />
      <FrameLayer format={format}>
        <Vignette strength={0.45} />
        <Supers cues={CUES[format]} t={t} format={format} />
      </FrameLayer>
    </TooltipProvider>
  );
}
