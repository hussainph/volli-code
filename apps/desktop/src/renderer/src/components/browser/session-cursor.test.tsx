// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { sessionCursorGlideMs } from "@volli/shared";
import { SessionCursor } from "./session-cursor";

let container: HTMLDivElement;
let root: Root;
const props = { color: "#d07c00", name: "Audit checkout", x: 20, y: 20, present: true };
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("SessionCursor hold arrival", () => {
  it("pulses only while present and not handing off", () => {
    const pulse = () => container.querySelector(".session-cursor-live")?.getAttribute("data-live");
    act(() => root.render(<SessionCursor {...props} />));
    expect(pulse()).toBe("true");
    act(() => root.render(<SessionCursor {...props} handoff />));
    expect(pulse()).toBe("false");
    act(() => root.render(<SessionCursor {...props} present={false} />));
    expect(pulse()).toBe("false");
  });

  it("does not delay settlement or repeated host acknowledgements for the pulse", () => {
    const settled = vi.fn();
    act(() => root.render(<SessionCursor {...props} onSettled={settled} settleKey={1} />));
    act(() => vi.advanceTimersByTime(0));
    expect(settled).toHaveBeenCalledExactlyOnceWith({ x: 20, y: 20 });
    act(() => root.render(<SessionCursor {...props} x={220} onSettled={settled} settleKey={2} />));
    const glide = sessionCursorGlideMs(200, false);
    act(() => vi.advanceTimersByTime(glide - 1));
    expect(settled).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(1));
    expect(settled).toHaveBeenLastCalledWith({ x: 220, y: 20 });
    act(() => root.render(<SessionCursor {...props} x={220} onSettled={settled} settleKey={3} />));
    act(() => vi.advanceTimersByTime(0));
    expect(settled).toHaveBeenCalledTimes(3);
  });

  it("bounds the pulse and suppresses it for both reduced-motion contracts", () => {
    const css = readFileSync("src/renderer/src/components/browser/session-cursor.css", "utf8");
    expect(css).toContain("animation: session-cursor-live 200ms var(--ease-out) 3;");
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.session-cursor-live\[data-live="true"\] \{\s*animation: none;/,
    );
    expect(css).toContain(
      '.session-cursor[data-reduced-motion="true"] .session-cursor-live[data-live="true"] {\n  animation: none;',
    );
  });
});
