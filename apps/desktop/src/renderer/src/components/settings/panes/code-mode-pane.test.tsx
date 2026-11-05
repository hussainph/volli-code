// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { CodeModeSettings } from "./code-mode-pane";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { DEFAULT_CODE_MODE_POLICY } from "@volli/shared";
const mocks = vi.hoisted(() => ({ read: vi.fn(), save: vi.fn(), error: vi.fn() }));
vi.mock("@renderer/lib/model-access-client", () => {
  const client = { codeModePolicy: mocks.read, setCodeModePolicy: mocks.save };
  return { useModelAccessClient: () => client };
});
vi.mock("@renderer/lib/toast", () => ({ toastError: mocks.error }));
let root: Root, host: HTMLDivElement;
const policy = {
  ...DEFAULT_CODE_MODE_POLICY,
  enabled: true,
  models: { "provider/a-very-long-model-identifier": "both" as const },
};
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  HTMLElement.prototype.scrollIntoView = vi.fn();
  mocks.read.mockResolvedValue(policy);
  mocks.save.mockImplementation(async (next) => next);
  mocks.error.mockClear();
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  await act(async () =>
    root.render(
      <TooltipProvider>
        <CodeModeSettings models={[]} providers={[]} pickable={[]} />
      </TooltipProvider>,
    ),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  mocks.save.mockReset();
  mocks.read.mockReset();
});
it("uses Default and Exceptions row groups without a collapsed or horizontally clipped table", () => {
  expect(host.textContent).toContain("Default");
  expect(host.textContent).toContain("Exceptions");
  expect(host.textContent).toContain("a-very-long-model-identifier");
  expect(host.querySelector("table")).toBeNull();
  expect(host.querySelector('[data-testid="code-mode-advanced"]')).toBeNull();
  expect(
    host.querySelector('[aria-label="Code Mode for a-very-long-model-identifier"]'),
  ).not.toBeNull();
});
it("offers all three default modes without an info icon or a switch", async () => {
  expect(host.querySelector('[role="switch"]')).toBeNull();
  expect(host.querySelector('[aria-label="Code Mode meanings and defaults"]')).toBeNull();
  const trigger = host.querySelector<HTMLElement>('[data-testid="code-mode-default"]')!;
  await act(async () =>
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })),
  );
  const options = [...document.querySelectorAll<HTMLElement>('[role="option"]')];
  expect(options.map((e) => e.textContent)).toEqual([
    "Direct tools",
    "Code and direct tools",
    "Code only",
  ]);
  await act(async () =>
    options[2].dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
  );
  expect(mocks.save).toHaveBeenLastCalledWith({ ...policy, enabled: true, defaultMode: "only" });
});
it("keeps empty Exceptions inline and silent around its add row", async () => {
  mocks.read.mockResolvedValueOnce(DEFAULT_CODE_MODE_POLICY);
  await act(async () =>
    root.render(
      <TooltipProvider>
        <CodeModeSettings key="empty" models={[]} providers={[]} pickable={[]} />
      </TooltipProvider>,
    ),
  );
  expect(host.textContent).toContain("Add model exception");
  expect(host.querySelector(".empty-state")).toBeNull();
  expect(host.textContent).not.toContain("No model exceptions");
});
it("rolls a failed requested save back to the accepted policy and surfaces the error", async () => {
  mocks.save.mockRejectedValueOnce(new Error("offline"));
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>(
        '[aria-label="Remove exception for a-very-long-model-identifier"]',
      )!
      .click(),
  );
  expect(mocks.error).toHaveBeenCalledWith(expect.stringContaining("offline"));
  expect(host.textContent).toContain("a-very-long-model-identifier");
});
