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
