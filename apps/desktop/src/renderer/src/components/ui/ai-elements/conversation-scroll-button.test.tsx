// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { ConversationScrollButton } from "./conversation";

const state = vi.hoisted(() => ({
  isAtBottom: false,
  scrollRef: { current: null as HTMLDivElement | null },
  contentRef: { current: null as HTMLDivElement | null },
  scrollToBottom: vi.fn(),
}));
vi.mock("use-stick-to-bottom", () => ({
  useStickToBottomContext: () => state,
  StickToBottom: Object.assign(() => null, { Content: () => null }),
}));
let host: HTMLDivElement;
let scroller: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let top = 800;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  scroller = document.createElement("div");
  Object.defineProperties(scroller, {
    scrollHeight: { get: () => 1000 },
    clientHeight: { get: () => 200 },
    scrollTop: { get: () => top },
  });
  state.scrollRef.current = scroller;
  state.contentRef.current = document.createElement("div");
  state.isAtBottom = false;
  top = 800;
  state.scrollToBottom.mockClear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
it("hides at the physical bottom even before the follow-lock state catches up", async () => {
  await act(async () => root.render(<ConversationScrollButton />));
  expect(host.querySelector("button")).toBeNull();
});
it("appears only when detached, and goes away on reaching the latest line", async () => {
  top = 500;
  await act(async () => root.render(<ConversationScrollButton />));
  const button = host.querySelector<HTMLButtonElement>("button")!;
  expect(button.getAttribute("data-slot")).toBe("conversation-scroll-button");
  await act(async () => button.click());
  expect(state.scrollToBottom).toHaveBeenCalledOnce();
  top = 800;
  await act(async () => {
    scroller.dispatchEvent(new Event("scroll"));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
  expect(host.querySelector("button")).toBeNull();
});
