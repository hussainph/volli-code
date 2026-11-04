// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { WebAccessSettingsView } from "../../../../../ipc/contract";
import { WebSearchPane } from "./web-search-pane";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
const saved: WebAccessSettingsView = {
  provider: "off",
  keys: { brave: "absent", exa: "present" },
  searxngUrl: null,
  sealing: "sealed",
};
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
async function mount(
  get = vi.fn().mockResolvedValue({ ok: true, settings: saved }),
  setKey = vi.fn(),
) {
  vi.stubGlobal("api", { webAccess: { get, setKey } });
  await act(async () =>
    root.render(
      <TooltipProvider>
        <WebSearchPane />
      </TooltipProvider>,
    ),
  );
}
it("holds row geometry without offering unread credentials", async () => {
  await mount(vi.fn(() => new Promise(() => {})));
  expect(host.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
  expect(host.querySelector('input[type="radio"]')).toBeNull();
});
it("shows one provider table with credential readiness and no secret values", async () => {
  await mount();
  expect(host.querySelectorAll("tbody tr")).toHaveLength(3);
  expect(host.textContent).toContain("Needs key");
  expect(host.textContent).toContain("Configured");
  expect(host.querySelector('input[type="password"]')).toBeNull();
  expect(host.querySelector<HTMLInputElement>('[aria-label="Use Exa by default"]')?.disabled).toBe(
    false,
  );
  expect(
    host.querySelector<HTMLInputElement>('[aria-label="Use Brave by default"]')?.disabled,
  ).toBe(true);
});
it("saves a key only on explicit save and clears the editor after success", async () => {
  const setKey = vi.fn().mockResolvedValue({
    ok: true,
    settings: { ...saved, keys: { brave: "present", exa: "present" } },
  });
  await mount(undefined, setKey);
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="Edit Brave key"]')!.click(),
  );
  const field = document.querySelector<HTMLInputElement>('input[type="password"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      field,
      "new-key",
    );
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(setKey).not.toHaveBeenCalled();
  await act(async () =>
    [...document.querySelectorAll("button")].find((b) => b.textContent === "Save")!.click(),
  );
  expect(setKey).toHaveBeenCalledExactlyOnceWith("brave", "new-key");
  expect(document.querySelector('input[type="password"]')).toBeNull();
});
it("shows read failures with retry instead of an empty table", async () => {
  await mount(vi.fn().mockRejectedValue(new Error("Bridge unavailable")));
  expect(host.textContent).toContain("Bridge unavailable");
  expect(host.textContent).toContain("Try again");
  expect(host.querySelector("table")).toBeNull();
});
