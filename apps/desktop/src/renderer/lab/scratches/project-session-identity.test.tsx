// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import ProjectSessionIdentityScratch from "./project-session-identity";

let host: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 0, 1, 9));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<ProjectSessionIdentityScratch />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("keeps a mounted caption's greeting stable across clock changes and cycling", async () => {
  vi.setSystemTime(new Date(2026, 0, 1, 15));
  const caption = [...host.querySelectorAll("label")]
    .find((label) => label.textContent?.startsWith("Caption"))
    ?.querySelector("select");
  if (!caption) throw new Error("Missing caption selector");
  await act(async () => {
    caption.value = "greeter";
    caption.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const greeting = host.querySelector<HTMLButtonElement>('[title="Lab: click to cycle greeters"]');
  if (!greeting) throw new Error("Missing greeting");
  expect(greeting.textContent).toBe("Morning. What are we building?");
  await act(async () => greeting.click());
  expect(greeting.textContent).toBe("Morning — where do you want to start?");
});
