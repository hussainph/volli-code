// @vitest-environment jsdom
/**
 * Where each cloud Session runs (VC-895): what the listing feeds in, which
 * Sessions witness each Place to `runners.places`, and what a Session's
 * label and pending line read from it.
 */
import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { LOCAL_LAUNCH, THIS_MAC_RUNNER_OFF, type ThisMacRunnerSnapshot } from "@volli/shared";
import { RUNNER_PLACES_MAX_SESSIONS, type RunnerPlace } from "@volli/shared/cloud";

import { fakeCloud } from "@renderer/stores/cloud-board/fake-cloud.test-support";
import { adoptLaunch } from "@renderer/stores/launch";

import type { CloudSession } from "./cloud-client";
import {
  availabilityDotState,
  bindCloudPlaces,
  forgetProjectPlaces,
  noteProjectPlaces,
  openSessionPlace,
  placeOf,
  readPending,
  readPlaces,
  sinceLabel,
  useCloudPlacesStore,
  useOpenSessionPlace,
  useSessionPendingLine,
  witnessBatches,
  type ThisMacStream,
} from "./cloud-places";

const PLACES = "runners:places";

const place = (patch: Partial<RunnerPlace> = {}): RunnerPlace => ({
  id: "r1",
  name: "hp-mac",
  kind: "mac",
  status: "asleep",
  statusChangedAt: 0,
  statusReason: null,
  owned: true,
  ...patch,
});

const reset = () =>
  useCloudPlacesStore.setState({
    byProject: {},
    sessions: {},
    runners: {},
    thisRunnerId: null,
    opened: {},
    openedPlaces: {},
  });

afterEach(() => {
  reset();
  vi.restoreAllMocks();
});

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

describe("the listing's Places", () => {
  it("keeps each project's Sessions, flattened, and forgets a project", () => {
    noteProjectPlaces("p1", [{ id: "s1", placeRunnerId: "r1", turnActive: true }]);
    noteProjectPlaces("p2", [{ id: "s2", placeRunnerId: "r2", turnActive: false }]);
    expect(useCloudPlacesStore.getState().sessions).toEqual({
      s1: { placeRunnerId: "r1", turnActive: true },
      s2: { placeRunnerId: "r2", turnActive: false },
    });
    noteProjectPlaces("p1", []);
    expect(Object.keys(useCloudPlacesStore.getState().sessions)).toEqual(["s2"]);
    forgetProjectPlaces("p2");
    expect(useCloudPlacesStore.getState().sessions).toEqual({});
    const before = useCloudPlacesStore.getState();
    forgetProjectPlaces("unknown");
    expect(useCloudPlacesStore.getState()).toBe(before);
  });

  it("names one witness Session per Place, in bounded reads", () => {
    expect(
      witnessBatches({
        b: { placeRunnerId: "r1", turnActive: false },
        a: { placeRunnerId: "r1", turnActive: false },
        c: { placeRunnerId: "r2", turnActive: false },
      }),
    ).toEqual([["a", "c"]]);
    const many = Object.fromEntries(
      Array.from({ length: RUNNER_PLACES_MAX_SESSIONS + 1 }, (_, index) => [
        `s${String(index).padStart(3, "0")}`,
        { placeRunnerId: `r${index}`, turnActive: false },
      ]),
    );
    expect(witnessBatches(many).map((batch) => batch.length)).toEqual([
      RUNNER_PLACES_MAX_SESSIONS,
      1,
    ]);
    expect(witnessBatches({})).toEqual([]);
  });

  it("reads only well-formed answers", () => {
    expect(readPlaces("nope")).toEqual([]);
    expect(
      readPlaces([
        { sessionId: "s1", place: place() },
        { sessionId: "s2", place: null },
        { sessionId: "s3", place: { ...place(), owned: "yes" } },
        { sessionId: "s4", place: { ...place(), statusReason: 3 } },
        null,
        { sessionId: "s5", place: place({ id: "r2", statusReason: "removed" }) },
      ]),
    ).toEqual([
      { sessionId: "s1", place: place() },
      { sessionId: "s2", place: null },
      { sessionId: "s3", place: null },
      { sessionId: "s4", place: null },
      { sessionId: "s5", place: place({ id: "r2", statusReason: "removed" }) },
    ]);
    expect(readPlaces([{ place: place() }, { sessionId: "s6" }])).toEqual([
      { sessionId: "s6", place: null },
    ]);
  });

  it("adds every drawn Session no listing holds as its own witness", () => {
    expect(
      witnessBatches({ a: { placeRunnerId: "r1", turnActive: false } }, ["z", "a", "m"]),
    ).toEqual([["a", "m", "z"]]);
  });

  it("counts each surface that opens a Session, and forgets it with the last", () => {
    const first = openSessionPlace("s1");
    const second = openSessionPlace("s1");
    expect(useCloudPlacesStore.getState().opened).toEqual({ s1: 2 });
    useCloudPlacesStore.setState({
      openedPlaces: { s1: { placeRunnerId: "r1", turnActive: false } },
    });
    first();
    first();
    expect(useCloudPlacesStore.getState().opened).toEqual({ s1: 1 });
    second();
    expect(useCloudPlacesStore.getState().opened).toEqual({});
    expect(useCloudPlacesStore.getState().openedPlaces).toEqual({});
  });
});

const dot = (kind: string, reason: Parameters<typeof availabilityDotState>[0]["reason"]) =>
  availabilityDotState({ kind, reason });

describe("availabilityDotState", () => {
  it("draws serving as ready, removed as an error, and waiting by its reason", () => {
    expect(dot("serving", null)).toBe("ready");
    expect(dot("here", null)).toBe("ready");
    expect(dot("online", null)).toBe("ready");
    expect(dot("removed", "cut_off")).toBe("error");
    expect(dot("waiting", "asleep")).toBe("parked");
    expect(dot("waiting", "closed")).toBe("exited");
    expect(dot("waiting", "updating")).toBe("starting");
    expect(dot("waiting", "needs_update")).toBe("error");
    expect(dot("waiting", "offline")).toBe("idle");
    expect(dot("waiting", "unknown")).toBe("idle");
  });
});

const bodyOf = (text: string) =>
  JSON.stringify({ message: { id: "m", role: "user", parts: [{ type: "text", text }] } });

describe("a Session's queued commands", () => {
  it("reads the backend's list: what waits, its words oldest first, and what ended undone", () => {
    expect(
      readPending({
        commands: [
          {
            commandId: "c5",
            kind: "message.submit",
            status: "failed",
            body: bodyOf("lost"),
            failure: { code: "command_refused", detail: "The Session refused this command." },
          },
          { commandId: "c4", kind: "executor.interrupt", status: "cancelled", failure: null },
          {
            commandId: "c6",
            kind: "message.submit",
            status: "expired",
            body: bodyOf("too late"),
            failure: { code: "expired", detail: "", retryable: false, attempt: 3 },
          },
          { commandId: "c3", kind: "message.submit", status: "done", body: bodyOf("third") },
          { commandId: "c2", kind: "executor.interrupt", status: "queued", body: null },
          { commandId: "c1", kind: "message.submit", status: "leased", body: bodyOf(" first ") },
          { commandId: "c0", kind: "message.submit", status: "queued", body: null },
          { commandId: "cx", kind: "message.submit", status: "queued", body: "{" },
          { commandId: "cy", kind: "message.submit", status: "queued", body: "{}" },
          {
            commandId: "cz",
            kind: "message.submit",
            body: JSON.stringify({ message: { parts: [{ type: "file" }, null] } }),
          },
          { status: "failed", failure: { code: "x" } },
          { commandId: "cw", kind: "session.retitle", status: "failed", failure: { code: "gone" } },
          null,
        ],
      }),
    ).toEqual({
      count: 8,
      messages: [
        { commandId: "c1", text: "first" },
        { commandId: "c3", text: "third" },
      ],
      failures: [
        { commandId: "cw", text: null, reason: "gone" },
        { commandId: "c6", text: "too late", reason: "expired" },
        { commandId: "c4", text: null, reason: "cancelled" },
        { commandId: "c5", text: "lost", reason: "The Session refused this command." },
      ],
      answered: true,
    });
    expect(readPending({ commands: [{ commandId: "f", status: "failed" }] }).failures).toEqual([
      { commandId: "f", text: null, reason: "failed" },
    ]);
    expect(readPending("nope")).toEqual({ count: 0, messages: [], failures: [], answered: true });
    expect(readPending(null).count).toBe(0);
    expect(readPending({ commands: "x" }).messages).toEqual([]);
  });

  it("says Sent — waiting, with the waiting words, while the runner is away; from the live query", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    adoptLaunch({ store: "cloud", userId: "u", backendUrl: "https://example.convex.cloud" });
    const fake = fakeCloud();
    let follower: ((session: CloudSession | null) => void) | null = null;
    const follow = (listener: (session: CloudSession | null) => void) => {
      follower = listener;
      listener(fake.session);
      return () => {
        follower = null;
      };
    };
    const seen: ReturnType<typeof useSessionPendingLine>[] = [];
    function Probe({ sessionId }: { sessionId: string | null }) {
      seen.push(useSessionPendingLine(sessionId, follow));
      return null;
    }
    noteProjectPlaces("p", [{ id: "s1", placeRunnerId: "r1", turnActive: false }]);
    useCloudPlacesStore.setState({ runners: { r1: place() } });
    const root = createRoot(document.createElement("div"));
    const name = "sessionMessages:pending";
    const args = { sessionId: "s1" };
    const one = { commands: [{ commandId: "c1", kind: "message.submit", body: bodyOf("hi") }] };
    try {
      await act(async () => root.render(React.createElement(Probe, { sessionId: "s1" })));
      expect(fake.watchers(name, args)).toBe(1);
      expect(seen.at(-1)).toEqual({ label: null, messages: [], failures: [], answered: false });
      await act(async () => fake.answer(name, args, one));
      expect(seen.at(-1)).toEqual({
        label: "Sent — waiting for hp-mac",
        messages: [{ commandId: "c1", text: "hi" }],
        failures: [],
        answered: true,
      });
      // The runner is back: the command is on its way, nothing to say.
      await act(async () =>
        useCloudPlacesStore.setState({ runners: { r1: place({ status: "online" }) } }),
      );
      expect(seen.at(-1)).toMatchObject({ label: null, messages: [] });
      await act(async () => useCloudPlacesStore.setState({ runners: { r1: place() } }));
      expect(seen.at(-1)?.label).toBe("Sent — waiting for hp-mac");
      // Answered by the runner: the backend stops listing it.
      await act(async () => fake.answer(name, args, { commands: [] }));
      expect(seen.at(-1)?.label).toBeNull();
      // A failed read says nothing rather than something wrong.
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      await act(async () => fake.answer(name, args, one));
      await act(async () => fake.fail(name, args, new Error("offline")));
      expect(seen.at(-1)?.label).toBeNull();
      expect(warn).toHaveBeenCalled();
      // Disconnected: nothing watched; back, watched again.
      await act(async () => follower!(null));
      expect(fake.watchers(name, args)).toBe(0);
      await act(async () => follower!(fake.session));
      expect(fake.watchers(name, args)).toBe(1);
      await act(async () => root.render(React.createElement(Probe, { sessionId: null })));
      expect(fake.watchers(name, args)).toBe(0);
      expect(seen.at(-1)?.label).toBeNull();
    } finally {
      await act(async () => root.unmount());
      adoptLaunch(LOCAL_LAUNCH);
      vi.unstubAllGlobals();
    }
  });

  it("watches nothing in a local launch", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const follow = vi.fn(() => () => {});
    function Probe() {
      useSessionPendingLine("s1", follow);
      return null;
    }
    const root = createRoot(document.createElement("div"));
    try {
      await act(async () => root.render(React.createElement(Probe)));
      expect(follow).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      vi.unstubAllGlobals();
    }
  });
});

describe("placeOf", () => {
  it("answers only once the Session and its runner are both known", () => {
    expect(placeOf(useCloudPlacesStore.getState(), null, 0)).toBeNull();
    expect(placeOf(useCloudPlacesStore.getState(), "s1", 0)).toBeNull();
    noteProjectPlaces("p", [{ id: "s1", placeRunnerId: "r1", turnActive: true }]);
    expect(placeOf(useCloudPlacesStore.getState(), "s1", 0)).toBeNull();
    useCloudPlacesStore.setState({ runners: { r1: place() } });
    expect(placeOf(useCloudPlacesStore.getState(), "s1", 0)?.label).toBe(
      "Paused — hp-mac is asleep",
    );
    useCloudPlacesStore.setState({ thisRunnerId: "r1" });
    expect(placeOf(useCloudPlacesStore.getState(), "s1", 0)?.kind).toBe("here");
  });

  it("reads since in the person's locale", () => {
    const at = new Date(2026, 9, 24, 14, 2).getTime();
    expect(sinceLabel(at, new Date(2026, 9, 24, 18, 0).getTime())).toBe(
      new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }),
    );
    expect(sinceLabel(at, new Date(2026, 9, 25, 9, 0).getTime())).toBe(
      new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
    );
  });
});

/** A bound follower over a fake client, with the follow it was handed. */
function bound(thisMac: ThisMacStream | null = null) {
  const fake = fakeCloud();
  let follower: ((session: CloudSession | null) => void) | null = null;
  const stopFollowing = vi.fn();
  const warn = vi.fn();
  const stop = bindCloudPlaces({
    follow: (listener) => {
      follower = listener;
      return stopFollowing;
    },
    thisMac,
    warn,
  });
  return {
    fake,
    follow: (session: CloudSession | null) => follower!(session),
    stop,
    stopFollowing,
    warn,
  };
}

/** A surface that draws one Session. */
function OpenProbe({ sessionId }: { sessionId: string | null }) {
  useOpenSessionPlace(sessionId);
  return null;
}

describe("bindCloudPlaces", () => {
  it("watches the witnesses' Places while connected, and forgets everything when unbound", async () => {
    const { fake, follow, stop, stopFollowing, warn } = bound();
    noteProjectPlaces("p", [
      { id: "s1", placeRunnerId: "r1", turnActive: false },
      { id: "s2", placeRunnerId: "r1", turnActive: false },
    ]);
    follow(fake.session);
    const args = { sessionIds: ["s1"] };
    expect(fake.watchers(PLACES, args)).toBe(1);
    await settle();
    expect(useCloudPlacesStore.getState().runners).toEqual({});
    fake.answer(PLACES, args, [{ sessionId: "s1", place: place() }]);
    expect(useCloudPlacesStore.getState().runners).toEqual({ r1: place() });
    // A malformed answer, or a failed read, leaves no label it can no longer vouch for.
    fake.answer(PLACES, args, "nonsense");
    expect(useCloudPlacesStore.getState().runners).toEqual({});
    fake.answer(PLACES, args, [{ sessionId: "s1", place: place() }]);
    fake.fail(PLACES, args, new Error("offline"));
    expect(warn).toHaveBeenCalled();
    expect(useCloudPlacesStore.getState().runners).toEqual({});

    // A Session on a new Place adds a witness; the same witnesses keep their watch.
    noteProjectPlaces("p", [
      { id: "s1", placeRunnerId: "r1", turnActive: false },
      { id: "s3", placeRunnerId: "r2", turnActive: true },
    ]);
    expect(fake.watchers(PLACES, args)).toBe(0);
    expect(fake.watchers(PLACES, { sessionIds: ["s1", "s3"] })).toBe(1);
    noteProjectPlaces("p", [
      { id: "s1", placeRunnerId: "r1", turnActive: true },
      { id: "s3", placeRunnerId: "r2", turnActive: true },
    ]);
    expect(fake.watchers(PLACES, { sessionIds: ["s1", "s3"] })).toBe(1);

    // Disconnected: no watches, and no stale runners.
    follow(null);
    expect(fake.watchers(PLACES, { sessionIds: ["s1", "s3"] })).toBe(0);
    expect(useCloudPlacesStore.getState().runners).toEqual({});
    follow(fake.session);
    expect(fake.watchers(PLACES, { sessionIds: ["s1", "s3"] })).toBe(1);

    stop();
    expect(stopFollowing).toHaveBeenCalled();
    expect(fake.watchers(PLACES, { sessionIds: ["s1", "s3"] })).toBe(0);
    expect(useCloudPlacesStore.getState().sessions).toEqual({});
  });

  it("forgets a runner the moment the backend stops vouching for it (visibility lost)", async () => {
    const { fake, follow, stop } = bound();
    noteProjectPlaces("p", [
      { id: "s1", placeRunnerId: "r1", turnActive: false },
      { id: "s2", placeRunnerId: "r2", turnActive: false },
    ]);
    follow(fake.session);
    const args = { sessionIds: ["s1", "s2"] };
    await settle();
    fake.answer(PLACES, args, [
      { sessionId: "s1", place: place() },
      { sessionId: "s2", place: place({ id: "r2", name: "box", owned: false }) },
    ]);
    expect(Object.keys(useCloudPlacesStore.getState().runners).toSorted()).toEqual(["r1", "r2"]);
    // s2 went private (or was deleted, or the viewer left its Workspace): the
    // backend answers null for it, and its runner's label goes with it.
    fake.answer(PLACES, args, [
      { sessionId: "s1", place: place() },
      { sessionId: "s2", place: null },
    ]);
    expect(useCloudPlacesStore.getState().runners).toEqual({ r1: place() });
    expect(placeOf(useCloudPlacesStore.getState(), "s2", 0)).toBeNull();

    // A witness whose Session moved to another runner replaces the old one.
    fake.answer(PLACES, args, [
      { sessionId: "s1", place: place({ id: "r9", name: "hp-mac-new" }) },
      { sessionId: "s2", place: null },
    ]);
    expect(Object.keys(useCloudPlacesStore.getState().runners)).toEqual(["r9"]);
    fake.answer(PLACES, args, [{ sessionId: "s1", place: place() }]);
    expect(Object.keys(useCloudPlacesStore.getState().runners)).toEqual(["r1"]);

    // A Session leaving the listing takes its runner's label with it at once,
    // before any new answer.
    noteProjectPlaces("p", [{ id: "s2", placeRunnerId: "r2", turnActive: false }]);
    expect(useCloudPlacesStore.getState().runners).toEqual({});
    stop();
  });

  it("paints nothing from a read queued for a batch that is gone", async () => {
    // The client already holds an answer, so each new watch queues a read of it.
    const { fake, follow, stop } = bound();
    noteProjectPlaces("p", [{ id: "s1", placeRunnerId: "r1", turnActive: false }]);
    fake.answer(PLACES, { sessionIds: ["s1"] }, [{ sessionId: "s1", place: place() }]);
    // The account's client closes before the queued read runs.
    follow(fake.session);
    follow(null);
    await settle();
    expect(useCloudPlacesStore.getState().runners).toEqual({});
    // A rebuilt batch's queued read is the one that paints.
    follow(fake.session);
    noteProjectPlaces("p", [{ id: "s2", placeRunnerId: "r2", turnActive: false }]);
    await settle();
    expect(useCloudPlacesStore.getState().runners).toEqual({});
    noteProjectPlaces("p", [{ id: "s1", placeRunnerId: "r1", turnActive: false }]);
    await settle();
    expect(useCloudPlacesStore.getState().runners).toEqual({ r1: place() });
    // Unbound before the read runs: nothing comes back.
    noteProjectPlaces("p", [{ id: "s3", placeRunnerId: "r1", turnActive: false }]);
    noteProjectPlaces("p", [{ id: "s1", placeRunnerId: "r1", turnActive: false }]);
    stop();
    await settle();
    expect(useCloudPlacesStore.getState().runners).toEqual({});
  });

  it("follows a drawn Session no listing holds, by itself, until the last surface lets go", async () => {
    const { fake, follow, stop } = bound();
    noteProjectPlaces("p", [{ id: "s1", placeRunnerId: "r1", turnActive: false }]);
    follow(fake.session);
    await settle();
    // A Session opened from a link or a notification, outside every listing.
    const header = openSessionPlace("s9");
    const composer = openSessionPlace("s9");
    const args = { sessionIds: ["s1", "s9"] };
    expect(fake.watchers(PLACES, args)).toBe(1);
    expect(placeOf(useCloudPlacesStore.getState(), "s9", 0)).toBeNull();
    fake.answer(PLACES, args, [
      { sessionId: "s1", place: place() },
      { sessionId: "s9", place: place({ id: "r9", name: "box", kind: "linux", owned: false }) },
    ]);
    // Its turn is not known here, so it reads as waiting rather than paused.
    expect(placeOf(useCloudPlacesStore.getState(), "s9", 0)?.label).toBe(
      "Waiting for box — asleep since " + sinceLabel(0, 0),
    );
    // Shared with nobody any more: the backend stops vouching, and the label goes.
    fake.answer(PLACES, args, [
      { sessionId: "s1", place: place() },
      { sessionId: "s9", place: null },
    ]);
    expect(placeOf(useCloudPlacesStore.getState(), "s9", 0)).toBeNull();
    expect(Object.keys(useCloudPlacesStore.getState().runners)).toEqual(["r1"]);
    fake.answer(PLACES, args, [
      { sessionId: "s1", place: place() },
      { sessionId: "s9", place: place({ id: "r9", name: "box" }) },
    ]);
    expect(placeOf(useCloudPlacesStore.getState(), "s9", 0)).not.toBeNull();

    // Listed after all: the listing's row answers for it (its live turn too),
    // and it now witnesses its runner as a listed Session; the read is the same.
    noteProjectPlaces("p", [
      { id: "s1", placeRunnerId: "r1", turnActive: false },
      { id: "s9", placeRunnerId: "r9", turnActive: true },
    ]);
    expect(fake.watchers(PLACES, args)).toBe(1);
    expect(placeOf(useCloudPlacesStore.getState(), "s9", 0)?.label).toBe("Paused — box is asleep");
    noteProjectPlaces("p", [{ id: "s1", placeRunnerId: "r1", turnActive: false }]);
    expect(fake.watchers(PLACES, args)).toBe(1);
    expect(placeOf(useCloudPlacesStore.getState(), "s9", 0)?.label).toContain("Waiting for box");

    // The last surface lets go: forgotten, and its runner with it.
    header();
    expect(useCloudPlacesStore.getState().opened).toEqual({ s9: 1 });
    composer();
    expect(useCloudPlacesStore.getState().opened).toEqual({});
    expect(useCloudPlacesStore.getState().openedPlaces).toEqual({});
    expect(Object.keys(useCloudPlacesStore.getState().runners)).toEqual(["r1"]);
    expect(fake.watchers(PLACES, { sessionIds: ["s1"] })).toBe(1);
    stop();
  });

  it("opens the Session a surface draws while it is mounted, in a cloud launch only", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const root = createRoot(document.createElement("div"));
    try {
      await act(async () => root.render(React.createElement(OpenProbe, { sessionId: "s1" })));
      expect(useCloudPlacesStore.getState().opened).toEqual({});
      adoptLaunch({ store: "cloud", userId: "u", backendUrl: "https://example.convex.cloud" });
      await act(async () => root.render(React.createElement(OpenProbe, { sessionId: "s2" })));
      expect(useCloudPlacesStore.getState().opened).toEqual({ s2: 1 });
      await act(async () => root.render(React.createElement(OpenProbe, { sessionId: null })));
      expect(useCloudPlacesStore.getState().opened).toEqual({});
      await act(async () => root.render(React.createElement(OpenProbe, { sessionId: "s3" })));
      await act(async () => root.unmount());
      expect(useCloudPlacesStore.getState().opened).toEqual({});
    } finally {
      adoptLaunch(LOCAL_LAUNCH);
      vi.unstubAllGlobals();
    }
  });

  it("learns this Mac's runner from main's stream", () => {
    let handlers: Parameters<ThisMacStream["subscribe"]>[1] | null = null;
    const unsubscribe = vi.fn();
    const { stop, warn } = bound({
      subscribe: (_input, next) => {
        handlers = next;
        return { unsubscribe };
      },
    });
    const online: ThisMacRunnerSnapshot = {
      ...THIS_MAC_RUNNER_OFF,
      state: "online",
      runnerId: "r1",
    };
    handlers!.onData(online);
    expect(useCloudPlacesStore.getState().thisRunnerId).toBe("r1");
    handlers!.onError(new Error("gone"));
    expect(warn).toHaveBeenCalled();
    stop();
    expect(unsubscribe).toHaveBeenCalled();
    expect(useCloudPlacesStore.getState().thisRunnerId).toBeNull();
  });
});
