/**
 * What one animation frame of live chat streaming costs the renderer, by how
 * many chats are open and how many of them are streaming at once (VC-515).
 *
 * `docs/performance-benchmark.md` measures one live ChatPlane. This prices the
 * case it cannot see: N resident chat Sessions in the real
 * {@link createChatSessionsStore}, each behind a real `ChatSessionClient` on the
 * real `racingFlushScheduler`, with 1–3 of them receiving token overlays. Every
 * frame the streaming clients flush, and every store write runs every mounted
 * subscriber's selector — so the subscribers here are the app's own: the ⌘K
 * palette's resident-title selector, the usage rail's settle signal, the
 * sidebar's per-project resident-title scan, and the one visible ChatPlane's
 * slice read.
 *
 * What is asserted is the shape, not the clock: the store publishes ONE write
 * per frame however many clients streamed into it, and a closed palette and
 * the usage rail do no work proportional to the open chats. Times are printed
 * for the PR's before/after table; jsdom has no paint, so React's render is
 * not in them — only the store writes and selector passes that schedule it.
 */
import { describe, expect, it, vi } from "vite-plus/test";

import {
  racingFlushScheduler,
  type ChatSessionProjection,
  type ChatSessionRpc,
  type ChatSessionTransport,
  type FlushHost,
} from "@volli/session-presentation";
import type { SessionPresentationProjection } from "@volli/shared";

import { createChatSessionsStore, type ChatSessionsState } from "./chat-sessions";
import { paletteResidentTitlesSelector, selectSettleSignal } from "./chat-session-selectors";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));

const OPEN = [10, 50, 200] as const;
const STREAMING = [1, 2, 3] as const;
const FRAMES = 300;
const OVERLAYS_PER_FRAME = 4;
const ROSTER = 5_034;

function projectionFor(sessionId: string): ChatSessionProjection {
  const projection: SessionPresentationProjection = {
    session: {
      id: sessionId,
      projectId: "p1",
      ticketId: null,
      role: "project",
      parentSessionId: null,
      title: `Chat ${sessionId}`,
      createdAt: 0,
    },
    status: "open",
    liveExecutor: null,
    attention: { active: [], primary: null },
    interactions: { active: [], resolved: [] },
    signal: null,
    modelSelection: null,
    modelTier: null,
    turnActive: false,
    lastActivityAt: 0,
    bornTicketless: true,
    scheduledResume: null,
  };
  return { ...projection, queue: [], queueRevision: 0 };
}

type Handlers = Parameters<ChatSessionRpc["session"]["subscribe"]["subscribe"]>[1];

/** A window whose frames the bench runs by hand, all of a frame's callbacks together. */
function manualHost() {
  let callbacks = new Map<number, () => void>();
  let next = 0;
  const host: FlushHost = {
    requestAnimationFrame(callback) {
      next += 1;
      callbacks.set(next, callback);
      return next;
    },
    cancelAnimationFrame(handle) {
      callbacks.delete(handle);
    },
    // Hidden-window pacing never fires here: the bench window is on screen.
    setTimeout: () => 0,
    clearTimeout: () => undefined,
  };
  return {
    host,
    paint() {
      const due = callbacks;
      callbacks = new Map();
      for (const callback of due.values()) callback();
    },
  };
}

const ack = async () => ({ sessionId: "s", receipt: null });

function benchTransport(host: FlushHost) {
  const handlers = new Map<string, Handlers>();
  const rpc: ChatSessionRpc = {
    session: {
      snapshot: {
        query: async ({ sessionId }) => ({
          projection: projectionFor(sessionId),
          frames: [],
          throughSequence: 0,
        }),
      },
      history: { query: async () => ({ frames: [], before: null }) },
      projection: { query: async ({ sessionId }) => ({ projection: projectionFor(sessionId) }) },
      subscribe: {
        subscribe: (input, h) => {
          handlers.set(input.sessionId, h);
          h.onStarted();
          return { unsubscribe: () => handlers.delete(input.sessionId) };
        },
      },
      command: { mutate: ack },
      cancelQueued: { mutate: ack },
      editQueued: { mutate: ack },
      cancelInteraction: { mutate: ack },
      reconcile: { mutate: ack },
    },
  };
  const transport: ChatSessionTransport = {
    rpc,
    scheduler: racingFlushScheduler(host),
    newCommandId: () => crypto.randomUUID(),
    createSession: async () => ({ sessionId: "unused" }),
    attachSession: async () => {
      throw new Error("the bench never attaches");
    },
  };
  return { transport, handlers };
}

function overlay(sessionId: string, messageId: string, text: string): unknown {
  return {
    kind: "overlay",
    sessionId,
    throughSequence: 0,
    messageId,
    delta: {
      op: "reset",
      message: {
        id: messageId,
        role: "assistant",
        parts: [{ key: "t0", part: { type: "text", text } }],
      },
    },
  };
}

/**
 * The sidebar's resident-title scan, as `active-sessions.tsx` runs it: gated
 * on the sessions map's identity, then a walk of every resident slice.
 */
function sidebarTitleScan(projectIds: ReadonlySet<string>) {
  let previous: ChatSessionsState["sessions"] | null = null;
  return (state: ChatSessionsState) => {
    if (state.sessions === previous) return;
    previous = state.sessions;
    for (const [sessionId, slice] of Object.entries(state.sessions)) {
      if (!projectIds.has(sessionId)) continue;
      void slice.projection?.session.title;
    }
  };
}

/**
 * The state a selector sees, with its `sessions` map counting walks: each
 * enumeration of the map counts every slice in it. A keyed read (the visible
 * plane's `sessions[id]`) is not a walk and does not count.
 */
function countingWalks(state: ChatSessionsState, onWalk: (slices: number) => void) {
  const sessions = new Proxy(state.sessions, {
    ownKeys(target) {
      const keys = Reflect.ownKeys(target);
      onWalk(keys.length);
      return keys;
    },
  });
  return { ...state, sessions };
}

interface Reading {
  open: number;
  streaming: number;
  writesPerFrame: number;
  sliceVisitsPerFrame: number;
  msPerFrame: number;
}

async function measure(open: number, streaming: number, timed: boolean): Promise<Reading> {
  const { host, paint } = manualHost();
  const { transport, handlers } = benchTransport(host);
  const store = createChatSessionsStore(() => transport);
  const ids = Array.from({ length: open }, (_, index) => `s${index}`);
  for (const id of ids) store.getState().adoptChatSession(id, "p1");
  // Let every snapshot land and every stream subscribe.
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(handlers.size).toBe(open);

  let writes = 0;
  let visits = 0;
  const palette = paletteResidentTitlesSelector(false);
  // The owner's roster: the project listing names 5,034 Sessions, of which
  // the open chats are a few.
  const listing = new Set([...ids, ...Array.from({ length: ROSTER - open }, (_, i) => `r${i}`)]);
  const sidebar = sidebarTitleScan(listing);
  const visible = ids[0]!;
  // Every write in this run moves `sessions`, so the sidebar's identity gate
  // never holds and the fresh probe per write costs it nothing it would save.
  // The timed pass reads the real state; the counting pass reads a probe whose
  // own proxy cost would otherwise be in the clock.
  const unsubscribe = store.subscribe((state) => {
    writes += 1;
    const probe = timed
      ? state
      : countingWalks(state, (slices) => {
          visits += slices;
        });
    palette(probe);
    void selectSettleSignal(probe);
    sidebar(probe);
    void probe.sessions[visible];
  });

  const streamers = ids.slice(0, streaming);
  // On screen, so the residency sweep (which would let the other, idle chats'
  // clients go two seconds in) can never take a streamer mid-run. The run
  // prices the worst case: every open chat still resident.
  const releases = streamers.map((id) => store.getState().showChatSession(id, "p1"));
  let text = "";
  const started = performance.now();
  for (let frame = 0; frame < FRAMES; frame += 1) {
    for (let overlayIndex = 0; overlayIndex < OVERLAYS_PER_FRAME; overlayIndex += 1) {
      text += "token ";
      for (const id of streamers) {
        handlers
          .get(id)!
          .onData({ id: `o${frame}-${overlayIndex}`, data: overlay(id, `m-${id}`, text) });
      }
    }
    paint();
  }
  const elapsed = performance.now() - started;
  unsubscribe();
  for (const release of releases) release();
  for (const id of ids) store.getState().closeChatSession(id);
  return {
    open,
    streaming,
    writesPerFrame: writes / FRAMES,
    sliceVisitsPerFrame: visits / FRAMES,
    msPerFrame: elapsed / FRAMES,
  };
}

describe("multi-stream chat frame cost (VC-515)", () => {
  it("publishes one store write per frame and no per-open-chat selector work", async () => {
    const readings: Reading[] = [];
    for (const open of OPEN) {
      for (const streaming of STREAMING) {
        const counted = await measure(open, streaming, false);
        const timed = await measure(open, streaming, true);
        readings.push({ ...counted, msPerFrame: timed.msPerFrame });
      }
    }
    console.table(
      readings.map((reading) => ({
        open: reading.open,
        streaming: reading.streaming,
        "writes/frame": reading.writesPerFrame.toFixed(2),
        "slice visits/frame": reading.sliceVisitsPerFrame.toFixed(1),
        "ms/frame": reading.msPerFrame.toFixed(3),
      })),
    );
    for (const reading of readings) {
      // The gate: N streaming clients fold into the store as ONE write.
      expect(reading.writesPerFrame).toBe(1);
      // Only the sidebar's project-scoped scan walks the resident set — once
      // per frame, not once per streaming client. A closed palette and the
      // usage rail walk nothing.
      expect(reading.sliceVisitsPerFrame).toBe(reading.open);
    }
  });
});
