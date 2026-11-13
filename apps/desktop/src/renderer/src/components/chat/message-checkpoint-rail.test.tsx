// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { createCheckpointNavigator, type CheckpointNavigator } from "./checkpoint-navigator";
import { MessageCheckpointRail } from "./message-checkpoint-rail";
import { holdCheckpoints, type MessageCheckpoint } from "./message-checkpoints";

const checkpoint = (id: string, prompt = `Ask ${id}`): MessageCheckpoint => ({
  id,
  prompt,
  label: prompt,
});
const noReply = () => null;
const THREE = [checkpoint("a"), checkpoint("b"), checkpoint("c")];

let container: HTMLDivElement;
let root: Root;
let navigator: CheckpointNavigator;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  navigator = createCheckpointNavigator();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function render(
  checkpoints: readonly MessageCheckpoint[],
  readReply: (id: string) => string | null = () => null,
) {
  act(() =>
    root.render(
      <MessageCheckpointRail
        checkpoints={checkpoints}
        navigator={navigator}
        readReply={readReply}
      />,
    ),
  );
}
const marks = () => [...container.querySelectorAll<HTMLButtonElement>("[data-checkpoint-mark]")];
const card = () => document.querySelector("[data-checkpoint-card]");
const press = (key: string) =>
  act(() => {
    document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });

const over = (target: Element) =>
  act(() => {
    target.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" }));
  });
const out = (target: Element, to: Element) =>
  act(() => {
    target.dispatchEvent(
      new PointerEvent("pointerout", {
        bubbles: true,
        pointerType: "mouse",
        relatedTarget: to,
      }),
    );
  });

describe("MessageCheckpointRail", () => {
  it("draws nothing for an empty chat or a single message", () => {
    render([]);
    expect(container.querySelector("nav")).toBeNull();
    render([checkpoint("only")]);
    expect(container.querySelector("nav")).toBeNull();
  });

  it("is a labelled navigation list, one mark per message, named by the message", () => {
    render(THREE);
    const nav = container.querySelector("nav");
    expect(nav?.getAttribute("aria-label")).toBe("Messages");
    expect(nav?.querySelectorAll("ol > li")).toHaveLength(3);
    expect(marks().map((mark) => mark.getAttribute("aria-label"))).toEqual([
      "Ask a",
      "Ask b",
      "Ask c",
    ]);
  });

  it("marks the reader's position from the navigator, with one tab stop on it", () => {
    render(THREE);
    // Before the transcript says, the latest is the way in.
    expect(marks().map((mark) => mark.tabIndex)).toEqual([-1, -1, 0]);
    act(() => navigator.publish("b"));
    expect(marks().map((mark) => mark.getAttribute("aria-current"))).toEqual([
      null,
      "location",
      null,
    ]);
    expect(marks().map((mark) => mark.tabIndex)).toEqual([-1, 0, -1]);
  });

  it("jumps to the message a mark is pressed for", () => {
    const jump = vi.fn();
    navigator.attach(jump);
    render(THREE);
    act(() => marks()[0]!.click());
    expect(jump).toHaveBeenCalledWith("a");
  });

  it("moves between marks with the arrow keys, Home and End", () => {
    render(THREE);
    act(() => marks()[0]!.focus());
    press("ArrowDown");
    expect(document.activeElement).toBe(marks()[1]);
    press("End");
    expect(document.activeElement).toBe(marks()[2]);
    press("ArrowDown");
    expect(document.activeElement).toBe(marks()[2]);
    press("Home");
    expect(document.activeElement).toBe(marks()[0]);
    press("ArrowUp");
    expect(document.activeElement).toBe(marks()[0]);
    // The tab stop follows focus, so Tab returns to the last mark visited.
    expect(marks().map((mark) => mark.tabIndex)).toEqual([0, -1, -1]);
  });

  it("previews the message and its reply on focus, at once, reading the reply only then", () => {
    const readReply = vi.fn((id: string) => (id === "b" ? "Answer b" : null));
    render(THREE, readReply);
    expect(readReply).not.toHaveBeenCalled();
    act(() => marks()[1]!.focus());
    expect(card()?.textContent).toBe("Ask bAnswer b");
    expect(readReply).toHaveBeenCalledWith("b");
    expect(marks()[1]!.dataset["previewed"]).toBe("true");
    // The reply is the mark's description, so it is heard as well as seen.
    const described = marks()[1]!.getAttribute("aria-describedby");
    expect(described && document.getElementById(described)?.textContent).toBe("Answer b");
  });

  it("waits before a first card under the pointer, then swaps cards at once", () => {
    render(THREE);
    const [first, second] = [marks()[0]!, marks()[1]!];
    over(first);
    expect(card()).toBeNull();
    act(() => vi.advanceTimersByTime(200));
    expect(card()?.textContent).toBe("Ask a");
    out(first, second);
    over(second);
    act(() => vi.advanceTimersByTime(0));
    expect(card()?.textContent).toBe("Ask b");
  });

  it("shows the message alone, undescribed, when the agent has not written yet", () => {
    render(THREE);
    act(() => marks()[0]!.focus());
    expect(card()?.querySelectorAll("p")).toHaveLength(1);
    expect(marks()[0]!.hasAttribute("aria-describedby")).toBe(false);
  });

  it("closes the card when its mark is chosen", () => {
    const jump = vi.fn();
    navigator.attach(jump);
    render(THREE);
    act(() => marks()[2]!.focus());
    expect(card()).not.toBeNull();
    act(() => marks()[2]!.click());
    expect(jump).toHaveBeenCalledWith("c");
    expect(card()).toBeNull();
    // The hover card's own open timer, queued by the focus, must not reopen it.
    act(() => vi.advanceTimersByTime(500));
    expect(card()).toBeNull();
    // Leaving the mark and coming back previews it again.
    act(() => marks()[2]!.blur());
    act(() => marks()[2]!.focus());
    expect(card()).not.toBeNull();
  });

  it("closes the card when the rail loses its box (the pane narrowed)", () => {
    render(THREE);
    act(() => marks()[1]!.focus());
    expect(card()).not.toBeNull();
    // jsdom lays nothing out, so every list here has no height: exactly what
    // a pane narrowing past the container query leaves behind.
    act(() => {
      container.querySelector("ol")!.dispatchEvent(new Event("scroll"));
      vi.advanceTimersByTime(50);
    });
    expect(card()).toBeNull();
  });

  it("lifts its band below a header in the plane's corner", () => {
    act(() =>
      root.render(
        <MessageCheckpointRail
          checkpoints={THREE}
          navigator={navigator}
          readReply={noReply}
          belowHeader
        />,
      ),
    );
    expect(container.querySelector("nav")?.hasAttribute("data-below-header")).toBe(true);
  });

  it("does not render again for a held list that says the same thing", () => {
    // The rail reads its store on every render it does, and only then.
    const reads = vi.spyOn(navigator, "current");
    render(THREE, noReply);
    const before = reads.mock.calls.length;
    expect(before).toBeGreaterThan(0);
    // A streamed token: the plane re-derives the list and holds it.
    const held = holdCheckpoints(THREE, [checkpoint("a"), checkpoint("b"), checkpoint("c")]);
    expect(held).toBe(THREE);
    render(held, noReply);
    expect(reads.mock.calls.length).toBe(before);
    // A new message is a new list, and the rail draws it.
    render(holdCheckpoints(THREE, [...THREE, checkpoint("d")]), noReply);
    expect(reads.mock.calls.length).toBeGreaterThan(before);
    expect(marks()).toHaveLength(4);
  });
});
