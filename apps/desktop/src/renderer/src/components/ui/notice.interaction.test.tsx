// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { Notice } from "./notice";

const toastError = vi.hoisted(() => vi.fn());
vi.mock("@renderer/lib/toast", () => ({ toastError }));
let root: Root;
let host: HTMLDivElement;
const longError = "Unable to connect to the registry. ".repeat(30);

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // jsdom has no layout. Simulate a two-line viewport with overflowing content.
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(160);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(40);
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  toastError.mockClear();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function button(name: string) {
  return Array.from(host.querySelectorAll("button")).find((node) => node.textContent === name)!;
}

function Fixture() {
  const [dismissed, setDismissed] = useState(false);
  return dismissed ? null : <Notice title="Optional notice" onDismiss={() => setDismissed(true)} />;
}

describe("Notice controls", () => {
  it("retains explicit occurrence dismissal across navigation but shows a new occurrence", () => {
    act(() => root.render(<Notice title="Saved" dismissalKey="notice-test:save-1" />));
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="Dismiss notice"]')!.click());
    expect(host.textContent).toBe("");
    act(() => root.render(null));
    act(() => root.render(<Notice title="Saved" dismissalKey="notice-test:save-1" />));
    expect(host.textContent).toBe("");
    act(() => root.render(<Notice title="Saved" dismissalKey="notice-test:save-2" />));
    expect(host.textContent).toBe("Saved");
  });
  it("expands and collapses full long errors without putting controls in the live region", () => {
    act(() => root.render(<Notice tone="error" title="Read failed" detail={longError} announce />));
    const message = host.querySelector('[role="status"]')!;
    expect(message.className).toContain("line-clamp-2");
    expect(message.textContent).toContain(longError);
    expect(message.querySelector("button")).toBeNull();
    act(() => button("Show more").click());
    expect(message.className).not.toContain("line-clamp-2");
    expect(button("Show less").getAttribute("aria-expanded")).toBe("true");
    act(() => button("Show less").click());
    expect(message.className).toContain("line-clamp-2");
  });

  it("copies the complete message, and surfaces clipboard failures", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    act(() => root.render(<Notice tone="error" title="Read failed" detail={longError} />));
    await act(async () => button("Copy error").click());
    expect(writeText).toHaveBeenCalledWith(`Read failed\n${longError}`);
    expect(button("Copied")).toBeDefined();
    writeText.mockRejectedValue(new Error("denied"));
    await act(async () => button("Copied").click());
    expect(toastError).toHaveBeenCalledWith("Couldn't copy the notice");
  });

  it("only allows dismissal when the caller opts in, and lets the caller retain it", () => {
    act(() => root.render(<Notice title="Required notice" />));
    expect(host.querySelector('[aria-label="Dismiss notice"]')).toBeNull();
    act(() => root.render(<Fixture />));
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="Dismiss notice"]')!.click());
    expect(host.textContent).toBe("");
    act(() => root.render(<Fixture />));
    expect(host.textContent).toBe("");
  });
});
