// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { act, useState, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Automation } from "@volli/shared";
import { ComposerFooter, CreateRunAutomationItems } from "./composer-footer";
import type { ComposerLaunch } from "./composer-launch";

function automation(id: string, name: string): Automation {
  return {
    id,
    name,
    projectId: "p1",
    instructions: "Run the work",
    trigger: { kind: "none" },
    runtime: null,
    createdAt: 1,
    updatedAt: 1,
  };
}
const GROUPS = [
  {
    status: "todo" as const,
    label: "Todo",
    current: true,
    automations: [automation("a1", "Triage")],
  },
  {
    status: "doing" as const,
    label: "Doing",
    current: false,
    automations: [automation("a2", "Implement")],
  },
];
const props: ComponentProps<typeof ComposerFooter> = {
  projectId: "p1",
  run: { models: [], tiers: [], selection: null, setSelection: () => {} },
  launch: { kind: "kickoff" },
  onLaunchChange: () => {},
  onCreate: () => {},
  onSubmit: () => {},
  automationOffer: { ready: true, groups: GROUPS, enabledIds: [] },
  disabled: false,
};
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
function render(overrides: Partial<typeof props> = {}): string {
  return renderToStaticMarkup(<ComposerFooter {...props} {...overrides} />);
}
async function openMenu() {
  const trigger = host.querySelector('[data-testid="composer-launch-picker"]')!;
  await act(async () =>
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })),
  );
}
function radio(text: string): HTMLElement {
  return [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((el) =>
    el.textContent?.includes(text),
  )!;
}

describe("one attachment affordance", () => {
  it("offers one system file picker, never a duplicate file-reference picker", () => {
    const html = render({ onAttachFiles: () => {} });
    expect(html.match(/aria-label="Attach files"/g)).toHaveLength(1);
    expect(html.match(/type="file"/g)).toHaveLength(1);
    expect(html).toContain("multiple");
    expect(html).not.toContain("Attach file reference");
    expect(html).not.toContain("Search files…");
  });
  it("omits the paperclip when attachments are unsupported", () => {
    expect(render()).not.toContain('aria-label="Attach files"');
  });
});

it("offers both commits as buttons at rest, with no create-more switch", () => {
  const html = render();
  expect(html).toContain('data-testid="composer-kickoff"');
  // Plain creation is a press, not a mode hidden behind the caret.
  expect(html).toContain('data-testid="composer-create"');
  expect(html).toContain('aria-label="Create ticket"');
  expect(html).toContain('aria-label="Choose what starts"');
  expect(html).not.toContain('aria-label="Create more"');
  expect(html).not.toContain('aria-label="Create and run an automation"');
});

it("gives the unmodified chord to Create and the shifted one to the primary", () => {
  const html = render();
  expect(html).toMatch(
    /data-testid="composer-create"[^>]*aria-keyshortcuts="Meta\+Enter Control\+Enter"/,
  );
  expect(html).toMatch(
    /data-testid="composer-kickoff"[^>]*aria-keyshortcuts="Shift\+Meta\+Enter Shift\+Control\+Enter"/,
  );
});

it("never offers plain creation as a menu row now that it has a button", async () => {
  await act(async () => root.render(<ComposerFooter {...props} />));
  await openMenu();
  const labels = [...document.querySelectorAll('[role="menuitemradio"]')].map(
    (el) => el.textContent ?? "",
  );
  expect(labels.some((label) => label.includes("Create only"))).toBe(false);
  expect(labels.some((label) => label.includes("Start chat"))).toBe(true);
});

it("commits plain creation from its own button, without touching the launch mode", async () => {
  const create = vi.fn();
  const submit = vi.fn();
  const launchChange = vi.fn();
  await act(async () =>
    root.render(
      <ComposerFooter
        {...props}
        onCreate={create}
        onSubmit={submit}
        onLaunchChange={launchChange}
      />,
    ),
  );
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[data-testid="composer-create"]')!.click(),
  );
  expect(create).toHaveBeenCalledOnce();
  expect(submit).not.toHaveBeenCalled();
  expect(launchChange).not.toHaveBeenCalled();
});

it("changes mode without submitting, then commits the selected saved automation", async () => {
  const submit = vi.fn();
  function Harness() {
    const [launch, setLaunch] = useState<ComposerLaunch>({ kind: "kickoff" });
    return (
      <ComposerFooter
        {...props}
        launch={launch}
        onLaunchChange={setLaunch}
        onSubmit={() => submit(launch)}
      />
    );
  }
  await act(async () => root.render(<Harness />));
  await openMenu();
  expect(radio("Start chat").getAttribute("aria-checked")).toBe("true");
  expect(document.body.textContent).toContain("Todo · this column");
  expect(document.body.textContent).toContain("Doing");
  await act(async () => radio("Implement").click());
  expect(submit).not.toHaveBeenCalled();
  expect(host.textContent).toContain("Saved runtime");
  expect(host.querySelector('[aria-label^="Model:"]')).toBeNull();
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[data-testid="composer-submit"]')!.click(),
  );
  expect(submit).toHaveBeenCalledExactlyOnceWith({
    kind: "automation",
    projectId: "p1",
    automationId: "a2",
  });
});

it("can browse launch modes while the title is empty, but cannot commit either way", async () => {
  const create = vi.fn();
  const submit = vi.fn();
  function Harness() {
    const [launch, setLaunch] = useState<ComposerLaunch>({ kind: "kickoff" });
    return (
      <ComposerFooter
        {...props}
        disabled
        launch={launch}
        onLaunchChange={setLaunch}
        onCreate={create}
        onSubmit={submit}
      />
    );
  }
  await act(async () => root.render(<Harness />));
  await openMenu();
  expect(radio("Triage").getAttribute("data-disabled")).toBeNull();
  await act(async () => radio("Implement").click());
  const button = host.querySelector<HTMLButtonElement>('[data-testid="composer-create"]')!;
  expect(button.disabled).toBe(true);
  expect(host.querySelector('[aria-label^="Model:"]')).toBeNull();
  await act(async () => button.click());
  expect(create).not.toHaveBeenCalled();
  expect(submit).not.toHaveBeenCalled();
});

it("does not silently fall back to starting chat when a selected automation disappears", () => {
  const html = render({
    launch: { kind: "automation", projectId: "p1", automationId: "missing" },
  });
  expect(html).toContain("Choose an available automation");
  expect(html).toContain('aria-label="Create &amp; run"');
  expect(html).toMatch(/data-testid="composer-submit"[^>]*disabled=""/);
  expect(html).not.toContain("composer-kickoff");
  // The unavailable primary must not take plain creation down with it.
  expect(html).toMatch(/data-testid="composer-create"(?![^>]*disabled)/);
});

it("shows model controls only for chat kickoff", () => {
  expect(render()).toContain('aria-label="Model:');
  expect(render({ launch: { kind: "create" } })).not.toContain('aria-label="Model:');
});

it("wires kickoff model and effort into the shared responsive control", () => {
  const html = render({
    run: {
      models: [
        {
          id: "anthropic/sonnet",
          providerId: "anthropic",
          providerLabel: "Anthropic",
          modelId: "sonnet",
          label: "Sonnet",
          reasoningLevels: ["low", "high"],
        },
      ],
      tiers: [],
      selection: { providerId: "anthropic", modelId: "sonnet", reasoningLevel: "high" },
      setSelection: () => undefined,
    },
  });

  expect(html).toContain("composer-merged-effort-label");
  expect(html).toContain("composer-separate-effort");
});

it("keeps the launch selector available without a catalogue", async () => {
  await act(async () =>
    root.render(
      <ComposerFooter {...props} automationOffer={{ ...props.automationOffer, groups: [] }} />,
    ),
  );
  await openMenu();
  expect(radio("Start chat")).toBeDefined();
  expect(document.body.textContent).toContain("No ticket automations in this project.");
});

it("does not claim an empty catalogue or expose cached runs while reading", () => {
  const html = renderToStaticMarkup(
    <CreateRunAutomationItems groups={GROUPS} ready={false} enabledIds={[]} />,
  );
  expect(html).toContain("Reading automations");
  expect(html).not.toContain("No ticket automations");
  expect(html).not.toContain("Implement");
});
