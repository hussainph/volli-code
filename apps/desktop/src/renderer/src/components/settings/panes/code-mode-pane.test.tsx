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
it("keeps stored exceptions but disables editing when the default is switched off", async () => {
  await act(async () => host.querySelector<HTMLButtonElement>('[role="switch"]')!.click());
  expect(mocks.save).toHaveBeenLastCalledWith({ ...policy, enabled: false });
  expect(
    host.querySelector<HTMLButtonElement>(
      '[aria-label="Remove exception for a-very-long-model-identifier"]',
    )?.disabled,
  ).toBe(true);
  expect(host.textContent).toContain("Inactive while Code Mode is off");
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
