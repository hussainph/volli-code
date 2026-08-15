import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { beginScopeRepaint, disarmScopeRepaint, shouldEaseScopeRepaint } from "./scope-transition";

/**
 * A stand-in for Chromium's view transition, with the engine's own sequencing
 * left in the test's hands.
 *
 * The renderer test project runs under vitest's default `node` environment, so
 * there is neither a document nor a `startViewTransition` to drive — and the two
 * facts worth pinning here are both about SEQUENCING rather than about pixels:
 * the swap happens inside the update callback (never before or after it, or it
 * would land in the captured old state), and a transition that is skipped or
 * superseded settles without leaving an unhandled rejection behind.
 *
 * `run()` is the engine's "next rendering opportunity"; `skip` reproduces what
 * `skipTransition` actually does, which is run the update callback if it has not
 * run yet and then settle. `ready` rejects on a skip exactly as the real one
 * does — that rejection is the whole reason the module handles it.
 */
function fakeViewTransitions() {
  const transitions: FakeTransition[] = [];
  const startViewTransition = vi.fn((update: () => void) => {
    // Chromium skips the transition already in flight the moment a new one
    // starts, synchronously, and running its update callback is part of that.
    transitions.at(-1)?.skipTransition();
    const transition = makeTransition(update);
    transitions.push(transition);
    return transition as unknown as ViewTransition;
  });
  // Chromium delivers a press during a transition to `<html>`, so the module
  // listens in the capture phase on the document; the stand-in keeps the whole
  // registration so a test can check the listener is taken off again.
  const listeners: { type: string; handler: () => void }[] = [];
  vi.stubGlobal("document", {
    startViewTransition,
    addEventListener: (type: string, handler: () => void) => void listeners.push({ type, handler }),
    removeEventListener: (type: string, handler: () => void) => {
      const at = listeners.findIndex((l) => l.type === type && l.handler === handler);
      if (at >= 0) listeners.splice(at, 1);
    },
  });
  return {
    startViewTransition,
    transitions,
    listeners,
    /** The transition started most recently, which is the only live one. */
    current: () => transitions.at(-1),
    /**
     * Every registered `pointerdown` handler fires, as a real press would.
     * Filtered into a fresh array first, because a handler may take itself off.
     */
    press: () => {
      for (const { handler } of listeners.filter((entry) => entry.type === "pointerdown")) {
        handler();
      }
    },
  };
}

interface FakeTransition {
  ready: Promise<void>;
  finished: Promise<void>;
  updateCallbackDone: Promise<void>;
  skipTransition: () => void;
  /** Runs the update callback as the engine would, one frame in. */
  run: () => void;
  /** Ends the animation normally, after {@link run}. */
  finish: () => void;
  skipped: boolean;
  ran: boolean;
}

function makeTransition(update: () => void): FakeTransition {
  let resolveReady!: () => void;
  let rejectReady!: (reason: Error) => void;
  let resolveFinished!: () => void;
  let rejectFinished!: (reason: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const finished = new Promise<void>((resolve, reject) => {
    resolveFinished = resolve;
    rejectFinished = reject;
  });
  let readyResolved = false;
  const transition: FakeTransition = {
    ready,
    finished,
    updateCallbackDone: Promise.resolve(),
    ran: false,
    skipped: false,
    run: () => {
      if (transition.ran) return;
      transition.ran = true;
      try {
        update();
      } catch (error) {
        rejectFinished(error as Error);
        rejectReady(error as Error);
        return;
      }
      // A skip runs the update too, but never gets to say the animation is
      // about to start — that is the branch below.
      if (transition.skipped) return;
      readyResolved = true;
      resolveReady();
    },
    finish: () => resolveFinished(),
    skipTransition: () => {
      if (transition.skipped) return;
      transition.skipped = true;
      transition.run();
      // The real one: `finished` fulfils, and `ready` REJECTS with an
      // AbortError unless the animation had already begun.
      if (!readyResolved) rejectReady(new Error("AbortError"));
      resolveFinished();
    },
  };
  return transition;
}

/**
 * Lets every already-settled promise callback run — and, one macrotask later,
 * lets Node decide which rejections went unhandled.
 */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * The module holds the live transition at module scope, so a test that leaves
 * one in flight would hand it to the next one. Disarming is exactly the reset:
 * it is what an HMR dispose does, and it ends whatever is running.
 */
afterEach(() => {
  disarmScopeRepaint();
  vi.unstubAllGlobals();
});

describe("shouldEaseScopeRepaint", () => {
  it("eases a switch from one project to another", () => {
    expect(shouldEaseScopeRepaint({ hydrated: true, from: "p1", to: "p2" })).toBe(true);
  });

  it("eases a switch from the global scope into a project", () => {
    expect(shouldEaseScopeRepaint({ hydrated: true, from: null, to: "p1" })).toBe(true);
  });

  it("eases a project's theme being dropped back to the global scope", () => {
    expect(shouldEaseScopeRepaint({ hydrated: true, from: "p1", to: null })).toBe(true);
  });

  it("cuts straight to the new canvas within one scope", () => {
    // Dragging a stop, committing an edit, ending a preview: every one of
    // these is a direct answer to a click, where instant IS the feedback.
    expect(shouldEaseScopeRepaint({ hydrated: true, from: "p1", to: "p1" })).toBe(false);
    expect(shouldEaseScopeRepaint({ hydrated: true, from: null, to: null })).toBe(false);
  });

  it("eases a light↔dark flip inside one scope", () => {
    // The case the projectId-only trigger missed entirely while dark was
    // pinned: same project, same canvas, every surface inverted. It reaches
    // here from a mode pick, from a workspace whose override differs coming
    // into scope, and from the system flipping under `auto`.
    expect(
      shouldEaseScopeRepaint({
        hydrated: true,
        from: "p1",
        to: "p1",
        fromAppearance: "dark",
        toAppearance: "light",
      }),
    ).toBe(true);
    expect(
      shouldEaseScopeRepaint({
        hydrated: true,
        from: null,
        to: null,
        fromAppearance: "light",
        toAppearance: "dark",
      }),
    ).toBe(true);
  });

  it("cuts when the mode is unchanged, however the canvas moved", () => {
    expect(
      shouldEaseScopeRepaint({
        hydrated: true,
        from: "p1",
        to: "p1",
        fromAppearance: "dark",
        toAppearance: "dark",
      }),
    ).toBe(false);
  });

  it("never eases the first paint, mode flip or not", () => {
    // A boot that resolves to light has no dark frame to come from — the mode
    // class was stamped by preload before the document painted at all.
    expect(
      shouldEaseScopeRepaint({
        hydrated: false,
        from: null,
        to: null,
        fromAppearance: "dark",
        toAppearance: "light",
      }),
    ).toBe(false);
  });

  it("never eases the first paint", () => {
    // There is no previous look to come from — easing here would make boot
    // look like a slow fade-in of an app that had already rendered.
    expect(shouldEaseScopeRepaint({ hydrated: false, from: null, to: "p1" })).toBe(false);
  });
});

describe("beginScopeRepaint without the View Transition API", () => {
  it("applies the swap synchronously where there is no document at all", () => {
    // The renderer's own tests, and any host without a DOM: the module must
    // still be the thing that performs the swap, not merely the thing that
    // eases it.
    const applyTokens = vi.fn();

    beginScopeRepaint(applyTokens);

    expect(applyTokens).toHaveBeenCalledTimes(1);
  });

  it("hard-cuts on an engine that has a document but no startViewTransition", () => {
    vi.stubGlobal("document", { documentElement: {} });
    const applyTokens = vi.fn();

    beginScopeRepaint(applyTokens);

    expect(applyTokens).toHaveBeenCalledTimes(1);
  });
});

describe("beginScopeRepaint as a view transition", () => {
  it("hands the swap to the engine instead of performing it", () => {
    // The contract that makes the crossfade possible at all: the tokens move
    // INSIDE the update callback. Applied before this call, they would be part
    // of the captured old state and animate from themselves to themselves.
    const engine = fakeViewTransitions();
    const applyTokens = vi.fn();

    beginScopeRepaint(applyTokens);

    expect(engine.startViewTransition).toHaveBeenCalledTimes(1);
    expect(applyTokens).not.toHaveBeenCalled();

    engine.current()?.run();
    expect(applyTokens).toHaveBeenCalledTimes(1);
  });

  it("leaves a superseded transition's rejection handled", async () => {
    // Two workspace hops inside one crossfade — the owner's actual usage.
    // Chromium abandons the first transition, which REJECTS its `ready` with an
    // AbortError; unhandled, the app's most repeated interaction would print a
    // rejection every time it worked correctly.
    const engine = fakeViewTransitions();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);

    beginScopeRepaint(vi.fn());
    beginScopeRepaint(vi.fn());
    await flush();
    process.off("unhandledRejection", unhandled);

    expect(engine.transitions).toHaveLength(2);
    expect(engine.transitions[0]?.skipped).toBe(true);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it("ends the crossfade on the first pointer press", () => {
    // While the transition plays, Chromium hit-tests its own pseudo-element
    // tree and every click in the window is DROPPED rather than delayed
    // (measured: +0/+100/+200ms into a 300ms swap all lost, +320ms delivered).
    // Ending on the first press turns "up to 300ms of dead window" into one
    // lost click — and input outranking decoration is right anyway.
    const engine = fakeViewTransitions();

    beginScopeRepaint(vi.fn());
    expect(engine.current()?.skipped).toBe(false);
    engine.press();

    expect(engine.current()?.skipped).toBe(true);
  });

  it("stops listening for presses once the transition is over", async () => {
    // A listener per swap, never removed, is a leak on the app's most repeated
    // interaction — and every stale one would skip a transition it has no
    // relationship to.
    const engine = fakeViewTransitions();

    beginScopeRepaint(vi.fn());
    const transition = engine.current();
    transition?.run();
    transition?.finish();
    await flush();

    expect(engine.listeners).toEqual([]);
  });

  it("still applies the swap when its transition is abandoned mid-flight", () => {
    // Skipping drops the ANIMATION, never the update: the window must end up
    // wearing the new scope either way, hard cut and all.
    const engine = fakeViewTransitions();
    const first = vi.fn();
    const second = vi.fn();

    beginScopeRepaint(first);
    beginScopeRepaint(second);
    engine.current()?.run();

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe("disarmScopeRepaint", () => {
  it("does nothing when no repaint is in flight", () => {
    expect(() => disarmScopeRepaint()).not.toThrow();
  });

  it("skips a running transition and applies its swap anyway", () => {
    // The HMR teardown this exists for: a module edit landing mid-crossfade.
    // The animation goes; the tokens stay, because a half-applied theme is not
    // a state the app has any way to leave.
    const engine = fakeViewTransitions();
    const applyTokens = vi.fn();

    beginScopeRepaint(applyTokens);
    disarmScopeRepaint();

    expect(engine.current()?.skipped).toBe(true);
    expect(applyTokens).toHaveBeenCalledTimes(1);
  });

  it("has nothing left to skip once the transition has finished", async () => {
    const engine = fakeViewTransitions();

    beginScopeRepaint(vi.fn());
    const transition = engine.current();
    transition?.run();
    transition?.finish();
    await flush();
    disarmScopeRepaint();

    // Skipped exactly zero times: the reference was released when it settled,
    // so nothing reached the engine after it was already done.
    expect(transition?.skipped).toBe(false);
  });

  it("keeps skipping the LIVE transition after an older one settles late", async () => {
    // A superseded transition settles after its successor started. Clearing the
    // module's reference on that settle would leave the live crossfade with
    // nothing able to end it — a stuck window under HMR.
    const engine = fakeViewTransitions();

    beginScopeRepaint(vi.fn());
    beginScopeRepaint(vi.fn());
    await flush();
    disarmScopeRepaint();

    expect(engine.transitions[1]?.skipped).toBe(true);
  });
});
