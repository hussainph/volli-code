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

it("has one commit action at rest, with no create-more switch or competing launch buttons", () => {
  const html = render();
  expect(html).toContain('data-testid="composer-kickoff"');
  expect(html).toContain('aria-label="Choose creation action"');
  expect(html).not.toContain('aria-label="Create more"');
  expect(html).not.toContain('aria-label="Create ticket"');
  expect(html).not.toContain('aria-label="Create and run an automation"');
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

it("can choose plain creation while the title is empty, but cannot commit", async () => {
  const submit = vi.fn();
  function Harness() {
    const [launch, setLaunch] = useState<ComposerLaunch>({ kind: "kickoff" });
    return (
      <ComposerFooter
        {...props}
        disabled
        launch={launch}
        onLaunchChange={setLaunch}
        onSubmit={submit}
      />
    );
  }
  await act(async () => root.render(<Harness />));
  await openMenu();
  expect(radio("Triage").getAttribute("data-disabled")).toBeNull();
  await act(async () => radio("Create only").click());
  const button = host.querySelector<HTMLButtonElement>('[aria-label="Create ticket"]')!;
  expect(button.disabled).toBe(true);
  expect(host.querySelector('[aria-label^="Model:"]')).toBeNull();
  await act(async () => button.click());
  expect(submit).not.toHaveBeenCalled();
});

it("does not silently fall back to starting chat when a selected automation disappears", () => {
  const html = render({
    launch: { kind: "automation", projectId: "p1", automationId: "missing" },
  });
  expect(html).toContain("Choose an available automation");
  expect(html).toMatch(/disabled="" aria-label="Create &amp; run"/);
  expect(html).not.toContain("composer-kickoff");
});

it("shows model controls only for chat kickoff", () => {
  expect(render()).toContain('aria-label="Model:');
  expect(render({ launch: { kind: "create" } })).not.toContain('aria-label="Model:');
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
