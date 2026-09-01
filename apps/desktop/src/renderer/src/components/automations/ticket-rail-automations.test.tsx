// @vitest-environment jsdom
/**
 * The ticket rail's Automations block (VC-129): what one press starts, that the
 * control is there when the project lists nothing, and that this Ticket's Runs
 * are doors back to their Sessions.
 *
 * A real jsdom ENVIRONMENT rather than a static render, for the reason the
 * Automations page's own test states: the promises here are CLICKS — the split
 * button's default half, a Run once that starts an unbound Run, a history row
 * that opens a Session — and a static render would prove the markup and none of
 * them. It is also why the Run glue is mocked: where a Run LANDS is that
 * module's decision and is tested there; what this file owns is whether the
 * rail asks for the right one.
 */
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { NO_AUTOMATION_TRIGGER } from "@volli/shared";
import type { Automation, AutomationRun, ColumnArming, Ticket } from "@volli/shared";

import { openRunSession, runAutomationOnTicket } from "./run-automation";
import { TicketAutomationsPanel } from "./ticket-rail-automations";
import { ModelAccessProvider } from "@renderer/lib/model-access-client";
import { useAutomationsStore } from "@renderer/stores/automations";

vi.mock("./run-automation", () => ({
  openRunSession: vi.fn(),
  runAutomationOnTicket: vi.fn(() => Promise.resolve()),
}));

let root: Root | null = null;
let container: HTMLElement | null = null;

const TICKET = {
  id: "t1",
  projectId: "p1",
  ticketNumber: 6,
  title: "Calm Stack",
  body: "",
  status: "doing",
  priority: "medium",
  labels: [],
  usesWorktree: true,
  worktreePath: null,
  branch: null,
  baseBranch: null,
  createdAt: 1,
  updatedAt: 1,
} as unknown as Ticket;

function automation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: "a1",
    projectId: "p1",
    name: "Review sweep",
    instructions: "/review",
    trigger: { kind: "columns", columns: ["doing"] },
    runtime: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

const ARMING: ColumnArming = { projectId: "p1", status: "doing", automationId: "a1", armedAt: 5 };

function run(overrides: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id: "run-1",
    automationId: "a1",
    automationName: "Review sweep",
    ticketId: "t1",
    sessionId: "s1",
    model: { providerId: "anthropic", modelId: "claude-opus", reasoningLevel: "high" },
    attendance: "attended",
    createdAt: 10,
    ...overrides,
  };
}

const doors = {
  list: vi.fn(),
  armings: vi.fn(),
  enablement: vi.fn(),
  runsForTicket: vi.fn(),
};

/**
 * One available model with one reasoning level, so the per-invocation override
 * menu has something to offer. Without a catalog the override rows are
 * correctly absent, which would make the surface untestable rather than tested.
 */
const MODEL_ACCESS = {
  inspect: vi.fn(async () => ({
    providers: [{ id: "anthropic", label: "Anthropic" }],
    models: [
      {
        providerId: "anthropic",
        modelId: "claude-opus",
        label: "claude-opus",
        state: "available",
        reasoningLevels: ["high"],
      },
    ],
  })),
  hiddenModels: vi.fn(async () => []),
  defaults: vi.fn(),
  setDefault: vi.fn(),
  setHiddenModels: vi.fn(),
  compactionPolicy: vi.fn(),
  setCompactionPolicy: vi.fn(),
  beginSignIn: vi.fn(),
  signOut: vi.fn(),
} as unknown as React.ComponentProps<typeof ModelAccessProvider>["client"];

/** A read this test holds open, so the rail can be seen before it has landed. */
function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function render() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <ModelAccessProvider client={MODEL_ACCESS}>
        <TicketAutomationsPanel projectId="p1" ticket={TICKET} />
      </ModelAccessProvider>,
    );
  });
}

async function mount(seed: {
  automations?: Automation[];
  armings?: ColumnArming[];
  runs?: AutomationRun[];
  enabled?: string[];
}) {
  doors.list.mockResolvedValue({ ok: true, automations: seed.automations ?? [] });
  doors.armings.mockResolvedValue({ ok: true, armings: seed.armings ?? [] });
  doors.enablement.mockResolvedValue({ ok: true, enabledAutomationIds: seed.enabled ?? [] });
  doors.runsForTicket.mockResolvedValue({ ok: true, runs: seed.runs ?? [] });
  Object.defineProperty(window, "api", { configurable: true, value: { automations: doors } });

  await render();
}

function text(): string {
  return document.body.textContent ?? "";
}

function control(label: string): HTMLElement {
  const found = document.querySelector(`[aria-label="${label}"]`);
  if (found === null) throw new Error(`no control labelled ${label}`);
  return found as HTMLElement;
}

/** Open the caret menu — Radix mounts its content only once it is asked for. */
async function openMenu(): Promise<void> {
  await act(async () => {
    control("Other automations").dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, button: 0 }),
    );
  });
}

function menuItem(label: string): HTMLElement {
  const found = [...document.querySelectorAll('[data-slot="dropdown-menu-item"]')].find(
    (candidate) => candidate.textContent?.includes(label),
  );
  if (found === undefined) throw new Error(`no menu item named ${label}`);
  return found as HTMLElement;
}

/** Open a nested menu — where the per-invocation override lives (VC-112). */
async function openSubmenu(label: string): Promise<void> {
  const trigger = [...document.querySelectorAll('[data-slot="dropdown-menu-sub-trigger"]')].find(
    (candidate) => candidate.textContent?.includes(label),
  );
  if (trigger === undefined) throw new Error(`no submenu named ${label}`);
  await act(async () => {
    (trigger as HTMLElement).click();
  });
}

/** Type into the Run once form's controlled textarea the way React sees it. */
function typeInstructions(value: string): Promise<void> {
  const box = document.querySelector('[aria-label="Instructions"]') as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  return act(async () => {
    setter?.call(box, value);
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** The Run once form's own submit — the only control in the app labelled exactly "Run". */
function runButton(): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === "Run",
  );
  if (found === undefined) throw new Error("no Run button");
  return found;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  for (const door of Object.values(doors)) door.mockReset();
  vi.mocked(openRunSession).mockReset();
  vi.mocked(runAutomationOnTicket).mockReset();
  vi.mocked(runAutomationOnTicket).mockResolvedValue(undefined);
  useAutomationsStore.setState({
    byProject: {},
    armingByProject: {},
    runsByTicket: {},
    enabledIds: [],
    // `ensureLoaded` reads the machine-local set once per launch, so a stale
    // "already read" flag from a previous mount would leave every later case
    // asserting against the first one's answer.
    enablementRead: false,
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

describe("the split button", () => {
  it("presses the Armed automation of this Ticket's current column", async () => {
    await mount({ automations: [automation()], armings: [ARMING] });

    await act(async () => {
      control("Run Review sweep on this ticket").click();
    });

    expect(runAutomationOnTicket).toHaveBeenCalledWith({
      target: { kind: "automation", automationId: "a1" },
      ticketId: "t1",
      modelOverride: null,
    });
  });

  it("runs an Automation this column merely offers, from the menu", async () => {
    await mount({
      automations: [automation(), automation({ id: "a2", name: "Nightly sweep" })],
      armings: [ARMING],
    });

    await openMenu();
    await act(async () => {
      menuItem("Nightly sweep").click();
    });

    expect(runAutomationOnTicket).toHaveBeenCalledWith({
      target: { kind: "automation", automationId: "a2" },
      ticketId: "t1",
      modelOverride: null,
    });
  });

  it("offers a switched-off Automation and says so, rather than withholding it", async () => {
    // VC-112: running by hand is universal; the switch governs what starts an
    // Automation BESIDES a person.
    await mount({ automations: [automation()], armings: [ARMING] });

    await openMenu();

    expect(text()).toContain("Switched off");
    await act(async () => {
      menuItem("Review sweep").click();
    });
    expect(runAutomationOnTicket).toHaveBeenCalled();
  });

  it("drops that note once the Automation is switched on here", async () => {
    await mount({ automations: [automation()], armings: [ARMING], enabled: ["a1"] });

    await openMenu();

    expect(text()).not.toContain("Switched off");
  });

  it("presses Run once where the column arms nothing", async () => {
    await mount({ automations: [automation()] });

    await act(async () => {
      control("Run Run once on this ticket").click();
    });

    // The press opens the form rather than starting anything: an Unbound Run
    // has to be typed before it can run.
    expect(runAutomationOnTicket).not.toHaveBeenCalled();
    expect(document.querySelector('[aria-label="Instructions"]')).not.toBeNull();
  });

  it("stays visible with no automations at all, says so, and links to the page", async () => {
    await mount({});

    expect(control("Run Run once on this ticket")).not.toBeNull();
    expect(text()).toContain("No automations in this project yet.");
  });

  it("presses nothing, and claims nothing, until its own reads have landed", async () => {
    // The race the rail must not lose: this Ticket's column IS armed, and for
    // the frame before the read lands an ungated rail would offer a clickable
    // Run once instead — or, from a cache filled elsewhere, press whatever was
    // armed then.
    const list = deferred<{ ok: true; automations: Automation[] }>();
    doors.list.mockReturnValue(list.promise);
    doors.armings.mockResolvedValue({ ok: true, armings: [ARMING] });
    doors.enablement.mockResolvedValue({ ok: true, enabledAutomationIds: [] });
    doors.runsForTicket.mockResolvedValue({ ok: true, runs: [] });
    Object.defineProperty(window, "api", { configurable: true, value: { automations: doors } });
    await render();

    const reading = control("Reading automations…") as HTMLButtonElement;
    expect(reading.disabled).toBe(true);
    await act(async () => {
      reading.click();
    });
    expect(runAutomationOnTicket).not.toHaveBeenCalled();
    // Not the Run once form either: an unread rail starts nothing on a press.
    expect(document.querySelector('[aria-label="Instructions"]')).toBeNull();
    // And no claim about the project, which it has not read.
    expect(text()).not.toContain("No automations in this project yet.");

    await act(async () => {
      list.resolve({ ok: true, automations: [automation()] });
    });

    expect(control("Run Review sweep on this ticket")).not.toBeNull();
  });

  it("does not press an arming this rail inherited from an earlier read", async () => {
    // A cache filled before someone re-armed the column in another window. The
    // rail re-reads on arrival, and until that read lands it presses nothing:
    // "nothing armed" and "not asked yet" are one value in the cache.
    useAutomationsStore.setState({
      byProject: { p1: [automation()] },
      armingByProject: { p1: [ARMING] },
      enablementRead: true,
    });
    const list = deferred<{ ok: true; automations: Automation[] }>();
    doors.list.mockReturnValue(list.promise);
    doors.armings.mockResolvedValue({ ok: true, armings: [] });
    doors.enablement.mockResolvedValue({ ok: true, enabledAutomationIds: [] });
    doors.runsForTicket.mockResolvedValue({ ok: true, runs: [] });
    Object.defineProperty(window, "api", { configurable: true, value: { automations: doors } });
    await render();

    expect(document.querySelector('[aria-label="Run Review sweep on this ticket"]')).toBeNull();
    expect(control("Reading automations…")).not.toBeNull();

    // The read lands on the truth: nothing arms this column any more.
    await act(async () => {
      list.resolve({ ok: true, automations: [automation()] });
    });
    expect(control("Run Run once on this ticket")).not.toBeNull();
  });

  it("does not press a stale arming its re-read FAILED to replace", async () => {
    // The warm-cache half of the same rule. The caches have landed, so
    // `selectPlanningLoaded` is true and stays true — a failed read toasts and
    // leaves the old value exactly where it was. If the rail counted a settled
    // read as a read, the arming this column dropped an hour ago in another
    // window would become pressable the moment the toast appeared.
    useAutomationsStore.setState({
      byProject: { p1: [automation()] },
      armingByProject: { p1: [ARMING] },
      enablementRead: true,
    });
    doors.list.mockResolvedValue({ ok: true, automations: [automation()] });
    doors.armings.mockResolvedValue({ ok: false, error: "database is locked" });
    doors.enablement.mockResolvedValue({ ok: true, enabledAutomationIds: [] });
    doors.runsForTicket.mockResolvedValue({ ok: true, runs: [] });
    Object.defineProperty(window, "api", { configurable: true, value: { automations: doors } });
    await render();

    // Landed caches, and still nothing to press: the rail says what it knows.
    expect(useAutomationsStore.getState().armingByProject.p1).toEqual([ARMING]);
    expect(document.querySelector('[aria-label="Run Review sweep on this ticket"]')).toBeNull();
    const reading = control("Reading automations…") as HTMLButtonElement;
    expect(reading.disabled).toBe(true);

    await act(async () => {
      reading.click();
    });
    expect(runAutomationOnTicket).not.toHaveBeenCalled();
    expect(document.querySelector('[aria-label="Instructions"]')).toBeNull();
  });

  it("holds no authoring form: nothing here creates, edits or deletes a record", async () => {
    await mount({ automations: [automation()], armings: [ARMING] });
    await openMenu();

    expect(text()).not.toContain("New Automation");
    expect(text()).not.toContain("Edit");
    expect(text()).not.toContain("Duplicate");
    expect(text()).not.toContain("Delete");
    expect(useAutomationsStore.getState().editor).toBeNull();
  });
});

describe("Run once", () => {
  async function openRunOnce(): Promise<void> {
    await mount({ automations: [automation()], armings: [ARMING] });
    await openMenu();
    await act(async () => {
      menuItem("Run once").click();
    });
  }

  it("uses the dialog-footer size for both actions", async () => {
    await openRunOnce();

    const cancel = [...document.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === "Cancel",
    );
    expect(cancel?.dataset.size).toBe("sm");
    expect(runButton().dataset.size).toBe("sm");
  });

  it("refuses to start with nothing to say", async () => {
    await openRunOnce();

    expect(runButton().disabled).toBe(true);
    await typeInstructions("   ");
    expect(runButton().disabled).toBe(true);
  });

  it("starts an unbound Run that names no Automation", async () => {
    await openRunOnce();
    await typeInstructions("/review the diff once");

    await act(async () => {
      runButton().click();
    });

    expect(runAutomationOnTicket).toHaveBeenCalledWith({
      target: { kind: "unbound", instructions: "/review the diff once" },
      ticketId: "t1",
      modelOverride: null,
    });
    // Nothing was saved on the way: no record write door was touched, so there
    // is nothing afterwards to name, disable or delete (VC-112).
    expect(useAutomationsStore.getState().editor).toBeNull();
  });

  it("offers this invocation its own Runtime, defaulting to the resolved one", async () => {
    await openRunOnce();

    // The choice exists and rests on inherit — the override is per invocation
    // and is stored nowhere, so "Default model" is the resting answer.
    expect(text()).toContain("Default model");
    expect(text()).toContain("This run");
  });

  it("opens holding the model the nested override named, and runs on it", async () => {
    // A column with nothing armed: the default press IS Run once, so choosing
    // "Run on model ▸ claude-opus" is a person choosing the Runtime for the Run
    // they are about to describe. The form must open already holding it.
    await mount({ automations: [automation()] });
    await openMenu();
    await openSubmenu("Run on model");
    await act(async () => {
      menuItem("claude-opus").click();
    });

    expect(document.querySelector('[aria-label="Instructions"]')).not.toBeNull();
    await typeInstructions("/sweep this once");
    await act(async () => {
      runButton().click();
    });

    expect(runAutomationOnTicket).toHaveBeenCalledWith({
      target: { kind: "unbound", instructions: "/sweep this once" },
      ticketId: "t1",
      modelOverride: {
        providerId: "anthropic",
        modelId: "claude-opus",
        reasoningLevel: "high",
      },
    });
  });
});

describe("the per-invocation override", () => {
  it("spends the model it names on the Armed automation's own Run", async () => {
    await mount({ automations: [automation()], armings: [ARMING] });
    await openMenu();
    await openSubmenu("Run on model");
    await act(async () => {
      menuItem("claude-opus").click();
    });

    expect(runAutomationOnTicket).toHaveBeenCalledWith({
      target: { kind: "automation", automationId: "a1" },
      ticketId: "t1",
      modelOverride: {
        providerId: "anthropic",
        modelId: "claude-opus",
        reasoningLevel: "high",
      },
    });
  });
});

describe("this Ticket's Runs", () => {
  it("lists them newest first, each naming the model it resolved", async () => {
    await mount({
      runs: [
        run({ id: "run-2", automationName: "Newest", createdAt: 200 }),
        run({ id: "run-1", automationName: "Oldest", createdAt: 100 }),
      ],
    });

    expect(text()).toContain("claude-opus · high");
    expect(text().indexOf("Newest")).toBeLessThan(text().indexOf("Oldest"));
  });

  it("names an Unbound Run rather than leaving its row anonymous", async () => {
    await mount({ runs: [run({ automationId: null, automationName: null })] });

    expect(text()).toContain("Run once");
  });

  it("is a door back to the Session the Run opened", async () => {
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

  it("draws no list before anything has run on this Ticket", async () => {
    await mount({ automations: [automation({ trigger: NO_AUTOMATION_TRIGGER })] });

    expect(document.querySelector('[data-testid="ticket-rail-runs"]')).toBeNull();
  });
});
