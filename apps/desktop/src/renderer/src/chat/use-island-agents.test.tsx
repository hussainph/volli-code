// @vitest-environment jsdom
/**
 * The subagent feed (VC-269): which listing rows are this Session's children,
 * what each row says, the three verbs and the doors they call, and the
 * now-channel diff a push cache with no history has to reconstruct render by
 * render.
 *
 * Tested through the hook against the real project-sessions store and a lab
 * chat store, because the hook IS the seam: what it owes `useActivityIsland`
 * is a slice of the model and a slice of the verbs, and what it owes the
 * person is that a child's state moving becomes exactly one announcement.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ChatSessionRecord } from "@volli/shared";
import { EMPTY_TRANSCRIPT, type ChatSessionTransport } from "@volli/session-presentation";
import type { IslandFlash } from "@volli/session-presentation";
import { createChatSessionsStore } from "@renderer/stores/chat-sessions";
import {
  EMPTY_PROJECT_SESSION_ROWS,
  useProjectSessionsStore,
} from "@renderer/stores/project-sessions";
import { useIslandFlash } from "./use-island-flash";
import {
  islandAgentLabel,
  islandAgentState,
  subagentsOf,
  useIslandAgents,
  type IslandAgentsDeps,
  type IslandAgentsFeed,
} from "./use-island-agents";

vi.mock("@renderer/lib/toast", () => ({ toastError: vi.fn() }));
import { toastError } from "@renderer/lib/toast";

const SESSION = "s-parent";
const PROJECT = "p1";

function record(over: Partial<ChatSessionRecord> & { sessionId: string }): ChatSessionRecord {
  return {
    title: "Read the docs",
    projectId: PROJECT,
    // Ticketless on purpose: the provenance trap reads a ticketless parent's
    // children as person-started, and this feed must not care.
    ticketId: null,
    createdAt: 0,
    adapterId: "pi",
    live: true,
    activity: "working",
    waitingOn: null,
    outcome: null,
    lastActivityAt: 0,
    bornTicketless: true,
    role: "subagent",
    parentSessionId: SESSION,
    ...over,
  };
}

function listing(chat: readonly ChatSessionRecord[]): void {
  useProjectSessionsStore.setState({
    byProject: { [PROJECT]: { ...EMPTY_PROJECT_SESSION_ROWS, chat } },
  });
}

/** The project's Session listing not yet answered — the store holds no entry. */
function unlisted(): void {
  useProjectSessionsStore.setState({ byProject: {} });
}

function chatStore() {
  const store = createChatSessionsStore(() => ({}) as ChatSessionTransport);
  store.setState({
    sessions: {
      [SESSION]: {
        projection: null,
        transcript: EMPTY_TRANSCRIPT,
        lifecycle: "ready",
        sessionError: null,
        queue: [],
      },
    },
  });
  return store;
}

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(toastError).mockClear();
  listing([]);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
  vi.unstubAllGlobals();
});

/** Mounts the feed and reports its latest slice and every flash it pushed. */
async function mount(deps: IslandAgentsDeps = {}) {
  const store = deps.store ?? chatStore();
  const seen: { feed: IslandAgentsFeed; flash: IslandFlash | null }[] = [];
  const flashes: IslandFlash[] = [];
  function Probe() {
    const channel = useIslandFlash();
    const feed = useIslandAgents(SESSION, PROJECT, channel.push, { ...deps, store });
    seen.push({ feed, flash: channel.flash });
    if (channel.flash !== null && flashes.at(-1)?.id !== channel.flash.id) {
      flashes.push(channel.flash);
    }
    return null;
  }
  await act(async () => {
    root?.render(<Probe />);
  });
  return {
    latest: () => seen.at(-1)!,
    agents: () => seen.at(-1)!.feed.model.agents,
    flashes,
    store,
  };
}

describe("which rows are children", () => {
  it("projects this Session's subagents and never a sibling's", async () => {
    listing([
      record({ sessionId: "mine" }),
      record({ sessionId: "siblings", parentSessionId: "s-sibling" }),
      record({ sessionId: "orphan", parentSessionId: null, role: "project" }),
    ]);
    const probe = await mount();
    expect(probe.agents().map((one) => one.id)).toEqual(["mine"]);
  });

  // The provenance trap: `childSessionIds` reads a ticketless parent's
  // children as person-started. The record's own fields do not.
  it("shows a ticketless (Board) parent's child — the record fields, not provenance", async () => {
    useProjectSessionsStore.setState({
      byProject: {
        [PROJECT]: {
          ...EMPTY_PROJECT_SESSION_ROWS,
          chat: [record({ sessionId: "child", ticketId: null })],
          provenance: {},
        },
      },
    });
    const probe = await mount();
    expect(probe.agents().map((one) => one.id)).toEqual(["child"]);
    expect(subagentsOf(useProjectSessionsStore.getState().byProject[PROJECT], SESSION)).toHaveLength(
      1,
    );
  });

  it("excludes a session_start peer child by role", async () => {
    listing([
      record({ sessionId: "helper" }),
      record({ sessionId: "peer", role: "ticket", ticketId: "t1" }),
      record({ sessionId: "peer-project", role: "project" }),
    ]);
    const probe = await mount();
    expect(probe.agents().map((one) => one.id)).toEqual(["helper"]);
  });

  it("is empty with no listing and with no children", async () => {
    unlisted();
    const probe = await mount();
    expect(probe.agents()).toEqual([]);
    expect(subagentsOf(undefined, SESSION)).toEqual([]);
  });
});

describe("what a row says", () => {
  it("labels a row by the record's title alone, with one guard for whitespace", async () => {
    listing([
      record({ sessionId: "a", title: "Find the auth refresh" }),
      record({ sessionId: "b", title: "   " }),
    ]);
    const probe = await mount();
    expect(probe.agents().map((one) => one.label)).toEqual(["Find the auth refresh", "Subagent"]);
    expect(islandAgentLabel({ title: "  Padded  " })).toBe("Padded");
  });

  // One case per row of the state table.
  it("reads working from activity", () => {
    expect(islandAgentState({ activity: "working", outcome: null })).toBe("working");
  });
  it("folds waiting into working (v1 ruling — no interactive trip a person answers)", () => {
    expect(islandAgentState({ activity: "waiting", outcome: null })).toBe("working");
  });
  it("reads stopped from activity, whatever the turn's outcome", () => {
    expect(islandAgentState({ activity: "stopped", outcome: null })).toBe("stopped");
    expect(islandAgentState({ activity: "stopped", outcome: "completed" })).toBe("stopped");
    expect(islandAgentState({ activity: "stopped", outcome: "interrupted" })).toBe("stopped");
  });
  it("reads an idle row that completed as done", () => {
    expect(islandAgentState({ activity: "idle", outcome: "completed" })).toBe("done");
    expect(islandAgentState({ activity: "idle", outcome: null })).toBe("done");
  });
  it("reads an idle row that was interrupted or whose executor failed as failed", () => {
    expect(islandAgentState({ activity: "idle", outcome: "interrupted" })).toBe("failed");
    expect(islandAgentState({ activity: "idle", outcome: "failed" })).toBe("failed");
  });

  it("carries indeterminate progress, and promoted from the open tabs under any owner", async () => {
    listing([record({ sessionId: "a" }), record({ sessionId: "b" })]);
    const store = chatStore();
    store.setState({ openTabs: { "some-ticket": ["b"] } });
    const probe = await mount({ store });
    expect(probe.agents()).toEqual([
      { id: "a", label: "Read the docs", progress: 0, state: "working", promoted: false },
      { id: "b", label: "Read the docs", progress: 0, state: "working", promoted: true },
    ]);

    await act(async () => store.setState({ openTabs: { [PROJECT]: ["a"] } }));
    expect(probe.agents().map((one) => one.promoted)).toEqual([true, false]);
  });
});

describe("the verbs", () => {
  it("peek and promote call the doors the mount supplied, with the child id", async () => {
    listing([record({ sessionId: "a" })]);
    const peekSession = vi.fn();
    const openSession = vi.fn();
    const probe = await mount({ peekSession, openSession });

    probe.latest().feed.actions.peekAgent("a");
    expect(peekSession).toHaveBeenCalledWith("a");
    probe.latest().feed.actions.promoteAgent("a");
    expect(openSession).toHaveBeenCalledWith("a");
  });

  it("open nowhere when the mount supplied no door", async () => {
    listing([record({ sessionId: "a" })]);
    const probe = await mount();
    expect(() => {
      probe.latest().feed.actions.peekAgent("a");
      probe.latest().feed.actions.promoteAgent("a");
    }).not.toThrow();
  });

  it("stop asks main to stop the child by id — the person's door", async () => {
    listing([record({ sessionId: "a" })]);
    const stop = vi.fn(async () => ({ ok: true, interrupted: true, released: true, failures: [] }));
    vi.stubGlobal("api", { sessions: { stop } });
    const probe = await mount();

    probe.latest().feed.actions.stopAgent("a");
    await act(async () => {});
    expect(stop).toHaveBeenCalledWith({ sessionId: "a" });
    expect(toastError).not.toHaveBeenCalled();
    expect(probe.flashes).toEqual([]);
  });

  it("surfaces a refused stop as a toast and a flash, by the child's label at press time", async () => {
    listing([record({ sessionId: "a", title: "Runaway" })]);
    const stop = vi.fn(async () => ({ ok: false, error: "Unknown session." }));
    vi.stubGlobal("api", { sessions: { stop } });
    const probe = await mount();

    probe.latest().feed.actions.stopAgent("a");
    await act(async () => {});
    expect(toastError).toHaveBeenCalledWith("Could not stop subagent: Unknown session.");
    expect(probe.flashes.map((flash) => [flash.event, flash.payload])).toEqual([
      ["Stop refused", "Runaway"],
    ]);

    // A thrown bridge is the same refusal.
    stop.mockRejectedValueOnce(new Error("bridge down"));
    probe.latest().feed.actions.stopAgent("a");
    await act(async () => {});
    expect(toastError).toHaveBeenLastCalledWith("Could not stop subagent: bridge down");
  });

  it("reports the runtime acts a durable stop could not complete", async () => {
    listing([record({ sessionId: "a", title: "Runaway" })]);
    const stop = vi.fn(async () => ({
      ok: true,
      interrupted: true,
      released: false,
      failures: ["The executor did not release: gone."],
    }));
    vi.stubGlobal("api", { sessions: { stop } });
    const probe = await mount();

    probe.latest().feed.actions.stopAgent("a");
    await act(async () => {});
    expect(toastError).toHaveBeenCalledWith(
      "Stopped Runaway, but: The executor did not release: gone.",
    );
    expect(probe.flashes).toEqual([]);
  });
});

describe("the now channel", () => {
  it("announces nothing for the children that existed when the listing hydrated", async () => {
    unlisted();
    const probe = await mount();
    expect(probe.flashes).toEqual([]);

    await act(async () => listing([record({ sessionId: "a" }), record({ sessionId: "b" })]));
    expect(probe.agents()).toHaveLength(2);
    expect(probe.flashes).toEqual([]);
  });

  it("announces a child that appears after the baseline as delegated", async () => {
    listing([record({ sessionId: "a" })]);
    const probe = await mount();

    await act(async () =>
      listing([record({ sessionId: "a" }), record({ sessionId: "b", title: "Grep the tests" })]),
    );
    expect(probe.flashes).toHaveLength(1);
    expect(probe.flashes[0]).toMatchObject({ event: "Delegated", payload: "Grep the tests" });
  });

  it("announces each ended state once, as the child's own state moves", async () => {
    listing([
      record({ sessionId: "done", title: "Docs" }),
      record({ sessionId: "failed", title: "Tests" }),
      record({ sessionId: "stopped", title: "Lint" }),
    ]);
    const probe = await mount();

    await act(async () =>
      listing([
        record({ sessionId: "done", title: "Docs", activity: "idle", outcome: "completed" }),
        record({ sessionId: "failed", title: "Tests" }),
        record({ sessionId: "stopped", title: "Lint" }),
      ]),
    );
    expect(probe.flashes.at(-1)).toMatchObject({ event: "Done", payload: "Docs" });

    await act(async () =>
      listing([
        record({ sessionId: "done", title: "Docs", activity: "idle", outcome: "completed" }),
        record({ sessionId: "failed", title: "Tests", activity: "idle", outcome: "failed" }),
        record({ sessionId: "stopped", title: "Lint" }),
      ]),
    );
    await act(async () =>
      listing([
        record({ sessionId: "done", title: "Docs", activity: "idle", outcome: "completed" }),
        record({ sessionId: "failed", title: "Tests", activity: "idle", outcome: "failed" }),
        record({ sessionId: "stopped", title: "Lint", activity: "stopped", outcome: null }),
      ]),
    );
    expect(probe.flashes.map((flash) => [flash.event, flash.payload])).toEqual([
      ["Done", "Docs"],
      ["Failed", "Tests"],
      ["Stopped", "Lint"],
    ]);

    // A reading that moved nothing announces nothing; a child resuming work
    // is not an ending and says nothing either.
    await act(async () =>
      listing([
        record({ sessionId: "done", title: "Docs", activity: "working" }),
        record({ sessionId: "failed", title: "Tests", activity: "idle", outcome: "failed" }),
        record({ sessionId: "stopped", title: "Lint", activity: "stopped", outcome: null }),
      ]),
    );
    expect(probe.flashes).toHaveLength(3);
  });

  it("announces the last change when two children end in one reading — latest wins", async () => {
    listing([record({ sessionId: "a", title: "First" }), record({ sessionId: "b", title: "Second" })]);
    const probe = await mount();

    await act(async () =>
      listing([
        record({ sessionId: "a", title: "First", activity: "idle", outcome: "completed" }),
        record({ sessionId: "b", title: "Second", activity: "idle", outcome: "failed" }),
      ]),
    );
    expect(probe.latest().flash).toMatchObject({ event: "Failed", payload: "Second" });
  });
});
