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
import { NO_AUTOMATION_TRIGGER } from "@volli/shared";
import type { Automation, AutomationRun, AutomationSkippedOccurrence, Ticket } from "@volli/shared";

import { AutomationsPage } from "./automations-page";
import { openRunSession, runAutomationFromListing, runSkippedOccurrence } from "./run-automation";
import { useAutomationsStore } from "@renderer/stores/automations";
import { useBoardStore } from "@renderer/stores/board";
import { useProjectsStore } from "@renderer/stores/projects";

// The Run glue is the palette's too, and it is where a Run's no-redirect
// landing is decided; what this file owns is whether the PAGE calls it, and
// with which Automation and which Ticket.
vi.mock("./run-automation", () => ({
  openRunSession: vi.fn(),
  runAutomationFromListing: vi.fn(),
  runSkippedOccurrence: vi.fn(),
}));

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
    trigger: NO_AUTOMATION_TRIGGER,
    runtime: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

const TICKET = {
  id: "t1",
  projectId: "p1",
  ticketNumber: 12,
  title: "Ship the page",
  body: "",
  status: "todo",
  priority: "medium",
  labels: [],
  usesWorktree: true,
  harnessId: null,
  worktreePath: null,
  branch: null,
  baseBranch: null,
  archivedAt: null,
  sortOrder: 0,
  createdAt: 1,
  updatedAt: 1,
} as unknown as Ticket;

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

function skip(overrides: Partial<AutomationSkippedOccurrence> = {}): AutomationSkippedOccurrence {
  return {
    id: "skip-1",
    automationId: "automation-1",
    automationName: "Nightly sweep",
    projectId: "p1",
    dueAt: 5,
    missedCount: 1,
    reason: { kind: "app-closed" },
    recordedAt: 40,
    ...overrides,
  };
}

const doors = {
  list: vi.fn(),
  runsForProject: vi.fn(),
  skipsForProject: vi.fn(),
  enablement: vi.fn(),
  setEnabled: vi.fn(),
  create: vi.fn(),
  delete: vi.fn(),
  update: vi.fn(),
};

async function mount(seed: {
  automations?: Automation[];
  runs?: AutomationRun[];
  skips?: AutomationSkippedOccurrence[];
  enabled?: string[];
}) {
  doors.list.mockResolvedValue({ ok: true, automations: seed.automations ?? [] });
  doors.runsForProject.mockResolvedValue({ ok: true, runs: seed.runs ?? [] });
  doors.skipsForProject.mockResolvedValue({ ok: true, skips: seed.skips ?? [] });
  doors.enablement.mockResolvedValue({ ok: true, enabledAutomationIds: seed.enabled ?? [] });
  doors.setEnabled.mockResolvedValue({
    ok: true,
    enabledAutomationIds: ["automation-1"],
    receipt: {},
  });
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

/** Types into a controlled input the way React's own event system sees it. */
function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  for (const door of Object.values(doors)) door.mockReset();
  vi.mocked(openRunSession).mockReset();
  vi.mocked(runAutomationFromListing).mockReset();
  vi.mocked(runSkippedOccurrence).mockReset();
  useProjectsStore.setState({ projects: [PROJECT], selectedProjectId: "p1" });
  useBoardStore.setState({ ticketsByProject: { p1: [TICKET] } });
  useAutomationsStore.setState({
    byProject: {},
    runsByProject: {},
    skipsByProject: {},
    enabledIds: [],
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

  it("prints a column Trigger's own columns rather than claiming manual-only", async () => {
    // This is the surface that AUTHORS the Trigger (VC-127), so a row that said
    // "Only when I run it" over a record naming Doing would be the page
    // contradicting the form one click away.
    await mount({
      automations: [
        automation({ trigger: { kind: "columns", columns: ["doing", "needs_review"] } }),
      ],
    });

    expect(text()).toContain("Ticket enters Doing, Needs Review");
    expect(text()).not.toContain("Only when I run it");
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
  it("is off until this machine says otherwise, and says what off means", async () => {
    // VC-112: a machine fires nothing until someone turns something on there.
    await mount({ automations: [automation()] });

    expect(text()).toContain("Won’t start on its own");
  });

  it("drops that line once the switch is on here", async () => {
    await mount({ automations: [automation()], enabled: ["automation-1"] });

    expect(text()).not.toContain("Won’t start on its own");
  });

  it("writes through the command door and adopts the set it answers with", async () => {
    await mount({ automations: [automation()] });

    await act(async () => {
      button("Enabled on this machine: Review sweep").click();
    });

    expect(doors.setEnabled).toHaveBeenCalledWith({
      commandId: expect.stringMatching(/-/) as unknown as string,
      automationId: "automation-1",
      enabled: true,
    });
    expect(useAutomationsStore.getState().enabledIds).toEqual(["automation-1"]);
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

describe("running by hand", () => {
  it("runs on a Ticket chosen here, without navigating away from the page", async () => {
    // VC-112: every Automation is runnable by hand from every surface that
    // lists it. The page lists them and has no Ticket of its own, so it asks.
    // The row is also switched OFF on this machine — the switch governs what
    // starts an Automation BESIDES a person, and is never a lock.
    await mount({ automations: [automation()] });

    await act(async () => {
      button("Run Review sweep").click();
    });
    expect(document.body.textContent).toContain("Run “Review sweep” on");

    const ticketRow = [...document.querySelectorAll("button")].find((candidate) =>
      candidate.textContent?.includes("Ship the page"),
    );
    await act(async () => {
      ticketRow?.click();
    });

    expect(runAutomationFromListing).toHaveBeenCalledWith({
      automationId: "automation-1",
      automationName: "Review sweep",
      ticketId: "t1",
      ticketDisplayId: "VC-12",
    });
  });

  it("narrows the Tickets it offers to what was typed", async () => {
    await mount({ automations: [automation()] });

    await act(async () => {
      button("Run Review sweep").click();
    });
    const find = document.querySelector('[aria-label="Find a ticket"]') as HTMLInputElement;
    await act(async () => {
      setInputValue(find, "nothing like this");
    });

    expect(document.body.textContent).toContain("No tickets here.");
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

  it("opens the Session a Run created, on the Ticket it ran on", async () => {
    await mount({ runs: [run()] });

    const row = [...document.querySelectorAll("button")].find((candidate) =>
      candidate.textContent?.includes("claude-opus"),
    );
    await act(async () => {
      row?.click();
    });

    expect(openRunSession).toHaveBeenCalledWith({
      sessionId: "s1",
      projectId: "p1",
      ticketId: "t1",
    });
  });

  it("stays a door once the Ticket is gone — the Session outlived it", async () => {
    await mount({ runs: [run({ ticketId: null })] });

    const row = [...document.querySelectorAll("button")].find((candidate) =>
      candidate.textContent?.includes("claude-opus"),
    );
    await act(async () => {
      row?.click();
    });

    expect(openRunSession).toHaveBeenCalledWith({
      sessionId: "s1",
      projectId: "p1",
      ticketId: null,
    });
  });
});

describe("schedules (VC-130)", () => {
  const NIGHTLY = {
    kind: "schedule" as const,
    schedule: { preset: "daily" as const, hour: 21, minute: 0, timeZone: "Europe/London" },
  };

  it("prints a scheduled row's whole sentence, zone included", async () => {
    await mount({ automations: [automation({ trigger: NIGHTLY })] });
    // The stored zone is shown ALWAYS (VC-112) — a row that hid it would leave
    // a reader unable to tell whose 21:00 this is.
    expect(text()).toContain("Every day at 21:00 Europe/London");
    expect(text()).not.toContain("Only when I run it");
  });

  it("shows a Skipped occurrence in the Run history, never as a silence", async () => {
    await mount({
      automations: [automation({ trigger: NIGHTLY })],
      runs: [run({ createdAt: 1 })],
      skips: [skip({ dueAt: 5, missedCount: 3 })],
    });

    expect(text()).toContain("Nightly sweep");
    expect(text()).toContain("Skipped");
    expect(text()).toContain("Volli wasn’t running");
    // One row per gap, saying how wide the gap was.
    expect(text()).toContain("3 occurrences");
  });

  it("offers Run now on a skip, and starts ONE Run at the Project", async () => {
    await mount({ skips: [skip({ missedCount: 50 })] });

    await act(async () => {
      button("Run Nightly sweep now").click();
    });

    // Fifty missed occurrences, one Run: a missed occurrence is never replayed
    // (VC-112), and this is the by-hand recovery offered instead.
    expect(vi.mocked(runSkippedOccurrence)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runSkippedOccurrence)).toHaveBeenCalledWith({
      automationId: "automation-1",
      automationName: "Nightly sweep",
      projectId: "p1",
    });
  });

  it("says a refused Run was refused, and quotes the reason", async () => {
    await mount({
      skips: [
        skip({ reason: { kind: "run-refused", code: "MODEL_REQUIRED", error: "Choose a model." } }),
      ],
    });
    expect(text()).toContain("Skipped");
    expect(text()).toContain("Choose a model.");
  });
});
