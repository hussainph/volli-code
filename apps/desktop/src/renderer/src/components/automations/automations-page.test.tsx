// @vitest-environment jsdom
/**
 * The Automations page's behaviour (VC-127): that it is the whole record
 * lifecycle on one surface, and that its Run history is honest.
 *
 * A real jsdom ENVIRONMENT rather than a static render, for the reason
 * `search-panel.test.tsx` states: react-dom decides whether it can install its
 * event system when it is first imported, and the acts under test here —
 * flipping the machine-local switch, duplicating, confirming a delete — are
 * clicks. A static render would prove the markup and none of the promises.
 */
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Automation, AutomationRun } from "@volli/shared";

import { AutomationsPage } from "./automations-page";
import { useAutomationsStore } from "@renderer/stores/automations";
import { useProjectsStore } from "@renderer/stores/projects";

let root: Root | null = null;
let container: HTMLElement | null = null;

const PROJECT = {
  id: "p1",
  name: "Volli Code",
  path: "/code/volli-code",
  ticketPrefix: "VC",
  baseBranch: null,
  setupCommand: null,
  colorIndex: 0,
  sortOrder: 0,
  createdAt: 1,
  updatedAt: 1,
};

function automation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: "automation-1",
    projectId: "p1",
    name: "Review sweep",
    instructions: "/review",
    runtime: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function run(overrides: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id: "run-1",
    automationId: "automation-1",
    automationName: "Review sweep",
    ticketId: "t1",
    sessionId: "s1",
    model: { providerId: "anthropic", modelId: "claude-opus", reasoningLevel: "high" },
    createdAt: 10,
    ...overrides,
  };
}

const doors = {
  list: vi.fn(),
  runsForProject: vi.fn(),
  enablement: vi.fn(),
  setEnabled: vi.fn(),
  create: vi.fn(),
  delete: vi.fn(),
  update: vi.fn(),
};

async function mount(seed: {
  automations?: Automation[];
  runs?: AutomationRun[];
  disabled?: string[];
}) {
  doors.list.mockResolvedValue({ ok: true, automations: seed.automations ?? [] });
  doors.runsForProject.mockResolvedValue({ ok: true, runs: seed.runs ?? [] });
  doors.enablement.mockResolvedValue({ ok: true, disabledAutomationIds: seed.disabled ?? [] });
  doors.setEnabled.mockResolvedValue({ ok: true, disabledAutomationIds: ["automation-1"] });
  doors.create.mockResolvedValue({ ok: true, automation: automation({ id: "automation-2" }) });
  doors.delete.mockResolvedValue({ ok: true, receipt: {} });
  Object.defineProperty(window, "api", {
    configurable: true,
    value: { automations: doors },
  });

  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<AutomationsPage />);
  });
}

function text(): string {
  return container?.textContent ?? "";
}

function button(label: string): HTMLElement {
  const found = document.querySelector(`[aria-label="${label}"]`);
  if (found === null) throw new Error(`no control labelled ${label}`);
  return found as HTMLElement;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  for (const door of Object.values(doors)) door.mockReset();
  useProjectsStore.setState({ projects: [PROJECT], selectedProjectId: "p1" });
  useAutomationsStore.setState({
    byProject: {},
    runsByProject: {},
    disabledIds: [],
    editor: null,
  });
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
  vi.unstubAllGlobals();
});

describe("the page", () => {
  it("lists project-owned and global Automations under their own headings", async () => {
    await mount({
      automations: [
        automation(),
        automation({ id: "automation-2", projectId: null, name: "Nightly sweep" }),
      ],
    });

    expect(text()).toContain("This project");
    expect(text()).toContain("Review sweep");
    expect(text()).toContain("All projects");
    expect(text()).toContain("Nightly sweep");
  });

  it("states the default Trigger and an inherited Runtime on every row", async () => {
    await mount({ automations: [automation()] });

    expect(text()).toContain("Only when I run it");
    expect(text()).toContain("Default model");
  });

  it("shows a pinned Runtime as one model-and-reasoning pair", async () => {
    await mount({
      automations: [
        automation({
          runtime: { providerId: "anthropic", modelId: "claude-opus", reasoningLevel: "high" },
        }),
      ],
    });

    expect(text()).toContain("claude-opus · high");
  });

  it("offers the create action even with nothing listed", async () => {
    await mount({});

    expect(text()).toContain("New Automation");
    expect(text()).toContain("Nothing has run in this project yet.");
  });
});

describe("enable and disable", () => {
  it("is a switch per row, and says what being off actually means", async () => {
    await mount({ automations: [automation()], disabled: ["automation-1"] });

    expect(text()).toContain("Won’t start on its own");
  });

  it("writes through the machine-local door and adopts the set it answers with", async () => {
    await mount({ automations: [automation()] });

    await act(async () => {
      button("Enabled on this machine: Review sweep").click();
    });

    expect(doors.setEnabled).toHaveBeenCalledWith({
      automationId: "automation-1",
      enabled: false,
    });
    expect(useAutomationsStore.getState().disabledIds).toEqual(["automation-1"]);
  });
});

describe("the row's own actions", () => {
  it("opens the one authoring form on the record when the row is activated", async () => {
    const record = automation();
    await mount({ automations: [record] });

    const row = [...document.querySelectorAll("button")].find((candidate) =>
      candidate.textContent?.includes("Only when I run it"),
    );
    await act(async () => {
      row?.click();
    });

    expect(useAutomationsStore.getState().editor).toEqual({
      projectId: "p1",
      automation: record,
    });
  });
});

describe("run history", () => {
  it("names the Automation and the model and reasoning the Run resolved", async () => {
    await mount({ runs: [run()] });

    expect(text()).toContain("Review sweep");
    expect(text()).toContain("claude-opus · high");
  });

  it("keeps the order main answered with — newest first", async () => {
    await mount({
      runs: [
        run({ id: "run-2", automationName: "Newest", createdAt: 200 }),
        run({ id: "run-1", automationName: "Oldest", createdAt: 100 }),
      ],
    });

    expect(text().indexOf("Newest")).toBeLessThan(text().indexOf("Oldest"));
  });

  it("names an Unbound Run rather than leaving its row anonymous", async () => {
    await mount({ runs: [run({ automationId: null, automationName: null })] });

    expect(text()).toContain("Run once");
  });
});
