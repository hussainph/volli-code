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

  it("previews the message and its reply on focus, reading the reply only then", () => {
    const readReply = vi.fn((id: string) => (id === "b" ? "Answer b" : null));
    render(THREE, readReply);
    expect(readReply).not.toHaveBeenCalled();
    act(() => marks()[1]!.focus());
    act(() => vi.advanceTimersByTime(300));
    expect(card()?.textContent).toBe("Ask bAnswer b");
    expect(readReply).toHaveBeenCalledWith("b");
    expect(marks()[1]!.dataset["previewed"]).toBe("true");
  });

  it("shows the message alone when the agent has not written yet", () => {
    render(THREE);
    act(() => marks()[0]!.focus());
    act(() => vi.advanceTimersByTime(300));
    expect(card()?.querySelectorAll("p")).toHaveLength(1);
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
