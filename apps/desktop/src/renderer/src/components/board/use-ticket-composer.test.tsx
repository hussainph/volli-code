// @vitest-environment jsdom
/**
 * The add-card composer's keys while an IME is composing (VC-806). Chromium
 * on macOS delivers the Enter that accepts a candidate, and the Escape that
 * closes the candidate window, as ordinary `keydown`s with `isComposing` set.
 * Those keystrokes are the IME's: taking Enter created a ticket from the
 * half-converted word (and a second one when the IME committed into the
 * emptied field), and taking Escape closed the composer and dropped the title.
 *
 * Mounted on a real input and driven by real DOM events, because the guard
 * reads `nativeEvent` — a hand-built synthetic object would only test itself.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { useBoardStore } from "@renderer/stores/board";

import { useTicketComposer } from "./use-ticket-composer";

let root: Root;
let host: HTMLDivElement;
let composer: ReturnType<typeof useTicketComposer> | null = null;
const onClose = vi.fn();

function Probe() {
  composer = useTicketComposer({ projectId: "p1", status: "todo", initiallyOpen: true, onClose });
  if (!composer.open) return null;
  return (
    <input
      ref={composer.inputRef}
      value={composer.title}
      onChange={(event) => composer!.setTitle(event.target.value)}
      onKeyDown={composer.handleKeyDown}
    />
  );
}

function press(key: "Enter" | "Escape", composing: boolean): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    isComposing: composing,
    keyCode: composing ? 229 : key === "Enter" ? 13 : 27,
  });
  act(() => {
    host.querySelector("input")!.dispatchEvent(event);
  });
  return event;
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // jsdom lays nothing out; the composer scrolls itself into view on open.
  HTMLElement.prototype.scrollIntoView = () => undefined;
  onClose.mockClear();
  useBoardStore.setState({ ticketsByProject: { p1: [] } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<Probe />));
  act(() => composer!.setTitle("テスト"));
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  composer = null;
  delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("leaves a composing Enter to the IME: no ticket, the title kept", () => {
  const addTicket = vi.spyOn(useBoardStore.getState(), "addTicket").mockResolvedValue(null);

  const event = press("Enter", true);

  expect(addTicket).not.toHaveBeenCalled();
  expect(event.defaultPrevented).toBe(false);
  expect(composer!.title).toBe("テスト");
  expect(composer!.open).toBe(true);
});

it("leaves a composing Escape to the IME: the composer stays open with its title", () => {
  press("Escape", true);

  expect(composer!.open).toBe(true);
  expect(composer!.title).toBe("テスト");
  expect(onClose).not.toHaveBeenCalled();
});

it("still submits on a plain Enter and closes on a plain Escape", () => {
  const addTicket = vi.spyOn(useBoardStore.getState(), "addTicket").mockResolvedValue(null);

  const enter = press("Enter", false);
  expect(addTicket).toHaveBeenCalledExactlyOnceWith("p1", "todo", "テスト");
  expect(enter.defaultPrevented).toBe(true);
  expect(composer!.title).toBe("");
  expect(composer!.open).toBe(true);

  press("Escape", false);
  expect(composer!.open).toBe(false);
  expect(onClose).toHaveBeenCalledOnce();
});
