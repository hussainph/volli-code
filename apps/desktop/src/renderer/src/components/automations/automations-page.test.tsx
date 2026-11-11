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
import { renderToStaticMarkup } from "react-dom/server";
import { AutomationOffIcon } from "@renderer/components/ui/icon";

import { act, type ComponentProps } from "react";
import type { DragEndEvent } from "@dnd-kit/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  DEFAULT_CODE_MODE_POLICY,
  DEFAULT_COMPACTION_POLICY,
  EMPTY_MODEL_ACCESS_DEFAULTS,
  MAX_OFFERED_DIGITS,
  NO_AUTOMATION_TRIGGER,
} from "@volli/shared";
import type {
  Automation,
  AutomationRun,
  AutomationSkippedOccurrence,
  ModelAccessState,
  ModelSelection,
  Ticket,
} from "@volli/shared";

import { AutomationsPage } from "./automations-page";
import { clearEditorDraft, loadEditorDraft, saveEditorDraft } from "./editor-draft";
import { openRunSession, runAutomationForProject, runAutomationOnTicket } from "./run-automation";
import { appStateStorage } from "@renderer/lib/app-state-storage";
import { ModelAccessProvider, type ModelAccessClient } from "@renderer/lib/model-access-client";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { useAutomationsStore } from "@renderer/stores/automations";
import { useBoardStore } from "@renderer/stores/board";
import { useProjectsStore } from "@renderer/stores/projects";

// The Run glue is the palette's too, and it owns VC-234's universal toast
// landing; this file owns whether the PAGE calls it, and with which Automation
// and which Ticket.
vi.mock("./run-automation", () => ({
  openRunSession: vi.fn(),
  runAutomationOnTicket: vi.fn(),
  runAutomationForProject: vi.fn(),
}));

// jsdom performs no layout, so no real pointer or keyboard drag can aim at a
// lane row. The lane's own drop handler is captured off its `DndContext`
// instead, and handed the event dnd-kit would have handed it.
const laneDnd = vi.hoisted(() => ({
  onDragEnd: null as ((event: DragEndEvent) => void) | null,
}));
vi.mock("@dnd-kit/core", async (importActual) => {
  const actual = await importActual<typeof import("@dnd-kit/core")>();
  return {
    ...actual,
    DndContext: (props: ComponentProps<typeof actual.DndContext>) => {
      laneDnd.onDragEnd = props.onDragEnd ?? null;
      return <actual.DndContext {...props} />;
    },
  };
});

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
    attendance: "attended",
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
  runsForAutomation: vi.fn(),
  skipsForAutomation: vi.fn(),
  enablement: vi.fn(),
  setEnabled: vi.fn(),
  create: vi.fn(),
  delete: vi.fn(),
  update: vi.fn(),
  armings: vi.fn(),
  columnOrders: vi.fn(),
  setColumnOrder: vi.fn(),
};

interface CatalogueSeed {
  modelLabel: string;
  state?: ModelAccessState;
  hidden?: boolean;
}

/**
 * A model-access client whose catalogue knows ONE model, under a display label
 * and availability the test chooses. Mounted through the real
 * {@link ModelAccessProvider} — the context the app shell wraps every page in —
 * because these tests must prove that the shared name resolves through the
 * catalogue read, and a stub of the component would prove nothing about that.
 */
function catalogueClient({
  modelLabel,
  state = "available",
  hidden = false,
}: CatalogueSeed): ModelAccessClient {
  return {
    inspect: async () => ({
      observedAt: 1,
      providers: [
        {
          id: "anthropic",
          label: "Anthropic",
          state,
          accountLabel: null,
          billingSource: "subscription",
          recovery: null,
          signIn: [],
          hasStoredCredential: state === "available",
        },
      ],
      models: [
        {
          providerId: "anthropic",
          modelId: "claude-opus",
          label: modelLabel,
          state,
          reasoningLevels: ["medium", "high", "xhigh"],
          acceptsImageInput: true,
        },
      ],
    }),
    defaults: async () => EMPTY_MODEL_ACCESS_DEFAULTS,
    setDefault: async () => EMPTY_MODEL_ACCESS_DEFAULTS,
    hiddenModels: async () => (hidden ? [{ providerId: "anthropic", modelId: "claude-opus" }] : []),
    setHiddenModels: async (refs) => refs,
    compactionPolicy: async () => DEFAULT_COMPACTION_POLICY,
    setCompactionPolicy: async (policy) => policy,
    codeModePolicy: async () => DEFAULT_CODE_MODE_POLICY,
    setCodeModePolicy: async (policy) => policy,
    pickerView: async () => "all" as const,
    setPickerView: async (view) => view,
    beginSignIn: async () => {
      throw new Error("not under test");
    },
    signOut: async () => undefined,
  };
}

async function mount(seed: {
  automations?: Automation[];
  failList?: boolean;
  runs?: AutomationRun[];
  skips?: AutomationSkippedOccurrence[];
  enabled?: string[];
  armings?: { projectId: string; status: string; automationId: string; armedAt: number }[];
  orders?: {
    projectId: string;
    status: string;
    rankedAutomationIds: string[];
    orderedAt: number;
  }[];
  /** Mount the real model catalogue, even for hidden or unavailable models. */
  catalogue?: CatalogueSeed;
}) {
  doors.list.mockResolvedValue(
    seed.failList
      ? { ok: false, error: "Read unavailable" }
      : { ok: true, automations: seed.automations ?? [] },
  );
  doors.runsForProject.mockResolvedValue({ ok: true, runs: seed.runs ?? [] });
  doors.skipsForProject.mockResolvedValue({ ok: true, skips: seed.skips ?? [] });
  // The SCOPED doors answer the way main does (`listProjectRunsForAutomation`,
  // proven in `automations-repo.test.ts`): one record's rows, by id. The page
  // cannot invent a row main did not send, so what these tests prove is that
  // the page asks the right question and draws the answer it is given.
  doors.runsForAutomation.mockImplementation(async (input: { automationId: string }) => ({
    ok: true,
    runs: (seed.runs ?? []).filter((row) => row.automationId === input.automationId),
  }));
  doors.skipsForAutomation.mockImplementation(async (input: { automationId: string }) => ({
    ok: true,
    skips: (seed.skips ?? []).filter((row) => row.automationId === input.automationId),
  }));
  doors.enablement.mockResolvedValue({ ok: true, enabledAutomationIds: seed.enabled ?? [] });
  doors.armings.mockResolvedValue({ ok: true, armings: seed.armings ?? [] });
  doors.columnOrders.mockResolvedValue({ ok: true, orders: seed.orders ?? [] });
  doors.setColumnOrder.mockResolvedValue({ ok: true, orders: [], receipt: {} });
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
  const page = (
    // The provider the app shell already mounts around every page
    // (`ui/sidebar.tsx`): the lane header's arming bolt is the board's own
    // control, tooltip and all.
    <TooltipProvider delayDuration={0}>
      <AutomationsPage />
    </TooltipProvider>
  );
  await act(async () => {
    root?.render(
      // The model catalogue rides the same context the app shell mounts.
      // Absent, the page's model names fall back to the stored ids — the
      // drawing every other test here sees.
      seed.catalogue === undefined ? (
        page
      ) : (
        <ModelAccessProvider client={catalogueClient(seed.catalogue)}>{page}</ModelAccessProvider>
      ),
    );
  });
  if (!seed.automations?.length && (seed.runs !== undefined || seed.skips !== undefined))
    await act(async () => button("History").click());
}

function text(): string {
  return container?.textContent ?? "";
}

function hasUiText(needle: string): boolean {
  return [...document.querySelectorAll(".text-ui")].some((candidate) =>
    candidate.textContent?.includes(needle),
  );
}

function button(label: string): HTMLElement {
  const found = document.querySelector(`[aria-label="${label}"]`);
  if (found === null) throw new Error(`no control labelled ${label}`);
  return found as HTMLElement;
}

/** The one Run history on screen: the selected editor's, or the project's. */
function historySection(): HTMLElement {
  const sections = document.querySelectorAll<HTMLElement>("[data-run-history]");
  if (sections.length !== 1) throw new Error(`${sections.length} Run histories on screen`);
  return sections.item(0);
}

/** The ids the history actually drew, in drawn order. */
function historyRowIds(kind: "run" | "skip"): string[] {
  return [...historySection().querySelectorAll(`[data-run-history-${kind}]`)].map(
    (row) => row.getAttribute(`data-run-history-${kind}`) ?? "",
  );
}

function historyRun(id: string): HTMLElement {
  const found = historySection().querySelector<HTMLElement>(`[data-run-history-run="${id}"]`);
  if (found === null) throw new Error(`no Run row for ${id}`);
  return found;
}

function railRow(id: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`[data-automation-rail-row="${id}"]`);
  if (found === null) throw new Error(`no rail row for ${id}`);
  return found;
}

/** The rail's way back to the whole project's work (VC-297). */
function activityRow(): HTMLElement {
  return button("History");
}

function paragraph(copy: string): HTMLParagraphElement {
  const found = [...document.querySelectorAll("p")].find(
    (candidate) => candidate.textContent === copy,
  );
  if (found === undefined) throw new Error(`no paragraph reading ${copy}`);
  return found;
}

/** Opens a tooltip through the pointer door its Radix trigger actually listens to. */
async function showTooltip(trigger: HTMLElement): Promise<HTMLElement> {
  await act(async () => {
    trigger.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerType: "mouse" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const found = document.querySelector('[data-slot="tooltip-content"]');
  if (found === null) throw new Error("tooltip did not open");
  return found as HTMLElement;
}

/** Opens a dropdown through the pointer door its Radix trigger actually listens to. */
async function openDropdown(trigger: HTMLElement): Promise<void> {
  await act(async () => {
    trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
  });
}

/** Types into a controlled input the way React's own event system sees it. */
function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function openLanes(): Promise<void> {
  const control = [...document.querySelectorAll("button")].find(
    (candidate) => candidate.getAttribute("aria-label") === "Columns",
  );
  if (control === undefined) throw new Error("no Lanes view control");
  await act(async () => {
    control.click();
  });
}

beforeEach(() => {
  clearEditorDraft("p1");
  clearEditorDraft("p1", undefined, "automation-1");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // The lane view reads it (dnd-kit's sortable transition is dropped under
  // reduced motion); jsdom does not implement it.
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  for (const door of Object.values(doors)) door.mockReset();
  vi.mocked(openRunSession).mockReset();
  vi.mocked(runAutomationOnTicket).mockReset().mockResolvedValue("started");
  vi.mocked(runAutomationForProject).mockReset().mockResolvedValue(undefined);
  useProjectsStore.setState({ projects: [PROJECT], selectedProjectId: "p1" });
  useBoardStore.setState({ ticketsByProject: { p1: [TICKET] } });
  useAutomationsStore.setState({
    byProject: {},
    armingByProject: {},
    orderByProject: {},
    runsByProject: {},
    skipsByProject: {},
    // The scoped slices too (VC-297). The store is a module singleton, so a
    // record's history cached by one test would otherwise be read by the next
    // — which is exactly how a cold-cache assertion passes for the wrong
    // reason, or a scoping bug hides behind a neighbour's warm cache.
    runsByAutomation: {},
    skipsByAutomation: {},
    enabledIds: [],
    enablementRead: false,
    railReadAt: {},
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
  vi.useRealTimers();
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
    expect(document.querySelector('[aria-label="All projects"]')).not.toBeNull();
    expect(text()).toContain("Nightly sweep");
  });

  it("states the default Trigger and an inherited Runtime on every row", async () => {
    await mount({ automations: [automation()] });

    expect(text()).toContain("Manual only");
    expect(text()).toContain("Project default");
    expect(hasUiText("Manual only")).toBe(true);
  });

  it("prints a column Trigger's own columns rather than claiming manual-only", async () => {
    // This is the surface that AUTHORS the Trigger (VC-127), so a row that said
    // "Manual only" over a record naming Doing would be the page
    // contradicting the form one click away.
    await mount({
      automations: [
        automation({ trigger: { kind: "columns", columns: ["doing", "needs_review"] } }),
      ],
    });

    const row = document.querySelector('[data-automation-rail-row="automation-1"]');
    expect(row?.textContent).toContain("Ticket enters Doing, Needs Review");
  });

  it("shows a pinned Runtime as the shared model name, and a tier as its row", async () => {
    // No catalogue in this harness, so what a row can prove anyway is the
    // honest fallback: the stored id, the provider on the mark's accessible
    // help identity rather than in the line, and effort carrying its noun. The catalogue-labelled drawing is the
    // "the model's display name" describe below.
    await mount({
      automations: [
        automation({
          runtime: { providerId: "anthropic", modelId: "claude-opus", reasoningLevel: "high" },
        }),
        automation({ id: "automation-tier", runtime: { kind: "tier", tier: "fast" } }),
      ],
    });

    expect(text()).toContain("claude-opus · High effort");
    expect(
      document
        .querySelector('[data-slot="model-name"]')
        ?.parentElement?.querySelector('[role="img"]')
        ?.getAttribute("aria-label"),
    ).toBe("anthropic");
    // A tier names a Settings row, not a model, and keeps its sentence — the
    // branch between the two drawings runs on the record's own runtime.
    await act(async () => railRow("automation-tier").click());
    expect(text()).toContain("Fast");
  });

  it("offers the create action and preserves Run history with nothing listed", async () => {
    await mount({});

    expect(text()).toContain("New automation");
    expect(text()).toContain("No automations yet");
    expect(document.querySelector("h1")?.textContent).toBe("Automations");
    expect(document.querySelector("aside")).toBeNull();
    expect(button("History")).not.toBeNull();
    expect(doors.runsForProject).not.toHaveBeenCalled();
    await act(async () => button("History").click());
    expect(text()).toContain("No runs yet");
  });

  it("merges ownership into trigger groups while retaining global scope", async () => {
    await mount({ automations: [automation({ projectId: null })] });

    expect(text()).toContain("Manual");
    expect(document.querySelector('[aria-label="All projects"]')).not.toBeNull();
    expect(document.querySelector('[data-automation-rail-row="automation-1"]')).not.toBeNull();
    expect(document.querySelector('header button[data-variant="default"]')?.textContent).toContain(
      "New automation",
    );
    expect(document.querySelector("aside")?.className).toContain("automation-master");
  });
});

describe("enable and disable", () => {
  it("is off until this machine says otherwise, and marks the rail row", async () => {
    // VC-112: a machine fires nothing until someone turns something on there.
    await mount({
      automations: [automation({ trigger: { kind: "columns", columns: ["doing"] } })],
    });

    expect(text()).toContain("Manual only");
    expect(
      (button("Automatic triggers on this Mac: Review sweep") as HTMLButtonElement).dataset.state,
    ).toBe("unchecked");
  });

  it("marks the selected record and rail row once switched on here", async () => {
    await mount({
      automations: [automation({ trigger: { kind: "columns", columns: ["doing"] } })],
      enabled: ["automation-1"],
    });

    expect(text()).toContain("Offered in Doing");
    expect(
      (button("Automatic triggers on this Mac: Review sweep") as HTMLButtonElement).dataset.state,
    ).toBe("checked");
  });

  it("writes through the command door and adopts the set it answers with", async () => {
    await mount({
      automations: [automation({ trigger: { kind: "columns", columns: ["doing"] } })],
    });

    await act(async () => {
      button("Automatic triggers on this Mac: Review sweep").click();
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
      candidate.textContent?.includes("Manual only"),
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

    const ticketRow = [...document.querySelectorAll<HTMLElement>("[cmdk-item]")].find((candidate) =>
      candidate.textContent?.includes("Ship the page"),
    );
    await act(async () => {
      ticketRow?.click();
    });
    await act(async () =>
      [...document.querySelectorAll<HTMLButtonElement>("button")]
        .find((b) => b.textContent === "Run on VC-12")
        ?.click(),
    );

    expect(runAutomationOnTicket).toHaveBeenCalledWith({
      target: { kind: "automation", automationId: "automation-1" },
      automationName: "Review sweep",
      ticketId: "t1",
      ticketDisplayId: "VC-12",
      modelOverride: null,
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

    const ticketNotice = paragraph("No matching tickets");
    expect(ticketNotice.classList.contains("sr-only")).toBe(true);
    expect(ticketNotice.classList.contains("text-sm")).toBe(false);
  });
});
const skipRow = () => historySection().querySelector('[data-run-history-skip="skip-1"]')!;

describe("run history", () => {
  it("ticks Run and skipped due ages with one clock without reloading history", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const now = new Date("2026-06-01T12:00:00Z").getTime();
    vi.setSystemTime(now);
    await mount({
      runs: [run({ createdAt: now - 44_000 })],
      skips: [skip({ dueAt: now - 43_000, recordedAt: now })],
    });
    expect(historyRun("run-1").textContent).toContain("just now");
    expect(skipRow().textContent).toContain("just now");
    expect(vi.getTimerCount()).toBe(1);

    await act(async () => vi.advanceTimersByTime(1_001));
    expect(historyRun("run-1").textContent).toContain("1m ago");
    expect(skipRow().textContent).toContain("just now");
    await act(async () => vi.advanceTimersByTime(1_001));
    expect(skipRow().textContent).toContain("1m ago");
    // Model a suspended page: the next callback sees the jumped wall clock.
    vi.setSystemTime(now + 3_600_000);
    await act(async () => vi.advanceTimersToNextTimer());
    expect(historyRun("run-1").textContent).toContain("1h ago");
    expect(skipRow().textContent).toContain("1h ago");
    expect(doors.runsForProject).toHaveBeenCalledTimes(1);
    expect(doors.skipsForProject).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);

    await act(async () => root?.unmount());
    root = null;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("names the Automation and the model and effort the Run resolved", async () => {
    await mount({ runs: [run()] });

    expect(text()).toContain("Review sweep");
    // Catalogue-less fallback: the stored model id plus effort as a noun;
    // the mark retains the provider identity without spending line width.
    expect(text()).toContain("claude-opus · High effort");
    expect(
      document
        .querySelector('[data-slot="model-name"]')
        ?.parentElement?.querySelector('[role="img"]')
        ?.getAttribute("aria-label"),
    ).toBe("anthropic");
    expect(hasUiText("claude-opus · High effort")).toBe(true);
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

  it("says how each Run started, so the row carries its trigger too (VC-297)", async () => {
    // VC-297 asks for the originating record AND its trigger on every row. The
    // record cannot supply the second one — a Trigger is editable and a record
    // is deletable — so the row prints the Run's OWN attendance instead.
    await mount({
      runs: [
        run({ id: "run-by-hand", attendance: "attended", createdAt: 200 }),
        run({ id: "run-automatic", attendance: "unattended", createdAt: 100 }),
      ],
    });

    expect(historyRun("run-by-hand").textContent).toContain("By hand");
    expect(historyRun("run-automatic").textContent).toContain("Automatic");
    // Never a schedule: an unattended Run may be the agent's, not a timer's.
    expect(historyRun("run-automatic").textContent?.toLowerCase()).not.toContain("schedule");
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

/**
 * The model's display name (VC-492). The pinned Runtime in the rail and the
 * resolved model in a Run row are one shared `ResolvedModelName` drawing, and
 * the catalogue it reads is the app shell's own context — so these mount the
 * real provider over a client, not a stub of the component. What the catalogue
 * answers for is the LABEL only: which model a Run used is the pair the Run
 * stored, and the ids may surface again only as the honest fallback for a
 * model the catalogue does not list.
 */
describe("the model's display name", () => {
  it("omits the effort suffix when a pin and a recorded Run have effort off", async () => {
    const model: ModelSelection = {
      providerId: "anthropic",
      modelId: "claude-opus",
      reasoningLevel: "off",
    };
    await mount({
      automations: [automation({ runtime: model })],
      runs: [run({ model })],
      catalogue: { modelLabel: "Claude Opus 4.5" },
    });
    const captions = [...document.querySelectorAll('[data-slot="model-name"]')].filter((node) =>
      node.textContent?.includes("Claude Opus 4.5"),
    );
    expect(captions.length).toBeGreaterThanOrEqual(2);
    for (const caption of captions) expect(caption.textContent).not.toMatch(/off|effort/i);
    expect(text()).not.toContain("Off effort");
  });
  it("resolves a pin and a Run row through the catalogue's label", async () => {
    await mount({
      automations: [
        automation({
          runtime: { providerId: "anthropic", modelId: "claude-opus", reasoningLevel: "xhigh" },
        }),
      ],
      runs: [run()],
      catalogue: { modelLabel: "Claude Opus 4.5" },
    });

    // The Run row prints the catalogue's name for the ids the Run stored.
    expect(hasUiText("Claude Opus 4.5 · High effort")).toBe(true);
    // The rail's pin draws the same shared name; `xhigh` is not an identifier
    // a reader should have to meet.
    expect(text()).toContain("Extra high effort");
    // Display-only resolution: the raw id is gone from the screen entirely.
    expect(text()).not.toContain("claude-opus");
    const captions = [...document.querySelectorAll('[data-slot="model-name"]')].filter(
      (node) => node.closest('[data-slot="select-trigger"]') === null,
    );
    expect(captions.length).toBeGreaterThanOrEqual(2);
    for (const caption of captions) {
      expect(caption.parentElement?.querySelector("svg[aria-hidden] path")).not.toBeNull();
      // ModelName wraps outside closed Select triggers. Its containers must
      // not silently clip the caption before its own reveal can see it.
      expect(caption.closest(".truncate")).toBeNull();
    }
  });

  it.each(["unavailable", "authentication-required", "hidden"] as const)(
    "still names a pin and its Run when the catalogue model is %s",
    async (availability) => {
      const pin: ModelSelection = {
        providerId: "anthropic",
        modelId: "claude-opus",
        reasoningLevel: "xhigh",
      };
      const recordedModel: ModelSelection = { ...pin, reasoningLevel: "high" };
      await mount({
        automations: [automation({ runtime: pin })],
        runs: [run({ model: recordedModel })],
        catalogue: {
          modelLabel: "Claude Opus 4.5",
          state: availability === "hidden" ? "available" : availability,
          hidden: availability === "hidden",
        },
      });

      // Identity reads the full catalogue, not the editor's offerable slice.
      // Scope each assertion so the editor cannot stand in for either caption.
      const pinCaption = document.querySelector(
        '[data-slot="automation-editor"] [data-slot="model-name"]',
      );
      const runCaption = historyRun("run-1").querySelector('[data-slot="model-name"]');
      expect(pinCaption?.textContent).toBe("Claude Opus 4.5 · Extra high effort");
      expect(runCaption?.textContent).toBe("Claude Opus 4.5 · High effort");
      for (const caption of [pinCaption!, runCaption!]) {
        expect(caption.parentElement?.querySelector("svg[aria-hidden] path")).not.toBeNull();
      }
      expect(text()).not.toContain("claude-opus");
      expect(useAutomationsStore.getState().editor?.automation?.runtime).toEqual(pin);
      expect(
        Object.values(useAutomationsStore.getState().runsByAutomation).flat()[0]?.model,
      ).toEqual(recordedModel);
      expect(doors.update).not.toHaveBeenCalled();
      expect(doors.create).not.toHaveBeenCalled();
    },
  );

  it("keeps unknown pin and Run ids instead of borrowing a catalogue neighbour's label", async () => {
    const selection: ModelSelection = {
      providerId: "some-gateway",
      modelId: "vendor/gpt-5-legacy",
      reasoningLevel: "high",
    };
    await mount({
      automations: [automation({ runtime: selection })],
      runs: [run({ model: selection })],
      catalogue: { modelLabel: "Claude Opus 4.5" },
    });

    const fallback = "vendor/gpt-5-legacy · High effort";
    expect(
      document.querySelector('[data-slot="automation-editor"] [data-slot="model-name"]')
        ?.textContent,
    ).toBe(fallback);
    expect(historyRun("run-1").querySelector('[data-slot="model-name"]')?.textContent).toBe(
      fallback,
    );
    expect(text()).not.toContain("Claude Opus 4.5");
    expect(
      document
        .querySelector('[data-slot="automation-editor"] [data-slot="model-name"]')
        ?.parentElement?.querySelector('[role="img"]')
        ?.getAttribute("aria-label"),
    ).toBe("some-gateway");
    expect(historyRun("run-1").querySelector('[role="img"]')?.getAttribute("aria-label")).toBe(
      "some-gateway",
    );
    expect(useAutomationsStore.getState().editor?.automation?.runtime).toEqual(selection);
    expect(Object.values(useAutomationsStore.getState().runsByAutomation).flat()[0]?.model).toEqual(
      selection,
    );
  });
});

/**
 * Whose history the editor shows (VC-297).
 *
 * Two Automations running in the same week interleave. An editor that drew the
 * project's whole list would say the record on screen did work it never did —
 * the rows name their origin, but provenance on a row is not scope on a list.
 *
 * The narrowing is MAIN's (`runsForAutomation` beside `runsForProject`, proven
 * in `automations-repo.test.ts`). What these tests own is the page's half: that
 * it asks for the record on screen, draws the answer, and asks again when the
 * reader moves to another record.
 */
describe("history is scoped to the selected Automation", () => {
  const REVIEW = automation();
  const NIGHTLY = automation({ id: "automation-2", name: "Nightly sweep" });
  // Interleaved on purpose: newest first across BOTH records is
  // nightly-skip, nightly-run, review-skip, review-run.
  const INTERLEAVED = {
    automations: [REVIEW, NIGHTLY],
    runs: [
      run({
        id: "run-nightly",
        automationId: "automation-2",
        automationName: "Nightly sweep",
        sessionId: "s2",
        createdAt: 400,
      }),
      run({ id: "run-review", automationId: "automation-1", createdAt: 100 }),
    ],
    skips: [
      skip({ id: "skip-nightly", automationId: "automation-2", dueAt: 500 }),
      skip({
        id: "skip-review",
        automationId: "automation-1",
        automationName: "Review sweep",
        dueAt: 200,
      }),
    ],
  };

  it("asks main for the selected record's own history, and draws that", async () => {
    await mount(INTERLEAVED);

    expect(doors.runsForAutomation).toHaveBeenCalledWith({
      projectId: "p1",
      automationId: "automation-1",
    });
    expect(doors.skipsForAutomation).toHaveBeenCalledWith({
      projectId: "p1",
      automationId: "automation-1",
    });
    expect(historySection().getAttribute("data-run-history")).toBe("automation-1");
    expect(historyRowIds("run")).toEqual(["run-review"]);
    expect(historyRowIds("skip")).toEqual(["skip-review"]);
    expect(historySection().textContent).not.toContain("Nightly sweep");
  });

  it("asks again, for the other record, when the reader moves to it", async () => {
    // The other half of the same rule: neither record may masquerade as the
    // other's history, so selecting the second one re-reads and swaps the list.
    await mount(INTERLEAVED);

    await act(async () => {
      railRow("automation-2").click();
    });

    expect(doors.runsForAutomation).toHaveBeenCalledWith({
      projectId: "p1",
      automationId: "automation-2",
    });
    expect(historySection().getAttribute("data-run-history")).toBe("automation-2");
    expect(historyRowIds("run")).toEqual(["run-nightly"]);
    expect(historyRowIds("skip")).toEqual(["skip-nightly"]);
  });

  it("never reads the project's whole history to draw ONE record's", async () => {
    // The architectural half of VC-297, and the one a client that is not this
    // process would feel: an editor asks for the list it draws. A page that
    // fetched every Run in the project and sieved it here would pass every
    // test above and still make a phone download a project's whole history.
    await mount(INTERLEAVED);

    expect(doors.runsForAutomation).toHaveBeenCalled();
    expect(doors.runsForProject).not.toHaveBeenCalled();
    expect(doors.skipsForProject).not.toHaveBeenCalled();
  });

  it("keeps a scoped Run a door to its OWN Session", async () => {
    // Narrowing the list must not re-aim the rows: each Run still opens the
    // Session it actually created, and the neighbour's Run holds "s2".
    await mount(INTERLEAVED);

    await act(async () => {
      historyRun("run-review").click();
    });

    expect(openRunSession).toHaveBeenCalledTimes(1);
    expect(openRunSession).toHaveBeenCalledWith({
      sessionId: "s1",
      projectId: "p1",
      ticketId: "t1",
    });
  });

  it("does not claim a record has never run before its history is read", async () => {
    // Each scope is its own read now, so a cold cache is the ordinary state
    // every time the reader picks another record. Answering that with
    // "Nothing has run this Automation yet" states a fact the next frame may
    // contradict, so the list stays silent until the read lands.
    await mount(INTERLEAVED);
    expect(historyRowIds("run")).toEqual(["run-review"]);

    // Now hold the neighbour's read open and move to it.
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    doors.runsForAutomation.mockImplementation(async (input: { automationId: string }) => {
      await held;
      return {
        ok: true,
        runs: INTERLEAVED.runs.filter((row) => row.automationId === input.automationId),
      };
    });

    await act(async () => {
      railRow("automation-2").click();
    });

    // The read is in flight: the neighbour's heading, and NO claim under it.
    // Critically, not the previous record's rows either.
    expect(historySection().getAttribute("data-run-history")).toBe("automation-2");
    expect(historyRowIds("run")).toEqual([]);
    expect(historySection().textContent).not.toContain("No runs yet");

    await act(async () => {
      release?.();
      await held;
    });

    expect(historyRowIds("run")).toEqual(["run-nightly"]);
  });

  it("says nothing has run THIS Automation while the project has other Runs", async () => {
    await mount({
      automations: [REVIEW],
      runs: [
        run({
          id: "run-nightly",
          automationId: "automation-2",
          automationName: "Nightly sweep",
        }),
      ],
    });

    expect(historyRowIds("run")).toEqual([]);
    expect(paragraph("No runs yet")).not.toBeNull();
    expect(historySection().textContent).not.toContain("Nightly sweep");
  });
});

/**
 * Project activity (VC-297): the interleaved list, labelled, and reachable.
 *
 * The rail always leaves one record selected once the list lands, so without
 * its own way in this view would only ever appear for a project that has no
 * Automations at all — and a Run whose record was DELETED, which main keeps on
 * purpose, would be kept where nobody could read it.
 */
describe("project activity", () => {
  it("is reachable from the rail while records exist", async () => {
    await mount({
      automations: [automation(), automation({ id: "automation-2", name: "Nightly sweep" })],
      runs: [
        run({ id: "run-review", automationId: "automation-1", createdAt: 100 }),
        run({
          id: "run-nightly",
          automationId: "automation-2",
          automationName: "Nightly sweep",
          createdAt: 400,
        }),
      ],
      skips: [skip({ id: "skip-nightly", automationId: "automation-2", dueAt: 500 })],
    });

    // Before: the editor's own narrow list.
    expect(historySection().getAttribute("data-run-history")).toBe("automation-1");

    await act(async () => {
      activityRow().click();
    });

    expect(historySection().getAttribute("data-run-history")).toBe("project");
    expect(historySection().textContent).toContain("History");
    // Every record's work, interleaved, newest first.
    expect(historyRowIds("run")).toEqual(["run-nightly", "run-review"]);
    expect(historyRowIds("skip")).toEqual(["skip-nightly"]);
    expect(doors.runsForProject).toHaveBeenCalledWith({ projectId: "p1" });
  });

  it("gives the reader their record back when they leave it", async () => {
    await mount({ automations: [automation()], runs: [run()] });

    await act(async () => {
      activityRow().click();
    });
    expect(historySection().getAttribute("data-run-history")).toBe("project");

    await act(async () => {
      [...document.querySelectorAll<HTMLButtonElement>("button")]
        .find((b) => b.textContent === "Automations")
        ?.click();
    });

    expect(historySection().getAttribute("data-run-history")).toBe("automation-1");
  });

  it("keeps a DELETED record's Run and an Unbound Run readable there", async () => {
    // Deleting an Automation deletes the record; the history of what it did is
    // not the record. Both rows belong to no editor, so this view is the only
    // place they can be read — and they still open their own Sessions.
    await mount({
      automations: [automation()],
      runs: [
        run({
          id: "run-retired",
          automationId: "gone",
          automationName: "Retired sweep",
          sessionId: "s2",
          createdAt: 300,
        }),
        run({
          id: "run-unbound",
          automationId: null,
          automationName: null,
          sessionId: "s3",
          createdAt: 200,
        }),
      ],
    });

    await act(async () => {
      activityRow().click();
    });

    expect(historyRowIds("run")).toEqual(["run-retired", "run-unbound"]);
    expect(historySection().textContent).toContain("Retired sweep");
    expect(historySection().textContent).toContain("Run once");

    await act(async () => {
      historyRun("run-unbound").click();
    });

    expect(openRunSession).toHaveBeenCalledTimes(1);
    expect(openRunSession).toHaveBeenCalledWith({
      sessionId: "s3",
      projectId: "p1",
      ticketId: "t1",
    });
  });

  it("labels the unfiltered list as the project's on the empty state too", async () => {
    // A project with no records at all: the same wide list, the same label,
    // and no editor for it to be mistaken for.
    await mount({ runs: [run()], skips: [skip({ automationId: "automation-2" })] });

    expect(historySection().getAttribute("data-run-history")).toBe("project");
    expect(historySection().textContent).toContain("History");
    expect(historyRowIds("run")).toEqual(["run-1"]);
    expect(historyRowIds("skip")).toEqual(["skip-1"]);
  });
});

/**
 * The lane view (VC-132). Its DRAG is proven where a drag can be proven — the
 * Lab rig, the pure model beside it, and the page smoke driving Playwright
 * pointer input through the browser event pipeline;
 * what a unit test can hold is what the lanes SAY: one lane per column, the
 * digit each row answers to, the pin, and the two-ranks-one-record property the
 * whole feature turns on.
 */
describe("the lane view", () => {
  const doingAndReview = automation({
    id: "shared",
    name: "Standards sweep",
    trigger: { kind: "columns", columns: ["doing", "needs_review"] },
  });
  const doingOnly = automation({
    id: "implement",
    name: "Implement",
    trigger: { kind: "columns", columns: ["doing"] },
  });

  it("draws one lane per board column, plus the lane for records no column offers", async () => {
    await mount({ automations: [automation()] });
    await openLanes();

    for (const label of ["Backlog", "Todo", "Doing", "Needs Review", "Done"]) {
      expect(text()).toContain(label);
    }
    // The default Trigger is "Nothing else", so the seeded record is off board.
    expect(text()).toContain("Other");
    await act(async () => button("Other").click());
    expect(document.querySelector('[data-lane-row="none:automation-1"]')).not.toBeNull();
  });

  it("names the disarmed menu choice No automation", async () => {
    await mount({ automations: [doingOnly] });
    await openLanes();

    await act(async () => {
      button("Arm Doing").dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, button: 0 }),
      );
    });

    const disarmed = document.querySelector('[data-slot="dropdown-menu-radio-item"]');
    expect(disarmed?.textContent).toBe("No automation");
    expect(disarmed?.querySelector("svg")).not.toBeNull();
    expect(disarmed?.getAttribute("aria-checked")).toBe("true");
  });

  it("puts a SCHEDULE record in that lane too, rather than claiming every automation has a column", async () => {
    // A schedule fires on a clock, so no column offers it and no digit means
    // anything for it — exactly the off-board case. Filtering for the "Nothing
    // else" Trigger alone left a schedule-only project reading a completeness
    // claim under a view that was hiding its records.
    await mount({
      automations: [
        automation({
          id: "nightly",
          name: "Nightly sweep",
          trigger: {
            kind: "schedule",
            schedule: { preset: "daily", hour: 21, minute: 0, timeZone: "Europe/London" },
          },
        }),
      ],
    });
    await openLanes();

    await act(async () => button("Other").click());
    expect(document.querySelector('[data-lane-row="none:nightly"]')).not.toBeNull();
    expect(text()).not.toContain("Every automation has a column.");
  });

  it("reads the column's authored rank as its digits", async () => {
    await mount({
      automations: [doingAndReview, doingOnly],
      orders: [
        {
          projectId: "p1",
          status: "doing",
          rankedAutomationIds: ["implement", "shared"],
          orderedAt: 1,
        },
      ],
    });
    await openLanes();

    expect(
      document.querySelector('[data-lane-row="doing:implement"]')?.getAttribute("data-lane-digit"),
    ).toBe("1");
    expect(
      document.querySelector('[data-lane-row="doing:shared"]')?.getAttribute("data-lane-digit"),
    ).toBe("2");
  });

  it("lets one Automation hold a different rank in two columns", async () => {
    await mount({
      automations: [doingAndReview, doingOnly],
      orders: [
        {
          projectId: "p1",
          status: "doing",
          rankedAutomationIds: ["implement", "shared"],
          orderedAt: 1,
        },
        {
          projectId: "p1",
          status: "needs_review",
          rankedAutomationIds: ["shared"],
          orderedAt: 1,
        },
      ],
    });
    await openLanes();

    expect(
      document.querySelector('[data-lane-row="doing:shared"]')?.getAttribute("data-lane-digit"),
    ).toBe("2");
    await act(async () => button("Needs Review").click());
    expect(
      document
        .querySelector('[data-lane-row="needs_review:shared"]')
        ?.getAttribute("data-lane-digit"),
    ).toBe("1");
  });

  it("pins the armed row to 1 and accents its bolt while it is switched on here", async () => {
    await mount({
      automations: [doingAndReview, doingOnly],
      armings: [{ projectId: "p1", status: "doing", automationId: "shared", armedAt: 1 }],
      orders: [
        {
          projectId: "p1",
          status: "doing",
          rankedAutomationIds: ["implement", "shared"],
          orderedAt: 1,
        },
      ],
      enabled: ["shared"],
    });
    await openLanes();

    const bolt = button("Doing runs Standards sweep");
    expect(bolt.getAttribute("data-arming-state")).toBe("ready");
    expect(bolt.className).toContain("text-primary-text");
    expect(bolt.querySelector('[data-arming-mark="armed"]')).not.toBeNull();
    const row = document.querySelector('[data-lane-row="doing:shared"]');
    expect(row?.getAttribute("data-lane-digit")).toBe("1");
    expect(row?.getAttribute("data-lane-arming")).toBe("ready");
  });

  it("draws rows ranked past the ninth without a digit, still in place and draggable", async () => {
    const crowd = Array.from({ length: 11 }, (_, index) =>
      automation({
        id: `crowd-${index}`,
        // Lettered, so a digit in a row's text can only be a printed digit.
        name: `Crowd ${String.fromCharCode(65 + index)}`,
        trigger: { kind: "columns", columns: ["doing"] },
      }),
    );
    await mount({
      automations: crowd,
      orders: [
        {
          projectId: "p1",
          status: "doing",
          rankedAutomationIds: crowd.map((row) => row.id).toReversed(),
          orderedAt: 1,
        },
      ],
    });
    await openLanes();

    const rows = [...document.querySelectorAll('[data-lane-row^="doing:"]')];
    expect(rows.map((row) => row.getAttribute("data-lane-row"))).toEqual(
      crowd.map((row) => `doing:${row.id}`).toReversed(),
    );
    expect(rows.map((row) => row.getAttribute("data-lane-digit"))).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
      null,
      null,
    ]);
    // dnd-kit's own sortable attributes: the digitless rows drag like the rest.
    for (const row of rows.slice(MAX_OFFERED_DIGITS)) {
      expect(row.getAttribute("aria-roledescription")).toBe("sortable");
      expect(row.textContent).not.toMatch(/\d/);
    }
    // Every row's key cap is the keycap rung, digit or not; past the ninth it
    // keeps its width but not its ink, so the names stay in one column.
    for (const [index, row] of rows.entries()) {
      const cap = row.querySelector("kbd");
      const classes = cap?.className.split(/\s+/) ?? [];
      expect(classes).toContain("rounded-keycap");
      expect(classes).not.toContain("rounded-sm");
      const placeholder = index >= MAX_OFFERED_DIGITS;
      expect(classes.includes("invisible")).toBe(placeholder);
      expect(cap?.getAttribute("aria-hidden")).toBe(placeholder ? "true" : null);
    }
  });

  it("stores the rank a drop of a row ranked past the ninth asks for", async () => {
    const crowd = Array.from({ length: 11 }, (_, index) =>
      automation({ id: `crowd-${index}`, trigger: { kind: "columns", columns: ["doing"] } }),
    );
    const authored = crowd.map((row) => row.id).toReversed();
    await mount({
      automations: crowd,
      orders: [{ projectId: "p1", status: "doing", rankedAutomationIds: authored, orderedAt: 1 }],
    });
    await openLanes();
    const eleventh = document.querySelector('[data-lane-row="doing:crowd-0"]');
    expect(eleventh?.getAttribute("data-lane-digit")).toBeNull();

    // The eleventh row, dropped on the first.
    await act(async () => {
      laneDnd.onDragEnd?.({
        active: { id: "doing:crowd-0" },
        over: { id: "doing:crowd-10" },
      } as DragEndEvent);
    });

    expect(doors.setColumnOrder).toHaveBeenCalledTimes(1);
    expect(doors.setColumnOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "p1",
        status: "doing",
        rankedAutomationIds: ["crowd-0", ...authored.slice(0, -1)],
      }),
    );
  });

  it("marks an armed-but-switched-off bolt, tooltip, menu row, and authored lane digit alike", async () => {
    await mount({
      automations: [doingAndReview, doingOnly],
      armings: [{ projectId: "p1", status: "doing", automationId: "shared", armedAt: 1 }],
      orders: [
        {
          projectId: "p1",
          status: "doing",
          rankedAutomationIds: ["implement", "shared"],
          orderedAt: 1,
        },
      ],
      enabled: [],
    });
    await openLanes();

    const label = "Doing is armed with Standards sweep — automatic triggers off";
    const bolt = button(label);
    expect(bolt.getAttribute("data-arming-state")).toBe("switched-off");
    // Armed remains distinct with triggers off: selected background, muted
    // outline, and the tooltip's own words. No filled icon family is needed.
    expect(bolt.className).toContain("bg-accent");
    expect(bolt.querySelector('[data-arming-mark="armed"]')).not.toBeNull();
    expect((await showTooltip(bolt)).textContent).toBe(label);

    // No effective arming means no pin: the authored digit remains, and the
    // annotation says why this persisted arming will not fire on a plain drop.
    const row = document.querySelector('[data-lane-row="doing:shared"]');
    expect(row?.getAttribute("data-lane-digit")).toBe("2");
    expect(row?.getAttribute("data-lane-arming")).toBe("switched-off");
    expect(row?.textContent).toContain("Armed · Manual only");

    await openDropdown(bolt);
    const menuRow = [...document.querySelectorAll('[data-slot="dropdown-menu-radio-item"]')].find(
      (candidate) => candidate.textContent?.includes("Standards sweep"),
    );
    expect(menuRow?.textContent).toBe("Standards sweep");
    expect(menuRow?.getAttribute("aria-label")).toBe("Standards sweep · Manual only");
    expect(menuRow?.getAttribute("title")).toBe("Standards sweep · Manual only");
    const expectedIcon = document.createElement("div");
    expectedIcon.innerHTML = renderToStaticMarkup(<AutomationOffIcon />);
    expect(menuRow?.querySelector("svg")?.innerHTML).toBe(
      expectedIcon.querySelector("svg")!.innerHTML,
    );
  });
});

describe("schedules (VC-130)", () => {
  const NIGHTLY = {
    kind: "schedule" as const,
    schedule: { preset: "daily" as const, hour: 21, minute: 0, timeZone: "Europe/London" },
  };

  it("runs a scheduled record at the PROJECT, without asking for a Ticket", async () => {
    // VC-112: the Trigger decides the Target, and a schedule names the Project.
    // Pressing Play here therefore opens the Board Session the schedule
    // itself would open — the by-hand Run and the automatic one are the same
    // work, and a Ticket dialog would quietly make them two.
    await mount({
      automations: [automation({ name: "Nightly sweep", trigger: NIGHTLY })],
    });

    await act(async () => {
      button("Run Nightly sweep").click();
    });

    expect(document.body.textContent).not.toContain("Run “Nightly sweep” on");
    expect(runAutomationOnTicket).not.toHaveBeenCalled();
    expect(runAutomationForProject).toHaveBeenCalledTimes(1);
    expect(runAutomationForProject).toHaveBeenCalledWith({
      automationId: "automation-1",
      automationName: "Nightly sweep",
      projectId: "p1",
    });
  });

  it("still asks which Ticket for a record whose Trigger is not a schedule", async () => {
    // The other side of the same rule, so the branch cannot rot: only a
    // schedule takes the Project door.
    await mount({ automations: [automation()] });

    await act(async () => {
      button("Run Review sweep").click();
    });

    expect(document.body.textContent).toContain("Run “Review sweep” on");
    expect(runAutomationForProject).not.toHaveBeenCalled();
  });

  it("says a skip the app was open for did not claim the app was closed", async () => {
    // A sleeping machine is not a closed app, and the history must not say it
    // was: the reason recorded is what was observed.
    await mount({ skips: [skip({ reason: { kind: "not-observed" } })] });
    expect(text()).toContain("Skipped");
    expect(text()).toContain("Volli didn’t wake in time");
    expect(text()).not.toContain("Volli was closed");
  });

  it("prints a scheduled row's whole sentence, zone included", async () => {
    await mount({ automations: [automation({ trigger: NIGHTLY })] });
    // The stored zone is shown ALWAYS (VC-112) — a row that hid it would leave
    // a reader unable to tell whose 21:00 this is.
    const row = document.querySelector('[data-automation-rail-row="automation-1"]');
    expect(row?.textContent).toContain("Daily · 21:00 · Europe/London");
  });

  it("shows a Skipped occurrence in the Run history, never as a silence", async () => {
    await mount({
      automations: [automation({ trigger: NIGHTLY })],
      runs: [run({ createdAt: 1 })],
      skips: [skip({ dueAt: 5, missedCount: 3 })],
    });

    expect(text()).toContain("Nightly sweep");
    expect(text()).toContain("Skipped");
    expect(text()).toContain("Volli was closed");
    // One row per gap, saying how wide the gap was.
    expect(text()).toContain("3 occurrences");
    const row = document.querySelector('[data-run-history-skip="skip-1"]')!;
    expect(row).not.toBeNull();
    const reason = [...row.querySelectorAll("span")].find(
      (element) => element.textContent === "Skipped · Volli was closed · 3 occurrences",
    )!;
    expect(reason.classList.contains("block")).toBe(true);
    expect(reason.classList.contains("truncate")).toBe(false);
  });

  it("offers Run now on a skip, and starts ONE Run at the Project", async () => {
    await mount({ skips: [skip({ missedCount: 50 })] });

    await act(async () => {
      button("Run Nightly sweep now").click();
    });

    // Fifty missed occurrences, one Run: a missed occurrence is never replayed
    // (VC-112), and this is the by-hand recovery offered instead.
    expect(hasUiText("Skipped")).toBe(true);
    expect(vi.mocked(runAutomationForProject)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runAutomationForProject)).toHaveBeenCalledWith({
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

describe("editor navigation keeps drafts", () => {
  it("resumes a new draft after leaving the page, even when saved records exist", async () => {
    await mount({ automations: [automation()] });
    const newButton = [...document.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim() === "New automation",
    )!;
    await act(async () => newButton.click());
    await act(async () =>
      setInputValue(
        document.querySelector('[aria-label="Name"]') as HTMLInputElement,
        "Keep my idea",
      ),
    );
    await act(async () => root?.unmount());
    container?.remove();
    await mount({ automations: [automation()] });
    expect((document.querySelector('[aria-label="Name"]') as HTMLInputElement).value).toBe(
      "Keep my idea",
    );
    expect(document.querySelector('[data-slot="draft-resumed"]')?.textContent).toContain(
      "Draft restored",
    );
    clearEditorDraft("p1");
  });

  // VC-375. A new-record draft that survived a quit (its clear was still on the
  // debounce) put the page into create mode on EVERY arrival, and the saved
  // Automation could not be reached from the editor at all.
  it("does not re-persist a new draft it only restored", async () => {
    saveEditorDraft("p1", {
      name: "Resurrected",
      instructions: "/review",
      ownership: "project",
      triggerChoice: "none",
      columns: [],
      schedule: { preset: "daily", hour: 9, minute: 0, timeZone: "Europe/London" },
      runtime: null,
    });
    const setItem = vi.spyOn(appStateStorage, "setItem");
    await mount({ automations: [automation()] });
    // The arrival resumes it, as it is meant to.
    expect((document.querySelector('[aria-label="Name"]') as HTMLInputElement).value).toBe(
      "Resurrected",
    );

    // Nobody typed, so the arrival must write nothing. A draft that rewrites
    // itself on arrival is one no quit can ever age out.
    expect(setItem.mock.calls.filter(([key]) => key === "volli:automation-editor-draft")).toEqual(
      [],
    );

    // And a real keystroke still persists, so the elision is not a mute.
    await act(async () =>
      setInputValue(document.querySelector('[aria-label="Name"]') as HTMLInputElement, "Typed"),
    );
    expect(loadEditorDraft("p1")?.name).toBe("Typed");
    setItem.mockRestore();
    clearEditorDraft("p1");
  });

  it("hands the surface back to a saved record when a new draft is discarded", async () => {
    saveEditorDraft("p1", {
      name: "Resurrected",
      instructions: "/review",
      ownership: "project",
      triggerChoice: "none",
      columns: [],
      schedule: { preset: "daily", hour: 9, minute: 0, timeZone: "Europe/London" },
      runtime: null,
    });
    await mount({ automations: [automation()] });
    const discard = [...document.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim() === "Discard draft",
    );
    expect(discard).toBeDefined();

    await act(async () => discard?.click());
    // The create form is gone and the saved Automation owns the editor again,
    // so its Run control is reachable rather than stranded behind a blank form.
    expect(loadEditorDraft("p1")).toBeNull();
    expect(document.querySelector('[data-slot="automation-editor"] h2')?.textContent).toBe(
      "Review sweep",
    );
    expect(
      [...document.querySelectorAll("button")].some(
        (candidate) => candidate.getAttribute("aria-label") === "Run Review sweep",
      ),
    ).toBe(true);
    clearEditorDraft("p1", undefined, "automation-1");
  });

  it("keeps unsaved existing edits across Lanes and record switches", async () => {
    const records = [automation(), automation({ id: "second", name: "Other" })];
    await mount({ automations: records });
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>('[data-slot="automation-editor"] h2 button')
        ?.click(),
    );
    await act(async () =>
      setInputValue(
        document.querySelector('[aria-label="Name"]') as HTMLInputElement,
        "Unsaved name",
      ),
    );
    await openLanes();
    await act(async () =>
      [...document.querySelectorAll<HTMLButtonElement>("button")]
        .find((b) => b.textContent === "Automations")
        ?.click(),
    );
    await act(async () =>
      (document.querySelector('[data-automation-rail-row="second"]') as HTMLButtonElement).click(),
    );
    await act(async () =>
      (
        document.querySelector('[data-automation-rail-row="automation-1"]') as HTMLButtonElement
      ).click(),
    );
    expect((document.querySelector('[aria-label="Name"]') as HTMLInputElement).value).toBe(
      "Unsaved name",
    );
    expect(loadEditorDraft("p1", undefined, "automation-1")?.name).toBe("Unsaved name");
    clearEditorDraft("p1", undefined, "automation-1");
  });
});

describe("column arming trigger control", () => {
  it("lets an armed column enable automatic triggers without visiting the editor", async () => {
    await mount({
      automations: [automation({ trigger: { kind: "columns", columns: ["doing"] } })],
      armings: [{ projectId: "p1", status: "doing", automationId: "automation-1", armedAt: 1 }],
    });
    await openLanes();
    await openDropdown(button("Doing is armed with Review sweep — automatic triggers off"));
    await act(async () =>
      (document.querySelector('[data-slot="dropdown-menu-checkbox-item"]') as HTMLElement).click(),
    );
    expect(doors.setEnabled).toHaveBeenCalledWith(
      expect.objectContaining({ automationId: "automation-1", enabled: true }),
    );
  });
});

function buttonsNamed(name: string): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].filter(
    (node) => (node.getAttribute("aria-label") ?? node.textContent?.trim()) === name,
  );
}

describe("grouped reading navigation", () => {
  it("keeps name-only primary rows unique and exposes the compact return to schedules", async () => {
    await mount({
      automations: [
        automation({
          id: "doing",
          name: "Doing sweep",
          trigger: { kind: "columns", columns: ["doing"] },
        }),
        automation({
          id: "hourly",
          name: "Hourly sweep",
          trigger: {
            kind: "schedule",
            schedule: { preset: "hourly", minute: 17, timeZone: "UTC" },
          },
        }),
      ],
    });
    await act(async () => railRow("doing").click());
    expect(buttonsNamed("Doing sweep")).toHaveLength(1);
    expect(buttonsNamed("Hourly sweep")).toHaveLength(1);
    expect(buttonsNamed("Rename Doing sweep")).toHaveLength(1);
    expect(button("Rename Doing sweep").closest("h2")?.getAttribute("aria-label")).toBe(
      "Doing sweep",
    );
    await act(async () => button("All automations").click());
    expect(document.querySelector(".automations-surface")?.getAttribute("data-detail")).toBe(
      "false",
    );
    await act(async () => buttonsNamed("Hourly sweep")[0]!.click());
    expect(buttonsNamed("Hourly sweep")).toHaveLength(1);
    expect(buttonsNamed("Rename Hourly sweep")).toHaveLength(1);
    expect(button("Rename Hourly sweep").closest("h2")?.getAttribute("aria-label")).toBe(
      "Hourly sweep",
    );
  });

  it("keeps three recent occurrences and opens the real scoped All runs read", async () => {
    await mount({
      automations: [automation()],
      runs: Array.from({ length: 5 }, (_, n) => run({ id: `r-${n}`, createdAt: n + 1 })),
    });
    expect(historyRowIds("run")).toEqual(["r-4", "r-3", "r-2"]);
    await act(async () =>
      [...document.querySelectorAll<HTMLButtonElement>("button")]
        .find((b) => b.textContent === "All runs")
        ?.click(),
    );
    expect(historyRowIds("run")).toEqual(["r-4", "r-3", "r-2", "r-1", "r-0"]);
    expect(doors.runsForProject).not.toHaveBeenCalled();
  });
  it("filters names and visible triggers and retains the filter with zero matches", async () => {
    await mount({
      automations: Array.from({ length: 9 }, (_, n) =>
        automation({ id: `a-${n}`, name: `Review ${n}` }),
      ),
    });
    const field = button("Filter automations") as HTMLInputElement;
    await act(async () => setInputValue(field, "  REVIEW 3  "));
    expect(document.querySelectorAll("[data-automation-rail-row]")).toHaveLength(1);
    await act(async () => setInputValue(field, "not found"));
    expect(text()).toContain("No matching automations");
    expect(button("Filter automations")).toBe(field);
    await act(async () =>
      field.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    expect(document.querySelectorAll("[data-automation-rail-row]")).toHaveLength(9);
  });
  it("retains stale records but refuses Run after a failed coherent refresh", async () => {
    await mount({ automations: [automation()] });
    doors.list.mockResolvedValue({ ok: false, error: "Read unavailable" });
    await act(async () =>
      useBoardStore.setState((s) => ({
        lastPlanningChange: { ...s.lastPlanningChange, version: s.lastPlanningChange.version + 1 },
      })),
    );
    expect(text()).toContain("Couldn’t refresh automations");
    expect(railRow("automation-1")).not.toBeNull();
    expect((button("Run Review sweep") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("honest read states", () => {
  it("shows one failed-read recovery, never a successful empty claim", async () => {
    await mount({ failList: true });
    expect(text()).toContain("Couldn’t load automations");
    expect(text()).not.toContain("No automations yet");
    expect(
      [...document.querySelectorAll("button")].filter((b) => b.textContent === "Retry"),
    ).toHaveLength(1);
    expect((button("New automation menu") as HTMLButtonElement).disabled).toBe(true);
    doors.list.mockResolvedValue({ ok: true, automations: [] });
    await act(async () =>
      [...document.querySelectorAll<HTMLButtonElement>("button")]
        .find((b) => b.textContent === "Retry")
        ?.click(),
    );
    expect(text()).toContain("No automations yet");
  });
  it("retains historical rows after a refresh refusal and exposes Retry", async () => {
    await mount({ automations: [automation()], runs: [run()] });
    doors.runsForAutomation.mockResolvedValue({ ok: false, error: "History unavailable" });
    await act(async () =>
      useBoardStore.setState((s) => ({
        lastPlanningChange: { ...s.lastPlanningChange, version: s.lastPlanningChange.version + 1 },
      })),
    );
    expect(text()).toContain("Couldn’t load runs");
    expect(historyRun("run-1")).not.toBeNull();
    expect(historySection().textContent).not.toContain("No runs yet");
  });
});

it("opens the authored starter as a local draft, including when blank creation is already open", async () => {
  clearEditorDraft("p1");
  await mount({});
  await act(async () =>
    [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find((b) => b.textContent === "New automation")
      ?.click(),
  );
  await openDropdown(button("New automation menu"));
  await act(async () =>
    [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((b) => b.textContent === "Morning review")
      ?.click(),
  );
  expect((document.querySelector('[aria-label="Name"]') as HTMLInputElement).value).toBe(
    "Morning review",
  );
  expect(loadEditorDraft("p1")).toMatchObject({
    name: "Morning review",
    instructions: "/code-review\nFind regressions merged since yesterday.",
    triggerChoice: "schedule",
    schedule: { preset: "weekdays", timeZone: "Asia/Kuwait" },
  });
  expect(doors.create).not.toHaveBeenCalled();
  expect(doors.setEnabled).not.toHaveBeenCalled();
  clearEditorDraft("p1");
});
