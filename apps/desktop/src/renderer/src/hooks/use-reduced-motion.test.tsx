// @vitest-environment jsdom
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { prefersReducedMotion, useReducedMotion } from "./use-reduced-motion";

function Probe() {
  return <span>{String(useReducedMotion())}</span>;
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.motion;
});

it("renders static content without requiring a window subscription", () => {
  expect(renderToStaticMarkup(<Probe />)).toContain("true");
});

it("observes both the system and the app preference, and detaches both listeners", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const query = { matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() };
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => query),
  );
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => root.render(<Probe />));
  expect(host.textContent).toBe("false");
  document.documentElement.dataset.motion = "off";
  await act(async () => {
    window.dispatchEvent(new Event("volli-motion-change"));
  });
  expect(host.textContent).toBe("true");
  expect(prefersReducedMotion()).toBe(true);
  document.documentElement.dataset.motion = "on";
  query.matches = true;
  await act(async () => {
    query.addEventListener.mock.calls[0][1]();
  });
  expect(host.textContent).toBe("true");
  await act(async () => root.unmount());
  expect(query.removeEventListener).toHaveBeenCalledWith("change", expect.any(Function));
});
