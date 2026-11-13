// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { ModelAccessModel, ModelAccessProvider, ModelSelection } from "@volli/shared";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { ModelControl } from "./model-control";

const provider = (id: string, label: string) =>
  ({
    id,
    label,
    state: "available",
    accountLabel: null,
    billingSource: "unknown",
    recovery: null,
    signIn: [],
    hasStoredCredential: true,
  }) as ModelAccessProvider;
const model = (
  providerId: string,
  modelId: string,
  label: string,
  reasoningLevels: ModelAccessModel["reasoningLevels"],
) =>
  ({
    providerId,
    modelId,
    label,
    state: "available",
    reasoningLevels,
    acceptsImageInput: true,
  }) as ModelAccessModel;

const providers = [provider("anthropic", "Anthropic"), provider("openai", "OpenAI")];
const models = [
  model("anthropic", "claude-sonnet", "Claude Sonnet 4.5 (2025-09-29)", ["low", "medium", "high"]),
  model("openai", "gpt-5", "GPT-5", ["off"]),
];

let root: Root, host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  HTMLElement.prototype.scrollIntoView = vi.fn();
  HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
  HTMLElement.prototype.releasePointerCapture = vi.fn();
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

async function render(selection: ModelSelection | null, onChange = vi.fn(), inherit?: string) {
  await act(async () =>
    root.render(
      <TooltipProvider>
        <ModelControl
          models={models}
          providers={providers}
          selection={selection}
          inherit={inherit}
          disabled={false}
          onChange={onChange}
        />
      </TooltipProvider>,
    ),
  );
  return onChange;
}
const trigger = () => host.querySelector<HTMLButtonElement>('button[aria-label^="Model"]')!;
const options = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')];
async function search(text: string) {
  const input = document.querySelector<HTMLInputElement>('[role="combobox"][placeholder="Model"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("is a right-column popup on the model rung that names the whole model", async () => {
  await render({ providerId: "anthropic", modelId: "claude-sonnet", reasoningLevel: "high" });
  expect(host.querySelector('[data-slot="model-control"]')?.className).toContain("justify-end");
  expect(trigger().className).toContain("w-64");
  expect(trigger().textContent).toContain("Claude Sonnet 4.5 (2025-09-29)");
  expect(trigger().getAttribute("aria-label")).toBe(
    "Model: Claude Sonnet 4.5 (2025-09-29) · Anthropic",
  );
  // No composer pill and no composer container-query ladder.
  expect(host.querySelector('[data-testid="model-pill"]')).toBeNull();
  expect(host.querySelector("[data-composer-container]")).toBeNull();
});

it("offers inheritance first and reports it as no selection", async () => {
  const onChange = await render(
    { providerId: "openai", modelId: "gpt-5", reasoningLevel: "off" },
    vi.fn(),
    "Inherit from chat",
  );
  await act(async () => trigger().click());
  expect(options()[0]?.textContent).toContain("Inherit from chat");
  await act(async () => options()[0]!.click());
  expect(onChange).toHaveBeenCalledExactlyOnceWith(null);
});

it("searches by provider and keeps the nearest reasoning level the new model has", async () => {
  const onChange = await render(
    { providerId: "openai", modelId: "gpt-5", reasoningLevel: "off" },
    vi.fn(),
    "Inherit from chat",
  );
  await act(async () => trigger().click());
  await search("anthropic");
  expect(options()).toHaveLength(1);
  expect(options()[0]?.closest('[role="group"]')?.getAttribute("aria-label")).toBe("Anthropic");
  await act(async () => options()[0]!.click());
  expect(onChange).toHaveBeenCalledExactlyOnceWith({
    providerId: "anthropic",
    modelId: "claude-sonnet",
    reasoningLevel: "high",
  });
});

it("gives reasoning its own small select only where the model has levels to choose", async () => {
  await render({ providerId: "openai", modelId: "gpt-5", reasoningLevel: "off" });
  expect(host.querySelector('[aria-label^="Effort for"]')).toBeNull();
  await render({ providerId: "anthropic", modelId: "claude-sonnet", reasoningLevel: "medium" });
  const effort = host.querySelector<HTMLElement>(
    '[aria-label="Effort for Claude Sonnet 4.5 (2025-09-29)"]',
  );
  expect(effort?.className).toContain("w-28");
  expect(effort?.textContent).toContain("Medium");
});

it("names an unset choice without inventing a model", async () => {
  await render(null);
  expect(trigger().textContent).toContain("Choose a model");
  // Only the popup's own unfold mark; no provider artwork for no model.
  expect(trigger().querySelectorAll("svg")).toHaveLength(1);
});
