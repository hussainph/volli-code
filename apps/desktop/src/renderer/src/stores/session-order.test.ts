// @vitest-environment jsdom
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { SessionOrderMember } from "@volli/shared";

import {
  createSessionOrderStore,
  projectBandOrderKey,
  ticketRailOrderKey,
  useHeldSessionOrder,
  useSessionOrderStore,
} from "./session-order";

/** One question open, two working, two at rest — the shipped order a band starts in. */
const START: readonly SessionOrderMember[] = [
  { id: "a1", phase: "waiting" },
  { id: "a2", phase: "working" },
  { id: "a3", phase: "working" },
  { id: "a4", phase: "resting" },
  { id: "a5", phase: "resting" },
];

const ids = (members: readonly SessionOrderMember[]): readonly string[] =>
  members.map((member) => member.id);

function withPhase(
  members: readonly SessionOrderMember[],
  id: string,
  phase: SessionOrderMember["phase"],
): readonly SessionOrderMember[] {
  return members.map((member) => (member.id === id ? { id, phase } : member));
}

const BAND = projectBandOrderKey("p1");
const RAIL = ticketRailOrderKey("t1");

describe("surface keys", () => {
  it("keeps each surface in its own namespace", () => {
    // A ticket rail holds a SUBSET of its project band's membership, so the
    // two must never collide on one key (amendment A2) — and a ticket whose id
    // happens to read like a project's must not borrow its order.
    expect(projectBandOrderKey("p1")).toBe("project:p1");
    expect(ticketRailOrderKey("t1")).toBe("ticket:t1");
    expect(projectBandOrderKey("x")).not.toBe(ticketRailOrderKey("x"));
  });
});

describe("createSessionOrderStore", () => {
  it("commits the order a free band drew, and draws it back", () => {
    const store = createSessionOrderStore();

    store.getState().commit(BAND, START);

    expect(store.getState().held[BAND]).toEqual({
      order: ids(START),
      phases: { a1: "waiting", a2: "working", a3: "working", a4: "resting", a5: "resting" },
    });
    expect(store.getState().orderFor(BAND, START)).toEqual(ids(START));
  });

  it("writes nothing when a commit would change nothing a band has drawn", () => {
    const store = createSessionOrderStore();
    store.getState().commit(BAND, START);
    const committed = store.getState().held;

    store.getState().commit(BAND, START);

    // Same object, not merely an equal one: an idle band must not be a stream
    // of identical writes waking every subscriber.
    expect(store.getState().held).toBe(committed);
  });

  it("commits nothing while anything is held", () => {
    const store = createSessionOrderStore();
    store.getState().commit(BAND, START);
    const committed = store.getState().held[BAND];

    const release = store.getState().hold();
    store.getState().commit(BAND, withPhase(START, "a5", "working"));

    expect(store.getState().holds).toBe(1);
    expect(store.getState().held[BAND]).toBe(committed);
    release();
    expect(store.getState().holds).toBe(0);
  });

  it("counts two holds separately and releases each only once", () => {
    const store = createSessionOrderStore();

    const pointer = store.getState().hold();
    const peek = store.getState().hold();
    expect(store.getState().holds).toBe(2);

    pointer();
    pointer();
    expect(store.getState().holds).toBe(1);

    peek();
    peek();
    expect(store.getState().holds).toBe(0);
  });

  it("freezes what it drew while held, then lands every pending move in one step", () => {
    const store = createSessionOrderStore();
    store.getState().commit(BAND, START);

    const release = store.getState().hold();
    // A question is asked, a turn starts, and a Session joins — all while the
    // pointer is inside the band.
    const moved = [
      ...withPhase(withPhase(START, "a4", "waiting"), "a5", "working"),
      { id: "a6", phase: "resting" } as const,
    ];
    expect(store.getState().orderFor(BAND, moved)).toEqual([...ids(START), "a6"]);

    release();
    store.getState().commit(BAND, moved);

    expect(store.getState().orderFor(BAND, moved)).toEqual(["a4", "a1", "a5", "a6", "a2", "a3"]);
  });

  it("draws the target for a key that has never committed, even while held", () => {
    const store = createSessionOrderStore();
    store.getState().hold();

    expect(store.getState().orderFor(BAND, START)).toEqual(ids(START));
  });

  it("floats a new question to the very top and lands a new turn under it", () => {
    const store = createSessionOrderStore();
    store.getState().commit(BAND, START);

    const asked = withPhase(START, "a3", "waiting");
    store.getState().commit(BAND, asked);
    expect(store.getState().orderFor(BAND, asked)).toEqual(["a3", "a1", "a2", "a4", "a5"]);

    const started = withPhase(asked, "a5", "working");
    store.getState().commit(BAND, started);
    expect(store.getState().orderFor(BAND, started)).toEqual(["a3", "a1", "a5", "a2", "a4"]);
  });

  it("keeps two surfaces' orders independent", () => {
    const store = createSessionOrderStore();
    const railMembers = [START[2]!, START[3]!];

    store.getState().commit(BAND, START);
    store.getState().commit(RAIL, railMembers);
    store.getState().commit(RAIL, withPhase(railMembers, "a4", "waiting"));

    expect(store.getState().orderFor(BAND, START)).toEqual(ids(START));
    expect(store.getState().held[RAIL]?.order).toEqual(["a4", "a3"]);
  });
});

describe("useHeldSessionOrder", () => {
  const roots: Root[] = [];

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    useSessionOrderStore.setState({ held: {}, holds: 0 });
  });

  afterEach(() => {
    act(() => {
      for (const root of roots.splice(0)) root.unmount();
    });
    vi.unstubAllGlobals();
    useSessionOrderStore.setState({ held: {}, holds: 0 });
  });

  /** The smallest hook harness: a component that reads the hook into a ref. */
  function renderHook<T>(use: () => T): { current: T; rerender(): void } {
    const result = { current: undefined as T, rerender: (): void => {} };
    function Probe(): null {
      result.current = use();
      return null;
    }
    const root = createRoot(document.createElement("div"));
    roots.push(root);
    result.rerender = () => {
      act(() => root.render(React.createElement(Probe)));
    };
    result.rerender();
    return result;
  }

  it("commits on the build it drew, so a free band draws the committed order", () => {
    const result = renderHook(() => useHeldSessionOrder(BAND, START));

    expect(result.current).toEqual(ids(START));
    expect(useSessionOrderStore.getState().held[BAND]?.order).toEqual(ids(START));
  });

  it("keeps still while held and re-renders with the landed order on the last release", () => {
    let members: readonly SessionOrderMember[] = START;
    const result = renderHook(() => useHeldSessionOrder(BAND, members));
    expect(result.current).toEqual(ids(START));

    // A pointer in the sidebar and an open peek: two reasons to keep still.
    const taken: (() => void)[] = [];
    act(() => {
      taken.push(useSessionOrderStore.getState().hold());
      taken.push(useSessionOrderStore.getState().hold());
    });
    const pointer = taken[0]!;
    const peek = taken[1]!;

    // A question is asked while the pointer is inside: the band must not move.
    members = withPhase(START, "a4", "waiting");
    result.rerender();
    expect(result.current).toEqual(ids(START));

    // One hold released is not enough — the peek is still open.
    act(() => pointer());
    expect(result.current).toEqual(ids(START));

    // The last release re-renders every band and lands the move, with no
    // further build asked of the surface.
    act(() => peek());
    expect(result.current).toEqual(["a4", "a1", "a2", "a3", "a5"]);
  });
});
