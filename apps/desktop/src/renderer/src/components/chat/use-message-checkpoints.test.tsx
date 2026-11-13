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

function Harness({ sessionId, start }: { sessionId: string; start: number }) {
  // A new array per render, as a streamed update hands the transcript.
  const mounted = ROWS.slice(start);
  notePinned = useCheckpointNavigation({
    sessionId,
    navigator,
    control,
    rows: ROWS,
    checkpoints: CHECKPOINTS,
    mounted,
    start,
    anchorAt,
  });
  return null;
}
const render = (sessionId: string, start: number) =>
  act(() => root.render(<Harness sessionId={sessionId} start={start} />));

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

    // The commit that mounts it: one search, and the message is not drawn.
    render("s1", 1);
    expect(searches).toHaveBeenCalledTimes(1);
    // Streamed commits after it search for nothing.
    render("s1", 1);
    render("s1", 1);
    expect(searches).toHaveBeenCalledTimes(1);
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
});
