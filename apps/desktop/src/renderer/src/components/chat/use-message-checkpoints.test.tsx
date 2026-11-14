// @vitest-environment jsdom
import type { WorkTranscriptRow } from "@volli/session-presentation";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ConversationControl } from "@renderer/components/ui/ai-elements/conversation";
import { createCheckpointNavigator, type CheckpointNavigator } from "./checkpoint-navigator";
import { messageCheckpoints } from "./message-checkpoints";
import { useCheckpointNavigation } from "./use-message-checkpoints";

const asked = (index: number): WorkTranscriptRow => ({
  kind: "turn",
  messages: [{ id: `u${index}`, role: "user", parts: [{ type: "text", text: `Ask ${index}` }] }],
});
const ROWS = Array.from({ length: 10 }, (_, index) => asked(index));
const CHECKPOINTS = messageCheckpoints(ROWS);

let container: HTMLDivElement;
let root: Root;
let scroller: HTMLDivElement;
let navigator: CheckpointNavigator;
let control: ConversationControl;
let notePinned: (pinned: boolean) => void = () => {};
const anchorAt = vi.fn();

function Harness({
  sessionId,
  start,
  held = null,
}: {
  sessionId: string;
  start: number;
  held?: { start: number; end: number } | null;
}) {
  // A new array per render, as a streamed update hands the transcript.
  const mounted =
    held === null ? ROWS.slice(start) : [...ROWS.slice(start, held.start), ...ROWS.slice(held.end)];
  notePinned = useCheckpointNavigation({
    sessionId,
    navigator,
    control,
    rows: ROWS,
    checkpoints: CHECKPOINTS,
    mounted,
    start,
    held,
    anchorAt,
  });
  return null;
}
const render = (
  sessionId: string,
  start: number,
  held: { start: number; end: number } | null = null,
) => act(() => root.render(<Harness sessionId={sessionId} start={start} held={held} />));

/** A drawn message whose viewport position the test sets. */
function drawn(id: string, top: () => number): HTMLElement {
  const node = document.createElement("div");
  node.dataset["messageCheckpoint"] = id;
  node.getBoundingClientRect = () => ({ top: top() }) as DOMRect;
  scroller.append(node);
  return node;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  scroller = document.createElement("div");
  document.body.append(scroller);
  scroller.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
  root = createRoot(container);
  navigator = createCheckpointNavigator();
  control = { stopFollowing: vi.fn(), scroller: () => scroller };
  anchorAt.mockReset();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  scroller.remove();
  vi.unstubAllGlobals();
});

describe("useCheckpointNavigation", () => {
  it("anchors the window on a message above it, then stops looking after one attempt", () => {
    render("s1", 5);
    const searches = vi.spyOn(scroller, "querySelectorAll");
    act(() => navigator.jump("u1"));
    expect(anchorAt).toHaveBeenCalledWith("u1");
    expect(control.stopFollowing).toHaveBeenCalled();

    // The commit that mounts it: the landing's one search (the message is not
    // drawn), and the observer's, for a new set of mounted messages.
    render("s1", 1);
    expect(searches).toHaveBeenCalledTimes(2);
    // Streamed commits after it search for nothing.
    render("s1", 1);
    render("s1", 1);
    expect(searches).toHaveBeenCalledTimes(2);
  });

  it("anchors the window on a message a far jump is still filling in (VC-1226)", () => {
    // Rows 3-7 held back below a landing at 1: u5 is inside the window's range
    // but not drawn, so it is reached by moving the anchor, not by scrolling.
    render("s1", 1, { start: 3, end: 8 });
    act(() => navigator.jump("u5"));
    expect(anchorAt).toHaveBeenCalledWith("u5");
    // Below the hold the rows are mounted, and the jump just lands.
    anchorAt.mockReset();
    drawn("u9", () => 120);
    act(() => navigator.jump("u9"));
    expect(anchorAt).not.toHaveBeenCalled();
    expect(navigator.current()).toBe("u9");
  });

  it("drops a pending jump when the plane switches Session in place", () => {
    render("s1", 5);
    const searches = vi.spyOn(scroller, "querySelectorAll");
    act(() => navigator.jump("u1"));
    render("s2", 5);
    render("s2", 5);
    expect(searches).not.toHaveBeenCalled();
  });

  it("lands a mounted message at once and lights its mark", () => {
    drawn("u7", () => 300);
    render("s1", 0);
    act(() => navigator.jump("u7"));
    expect(anchorAt).not.toHaveBeenCalled();
    expect(control.stopFollowing).toHaveBeenCalled();
    expect(navigator.current()).toBe("u7");
  });

  it("holds the jumped-to mark while a page lands above it, and lets go when the reader moves it", () => {
    let top = 0;
    drawn("u7", () => top);
    render("s1", 0);
    act(() => navigator.jump("u7"));
    expect(navigator.current()).toBe("u7");

    // A page mounted above: the offset changes, the message stays where it was.
    scroller.scrollTop = 4000;
    act(() => notePinned(false));
    expect(navigator.current()).toBe("u7");

    // The reader scrolls: the message moves, and the observer's answer rules again.
    top = -500;
    act(() => notePinned(false));
    expect(navigator.current()).toBe("u0");
  });

  it("forgets the hold when the plane switches Session in place", () => {
    drawn("u7", () => 0);
    render("s1", 0);
    act(() => navigator.jump("u7"));
    render("s2", 0);
    act(() => notePinned(true));
    expect(navigator.current()).toBe("u9");
  });

  describe("with an IntersectionObserver", () => {
    /** Observers the hook built, each reporting when the test says. */
    const observers: { targets: Element[]; report(ids: readonly string[]): void }[] = [];
    beforeEach(() => {
      observers.length = 0;
      vi.stubGlobal(
        "IntersectionObserver",
        class {
          targets: Element[] = [];
          constructor(callback: IntersectionObserverCallback) {
            const targets = this.targets;
            observers.push({
              targets,
              report: (ids) =>
                callback(
                  targets.map(
                    (target) =>
                      ({
                        target,
                        isIntersecting: ids.includes(
                          (target as HTMLElement).dataset["messageCheckpoint"]!,
                        ),
                      }) as IntersectionObserverEntry,
                  ),
                  {} as IntersectionObserver,
                ),
            });
          }
          observe(target: Element) {
            this.targets.push(target);
          }
          disconnect() {}
        },
      );
    });

    it("keeps the last answer while a rebuilt observer has not reported yet", () => {
      for (const index of [3, 5, 7]) drawn(`u${index}`, () => 0);
      render("s1", 0);
      act(() => notePinned(false));
      act(() => observers[0]!.report(["u3", "u5"]));
      expect(navigator.current()).toBe("u5");

      // A page leaves the window: a new observer, no report yet. An empty
      // answer here would light u1, the message above the new window.
      render("s1", 2);
      expect(observers).toHaveLength(2);
      expect(navigator.current()).toBe("u5");

      act(() => observers[1]!.report(["u3"]));
      expect(navigator.current()).toBe("u3");
    });

    it("drops the last answer at once when the window holds no message to observe", () => {
      for (const index of [3, 5]) drawn(`u${index}`, () => 0);
      render("s1", 0);
      act(() => notePinned(false));
      act(() => observers[0]!.report(["u3", "u5"]));
      expect(navigator.current()).toBe("u5");

      // A window holding only agent rows: nothing is observed, nothing will report.
      scroller.replaceChildren();
      render("s1", 10);
      expect(observers).toHaveLength(1);
      expect(navigator.current()).toBe("u9");
    });
  });
});
