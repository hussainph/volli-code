/**
 * What a long Session's chat plane costs the renderer (VC-338).
 *
 * THE REAL `ChatPlane`, mounted in a real Chromium with a real layout, against
 * fixture transcripts and the refusing bridge. That import is the whole point:
 * a bench holding its own copy of the transcript drifts from the thing it claims
 * to measure and then reports the copy's numbers as the app's. Only the
 * fixtures, the store seeding and the instrumentation are local.
 *
 * It is driven from `window.chatBench`, never from a button, because the caller
 * is `e2e/chat-window-bench.mjs` — which samples renderer RSS from the main
 * process between steps, where the renderer cannot measure itself.
 *
 * The shape it reproduces is the app's: ONE chat-sessions store holding every
 * open Session's transcript (a tab that is not in front keeps its slice and
 * keeps folding), and as many planes MOUNTED as the surface is currently
 * drawing. `show(1)` is a reader with ten long Sessions open looking at one of
 * them; `show(10)` is what a surface retaining every plane behind a hidden box
 * used to cost.
 */
import "./bench.css";

import * as React from "react";
import { createRoot } from "react-dom/client";
import type { DynamicToolUIPart, UIMessage } from "ai";

import { ACTIVITY_METADATA_KEY, type ActivityDescriptor } from "@volli/shared";
import { EMPTY_TRANSCRIPT, type ChatSessionTransport } from "@volli/session-presentation";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { ChatPlane } from "@renderer/components/chat/chat-plane";
import { createChatSessionsStore } from "@renderer/stores/chat-sessions";
import { useBackgroundShellsStore } from "@renderer/stores/background-shells";
import { useBrowserTabsStore } from "@renderer/stores/browser-tabs";
import {
  EMPTY_PROJECT_SESSION_ROWS,
  useProjectSessionsStore,
} from "@renderer/stores/project-sessions";

const PROJECT = "bench-project";

/* ------------------------------------------------------------------ bridge */

/**
 * A bridge that refuses every invoke and subscribes to nothing, by shape — the
 * fixture `chat-plane.reveal.test.tsx` argues for, in a browser. Every door the
 * plane knocks on answers "not stubbed", which is the honest stand-in for a
 * main process this page does not have, and none of it touches the transcript.
 */
const bridgeNode = (path: string[]): unknown =>
  new Proxy(() => {}, {
    get(_target, key) {
      if (typeof key !== "string" || key === "then") return undefined;
      return bridgeNode([...path, key]);
    },
    apply(_target, _this, args) {
      const name = path.at(-1) ?? "";
      if (name.startsWith("on")) return () => {};
      if (name === "pathForFile") return String(args[0]);
      return Promise.resolve({ ok: false, error: "not stubbed" });
    },
  });

Object.defineProperty(window, "api", { value: bridgeNode([]), writable: true });

/* ---------------------------------------------------------------- fixtures */

const FENCE = [
  "```ts",
  "export function segmentTurn(messages: readonly UIMessage[]): ChatSegment[] {",
  "  const segments: ChatSegment[] = [];",
  "  for (const message of messages) {",
  "    for (const part of message.parts) {",
  '      if (part.type === "text") segments.push({ kind: "text", part, key: part.text });',
  '      else if (part.type === "dynamic-tool") segments.push({ kind: "bundle", rows: [part] });',
  "    }",
  "  }",
  "  return segments;",
  "}",
  "```",
].join("\n");

/** A read payload long enough to be worth highlighting, short of the 400-line cap. */
function payload(index: number): string {
  return Array.from(
    { length: 40 },
    (_value, line) => `const value${index}_${line} = ${line} * ${index}; // a line of source`,
  ).join("\n");
}

function descriptor(index: number): ActivityDescriptor {
  return {
    kind: "read-file",
    nativeToolName: "read",
    subject: { label: `src/module-${index}.ts`, path: `src/module-${index}.ts`, lineRange: null },
    outcome: null,
    startedAt: index,
    endedAt: index + 1,
  };
}

function tool(index: number): DynamicToolUIPart {
  return {
    type: "dynamic-tool",
    toolName: "read",
    toolCallId: `read-${index}`,
    state: "output-available",
    input: null,
    output: payload(index),
    toolMetadata: {
      [ACTIVITY_METADATA_KEY]: descriptor(index),
    } as DynamicToolUIPart["toolMetadata"],
  };
}

/**
 * `turns` turns, alternating speakers: a question, then a reply that read a file
 * and said something about it — and every fourth reply ends on a fenced block,
 * which is where most of a transcript's DOM actually comes from (one span per
 * token). The first turn names itself so the bench can tell whether scrolling
 * up reached the beginning.
 */
function transcript(turns: number, session: string): UIMessage[] {
  const messages: UIMessage[] = [];
  for (let index = 0; index < turns; index += 1) {
    if (index % 2 === 0) {
      messages.push({
        id: `${session}-u${index}`,
        role: "user",
        parts: [
          {
            type: "text",
            text:
              index === 0
                ? "FIRST TURN: where does the transcript start?"
                : `Turn ${index}: and what about ${index % 7} of the remaining cases?`,
          },
        ],
      });
      continue;
    }
    messages.push({
      id: `${session}-a${index}`,
      role: "assistant",
      parts: [
        tool(index),
        {
          type: "text",
          text:
            index % 8 === 3
              ? `Turn ${index}. The projection folds the parts in order, which is why the rows stay stable:\n\n${FENCE}`
              : `Turn ${index}. Read \`src/module-${index}.ts\`; the shape is what the previous turn assumed, so nothing about the fold changes here.`,
        },
      ],
    });
  }
  return messages;
}

/* ------------------------------------------------------------------- store */

const store = createChatSessionsStore(
  () => ({ connect: async () => {}, dispose: () => {} }) as unknown as ChatSessionTransport,
);

function seedSessions(sessions: number, turns: number): string[] {
  const ids = Array.from({ length: sessions }, (_value, index) => `bench-session-${index}`);
  const slices: Record<string, unknown> = {};
  for (const id of ids) {
    const messages = transcript(turns, id);
    slices[id] = {
      projection: {
        session: { id, projectId: PROJECT, ticketId: null, title: id },
        status: "active",
        signal: null,
        modelSelection: null,
        modelTier: null,
        turnActive: false,
        lastActivityAt: 0,
        bornTicketless: true,
        attention: { active: [], primary: null },
        interactions: { active: [], resolved: [] },
        liveExecutor: null,
        authority: null,
      },
      transcript: { ...EMPTY_TRANSCRIPT, durableMessages: messages, messages },
      lifecycle: "ready",
      sessionError: null,
      queue: [],
    };
  }
  store.setState({ sessions: slices } as never);
  return ids;
}

/** One more turn on the end of a Session, the way a streamed reply arrives. */
function appendTurn(sessionId: string): void {
  store.setState((state) => {
    const slice = (state as unknown as { sessions: Record<string, never> }).sessions[sessionId];
    const current = (slice as unknown as { transcript: { messages: UIMessage[] } }).transcript
      .messages;
    const next: UIMessage[] = [
      ...current,
      {
        id: `${sessionId}-append-${current.length}`,
        role: "assistant",
        parts: [{ type: "text", text: `Appended turn ${current.length}, arriving at the tail.` }],
      },
    ];
    return {
      sessions: {
        ...(state as unknown as { sessions: Record<string, unknown> }).sessions,
        [sessionId]: {
          ...(slice as unknown as object),
          transcript: { ...EMPTY_TRANSCRIPT, durableMessages: next, messages: next },
        },
      },
    } as never;
  });
}

// The measured reply deliberately spends multiple token snapshots inside an
// open code fence before closing it. That exercises the production live
// markdown branch (including incremental code parsing), rather than measuring
// only settled prose while the realistic fenced blocks sit unchanged above it.
const STREAM_TOKENS = [
  "Streaming ",
  "benchmark ",
  "answer. ",
  "The ",
  "live ",
  "reply ",
  "opens ",
  "code:\n\n",
  "```ts\n",
  "export ",
  "function ",
  "frameCost",
  "(delta: ",
  "number) ",
  "{\n",
  "  const ",
  "budget ",
  "= 16.67;\n",
  "  return ",
  "Math.max",
  "(0, ",
  "delta ",
  "- budget);\n",
  "}\n",
  "```\n",
  "The ",
  "reader ",
  "keeps ",
  "scrolling ",
  "after ",
  "the ",
  "fence ",
  "settles. ",
] as const;
const STREAM_FENCE_OPEN_TOKEN = STREAM_TOKENS.indexOf("```ts\n") + 1;
const STREAM_FENCE_CLOSE_TOKEN = STREAM_TOKENS.indexOf("```\n") + 1;
const STREAM_SUFFIX =
  "The renderer continues folding prose and tool context without losing the reader position ".split(
    /(?<=\s)/,
  );

function streamText(tokenCount: number): string {
  if (tokenCount <= STREAM_TOKENS.length) return STREAM_TOKENS.slice(0, tokenCount).join("");
  return [
    ...STREAM_TOKENS,
    ...Array.from(
      { length: tokenCount - STREAM_TOKENS.length },
      (_value, index) => STREAM_SUFFIX[index % STREAM_SUFFIX.length],
    ),
  ].join("");
}

/** Replace one in-flight assistant overlay, preserving the message id. */
function streamSnapshot(sessionId: string, base: readonly UIMessage[], tokenCount: number): number {
  const text = streamText(tokenCount);
  const message: UIMessage = {
    id: `${sessionId}-stream-probe`,
    role: "assistant",
    parts: [{ type: "text", text }],
  };
  store.setState((state) => {
    const sessions = (state as unknown as { sessions: Record<string, unknown> }).sessions;
    const slice = sessions[sessionId] as {
      transcript: typeof EMPTY_TRANSCRIPT;
    };
    const next = [...base, message];
    return {
      sessions: {
        ...sessions,
        [sessionId]: {
          ...slice,
          lifecycle: "working",
          transcript: {
            ...slice.transcript,
            turnActive: true,
            durableMessages: base,
            messages: next,
          },
        },
      },
    } as never;
  });
  return text.length;
}

/** Commit the final overlay and leave the synthetic Session idle again. */
function settleStream(sessionId: string): void {
  store.setState((state) => {
    const sessions = (state as unknown as { sessions: Record<string, unknown> }).sessions;
    const slice = sessions[sessionId] as {
      transcript: typeof EMPTY_TRANSCRIPT;
    };
    return {
      sessions: {
        ...sessions,
        [sessionId]: {
          ...slice,
          lifecycle: "ready",
          transcript: {
            ...slice.transcript,
            turnActive: false,
            durableMessages: slice.transcript.messages,
          },
        },
      },
    } as never;
  });
}

/**
 * Grow one transcript snapshot at a wall-clock token rate while moving its
 * scroller every animation frame. Both actions share one frame loop by
 * construction. Long tasks
 * come from Chromium's PerformanceObserver; dropped frames are derived from a
 * refresh interval sampled before the loop, never hardcoded to 60 Hz.
 */
async function streamAndScroll(
  sessionId: string,
  index: number,
  steps: number,
  tokenRate: number,
): Promise<unknown> {
  const scroller = planeScroller(index);
  if (scroller === null) return { ok: false, why: "no scroller" };
  const slice = (store.getState() as unknown as { sessions: Record<string, never> }).sessions[
    sessionId
  ];
  const base = (
    slice as unknown as { transcript: { messages: readonly UIMessage[] } }
  ).transcript.messages.filter((message) => message.id !== `${sessionId}-stream-probe`);
  scroller.scrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight - 800);
  await settle();

  const refreshFrames: number[] = [];
  for (let sample = 0; sample < 20; sample += 1) {
    refreshFrames.push(await new Promise<number>((resolve) => requestAnimationFrame(resolve)));
  }
  const refreshDeltas = refreshFrames
    .slice(1)
    .map((value, at) => value - refreshFrames[at]!)
    .filter((value) => value > 0 && value < 50)
    .toSorted((a, b) => a - b);
  const refreshIntervalMs =
    refreshDeltas.length === 0 ? null : refreshDeltas[Math.floor(refreshDeltas.length * 0.25)]!;

  const longTasks: number[] = [];
  const observer =
    typeof PerformanceObserver === "undefined"
      ? null
      : new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) longTasks.push(entry.duration);
        });
  try {
    observer?.observe({ type: "longtask", buffered: false });
  } catch {
    // Older Chromium builds can omit long-task observation; the empty list in
    // the result says exactly that nothing was observed.
  }

  const frames: number[] = [];
  let scrollDistancePx = 0;
  let priorTop = scroller.scrollTop;
  let direction = -1;
  let streamedCharacters = 0;
  let priorTokenCount = 0;
  const started = performance.now();
  for (let step = 0; step < steps; step += 1) {
    const tokenCount = Math.max(1, Math.floor(((performance.now() - started) * tokenRate) / 1_000));
    if (tokenCount !== priorTokenCount) {
      streamedCharacters = streamSnapshot(sessionId, base, tokenCount);
      priorTokenCount = tokenCount;
    }
    const nextTop = Math.max(
      0,
      Math.min(scroller.scrollHeight - scroller.clientHeight, scroller.scrollTop + direction * 18),
    );
    scroller.scrollTop = nextTop;
    frames.push(await new Promise<number>((resolve) => requestAnimationFrame(resolve)));
    const actualTop = scroller.scrollTop;
    scrollDistancePx += Math.abs(actualTop - priorTop);
    priorTop = actualTop;
    if (actualTop <= 0 || actualTop >= scroller.scrollHeight - scroller.clientHeight)
      direction *= -1;
  }
  const streamedWhileWorking =
    (
      store.getState() as unknown as {
        sessions: Record<string, { lifecycle: string }>;
      }
    ).sessions[sessionId]?.lifecycle === "working";
  settleStream(sessionId);
  await settle();
  observer?.disconnect();
  const latencyMs = performance.now() - started;
  const frameTimesMs = frames.slice(1).map((value, at) => value - frames[at]!);
  const droppedFrames =
    refreshIntervalMs === null
      ? null
      : frameTimesMs.reduce(
          (sum, duration) => sum + Math.max(0, Math.round(duration / refreshIntervalMs) - 1),
          0,
        );
  return {
    ok: true,
    steps,
    tokenRate,
    streamedTokens: priorTokenCount,
    streamedWhileWorking,
    codeFenceOpened: priorTokenCount >= STREAM_FENCE_OPEN_TOKEN,
    codeFenceClosed: priorTokenCount >= STREAM_FENCE_CLOSE_TOKEN,
    latencyMs,
    refreshIntervalMs,
    frameTimesMs,
    droppedFrames,
    longTasksMs: longTasks,
    scrollDistancePx,
    streamedCharacters,
  };
}

/* ----------------------------------------------------------------- surface */

let setMounted: ((ids: readonly string[]) => void) | null = null;

function BenchSurface() {
  const [ids, setIds] = React.useState<readonly string[]>([]);
  React.useEffect(() => {
    setMounted = setIds;
  }, []);
  return (
    <TooltipProvider delayDuration={0}>
      {/* Panes side by side, each a full-height column, because a plane that is
          not laid out does not virtualize, scroll or paint — and then none of
          these numbers are about the app. */}
      <div className="flex h-svh w-full bg-background text-foreground">
        {ids.map((id) => (
          <div key={id} data-bench-plane={id} className="flex min-h-0 min-w-0 flex-1 flex-col">
            <ChatPlane
              sessionId={id}
              projectId={PROJECT}
              ticketId={null}
              onOpenFile={() => {}}
              store={store}
            />
          </div>
        ))}
      </div>
    </TooltipProvider>
  );
}

/* --------------------------------------------------------- instrumentation */

function frame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/** Two frames plus a macrotask: long enough for layout, effects and a resize pass. */
async function settle(): Promise<void> {
  await frame();
  await frame();
  await new Promise((resolve) => setTimeout(resolve, 120));
}

/** Every element in the document — the number the Ticket asks to be bounded. */
function nodes(): number {
  return document.getElementsByTagName("*").length;
}

function planeScroller(index: number): HTMLElement | null {
  const plane = document.querySelectorAll<HTMLElement>("[data-bench-plane]")[index];
  if (plane === undefined) return null;
  // `StickToBottom` renders the scrolling element as the first child of the
  // `role="log"` box (its `Content` wrapper), with the measured content inside
  // it. The library offers no hook for a data attribute on that element, so the
  // bench walks to it rather than marking it.
  const log = plane.querySelector<HTMLElement>('[role="log"]');
  const scroller = log?.querySelector<HTMLElement>(":scope > div") ?? null;
  return scroller;
}

function geometry(index: number): { top: number; height: number; client: number } | null {
  const scroller = planeScroller(index);
  if (scroller === null) return null;
  return { top: scroller.scrollTop, height: scroller.scrollHeight, client: scroller.clientHeight };
}

/**
 * Scroll to the top, repeatedly, until the first turn is in the document or the
 * budget runs out. One press of the window's own affordance is never enough on
 * purpose: the transcript pages history in, so "reaches the first message" is a
 * claim about a sequence of scrolls, not about one.
 */
async function reachFirst(index: number, steps: number): Promise<unknown> {
  const started = performance.now();
  for (let step = 0; step < steps; step += 1) {
    const scroller = planeScroller(index);
    if (scroller === null) return { reached: false, why: "no scroller" };
    scroller.scrollTop = 0;
    await settle();
    if (document.body.textContent?.includes("FIRST TURN") === true) {
      return {
        reached: true,
        steps: step + 1,
        nodes: nodes(),
        ms: Math.round(performance.now() - started),
      };
    }
  }
  return { reached: false, steps, nodes: nodes() };
}

/**
 * The two halves of the sticky tail: a turn arriving while the reader is at the
 * bottom keeps the bottom, and the same turn arriving after they have scrolled
 * up leaves them where they are.
 */
async function tailProbe(sessionId: string, index: number): Promise<unknown> {
  const scroller = planeScroller(index);
  if (scroller === null) return { ok: false, why: "no scroller" };

  scroller.scrollTop = scroller.scrollHeight;
  await settle();
  const pinnedBefore = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
  appendTurn(sessionId);
  await settle();
  const pinnedAfter = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;

  const escaped = Math.max(0, scroller.scrollHeight - scroller.clientHeight - 1200);
  scroller.scrollTop = escaped;
  await settle();
  const heldBefore = scroller.scrollTop;
  appendTurn(sessionId);
  await settle();
  const heldAfter = scroller.scrollTop;

  return {
    pinnedGapBefore: Math.round(pinnedBefore),
    pinnedGapAfter: Math.round(pinnedAfter),
    releasedOffsetBefore: Math.round(heldBefore),
    releasedOffsetAfter: Math.round(heldAfter),
  };
}

interface ChatBench {
  seed(sessions: number, turns: number): Promise<{ ids: string[]; nodes: number }>;
  show(count: number): Promise<{ mounted: number; nodes: number }>;
  nodes(): number;
  geometry(index: number): unknown;
  reachFirst(index: number, steps: number): Promise<unknown>;
  tailProbe(index: number): Promise<unknown>;
  streamAndScroll(index: number, steps: number, tokenRate: number): Promise<unknown>;
  collect(): void;
}

let sessionIds: string[] = [];

const bench: ChatBench = {
  async seed(sessions, turns) {
    useBrowserTabsStore.setState({ byId: {}, hydratedProjects: new Set([PROJECT]) });
    useBackgroundShellsStore.setState({ byId: {}, hydrated: true });
    useProjectSessionsStore.setState({ byProject: { [PROJECT]: EMPTY_PROJECT_SESSION_ROWS } });
    sessionIds = seedSessions(sessions, turns);
    await settle();
    return { ids: sessionIds, nodes: nodes() };
  },
  async show(count) {
    setMounted?.(sessionIds.slice(0, count));
    await settle();
    // Highlighting and markdown land over a few frames; give the mounted planes
    // room to finish before anything is measured.
    await settle();
    return { mounted: count, nodes: nodes() };
  },
  nodes,
  geometry,
  reachFirst,
  async tailProbe(index) {
    const sessionId = sessionIds[index];
    if (sessionId === undefined) return { ok: false, why: "no session" };
    return tailProbe(sessionId, index);
  },
  async streamAndScroll(index, steps, tokenRate) {
    const sessionId = sessionIds[index];
    if (sessionId === undefined) return { ok: false, why: "no session" };
    return streamAndScroll(sessionId, index, steps, tokenRate);
  },
  collect() {
    // Present because the bench runner launches Electron with --expose-gc: a
    // number sampled before the garbage of the previous step is collected is a
    // number about the garbage.
    (globalThis as { gc?: () => void }).gc?.();
  },
};

Object.defineProperty(window, "chatBench", { value: bench, writable: false });

const host = document.querySelector("#root");
if (host !== null) createRoot(host).render(<BenchSurface />);
