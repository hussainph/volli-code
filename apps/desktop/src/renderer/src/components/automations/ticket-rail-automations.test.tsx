// @vitest-environment jsdom
/**
 * The ticket rail's Automations block (VC-129/VC-406): what the list offers,
 * what a row's press starts, and that the block is there when the project
 * lists nothing.
 *
 * A real jsdom ENVIRONMENT rather than a static render, for the reason the
 * Automations page's own test states: the promises here are CLICKS — a row
 * that runs, an override chosen from a row's own menu — and a static render
 * would prove the markup and none of them. It is also why the Run glue is mocked: where a Run LANDS is that
 * module's decision and is tested there; what this file owns is whether the
 * rail asks for the right one.
 */
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Automation, ColumnArming, Ticket } from "@volli/shared";

import { runAutomationOnTicket } from "./run-automation";
import { TicketAutomationsPanel } from "./ticket-rail-automations";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { ModelAccessProvider } from "@renderer/lib/model-access-client";
import { useAutomationsStore } from "@renderer/stores/automations";
import { useProjectsStore } from "@renderer/stores/projects";
import { useWorkspaceStore } from "@renderer/stores/workspace";

vi.mock("./run-automation", () => ({
  runAutomationOnTicket: vi.fn(() => Promise.resolve()),
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

const doors = {
  list: vi.fn(),
  armings: vi.fn(),
  enablement: vi.fn(),
  columnOrders: vi.fn(),
};

/**
 * One available model with two reasoning levels, so the per-invocation
 * override has both model and effort choices to expose. Without a catalog the
 * override rows are correctly absent, which would make the surface untestable
 * rather than tested.
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
        reasoningLevels: ["low", "high"],
      },
    ],
  })),
  hiddenModels: vi.fn(async () => []),
  defaults: vi.fn(),
  setDefault: vi.fn(),
  setHiddenModels: vi.fn(),
  compactionPolicy: vi.fn(),
  setCompactionPolicy: vi.fn(),
  pickerView: vi.fn(),
  setPickerView: vi.fn(),
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
      // The header's door wears a tooltip, which needs the provider the app
      // root mounts once.
      <TooltipProvider>
        <ModelAccessProvider client={MODEL_ACCESS}>
          <TicketAutomationsPanel projectId="p1" ticket={TICKET} />
        </ModelAccessProvider>
      </TooltipProvider>,
    );
  });
}

async function mount(seed: {
  automations?: Automation[];
  armings?: ColumnArming[];
  enabled?: string[];
}) {
  doors.list.mockResolvedValue({ ok: true, automations: seed.automations ?? [] });
  doors.armings.mockResolvedValue({ ok: true, armings: seed.armings ?? [] });
  doors.enablement.mockResolvedValue({ ok: true, enabledAutomationIds: seed.enabled ?? [] });
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

/** Every offered row, in the order the list draws them. */
function rows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[data-testid="ticket-rail-automation-row"]')];
}

/** One offered row, by the Automation it names. */
function row(name: string): HTMLElement {
  const found = rows().find((candidate) => candidate.textContent?.includes(name));
  if (found === undefined) throw new Error(`no row named ${name}`);
  return found;
}

/** Open a row's context menu — where the per-invocation override lives (VC-112). */
async function openRowMenu(name: string): Promise<void> {
  await act(async () => {
    row(name).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, button: 2 }));
  });
}

function menuItem(label: string): HTMLElement {
  const found = [...document.querySelectorAll('[data-slot="context-menu-item"]')].find(
    (candidate) => candidate.textContent?.includes(label),
  );
  if (found === undefined) throw new Error(`no menu item named ${label}`);
  return found as HTMLElement;
}

/** Open a nested menu — where the per-invocation override lives (VC-112). */
async function openSubmenu(label: string): Promise<void> {
  const trigger = [...document.querySelectorAll('[data-slot="context-menu-sub-trigger"]')].find(
    (candidate) => candidate.textContent?.includes(label),
  );
  if (trigger === undefined) throw new Error(`no submenu named ${label}`);
  await act(async () => {
    (trigger as HTMLElement).click();
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  for (const door of Object.values(doors)) door.mockReset();
  doors.columnOrders.mockResolvedValue({ ok: true, orders: [] });
  vi.mocked(runAutomationOnTicket).mockReset();
  vi.mocked(runAutomationOnTicket).mockResolvedValue(undefined);
  useProjectsStore.setState({ projects: [PROJECT], selectedProjectId: "p1" });
  useWorkspaceStore.setState({ byProject: {} });
  useAutomationsStore.setState({
    byProject: {},
    armingByProject: {},
    enabledIds: [],
    // `ensureLoaded` reads the machine-local set once per launch, so a stale
    // "already read" flag from a previous mount would leave every later case
    // asserting against the first one's answer.
    enablementRead: false,
    // A landed rail version from an earlier mount would let this case answer
    // from a cache the `beforeEach` above just cleared (VC-373).
    railReadAt: {},
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

describe("the offer list", () => {
  it("draws every column's work as a row, not behind a caret (VC-406)", async () => {
    await mount({
      automations: [automation({ trigger: { kind: "columns", columns: ["needs_review"] } })],
    });

    // The list IS the answer to "what can I run here". It used to be one split
    // button naming this column's armed record, with every other column's work
    // reachable only by opening a caret a reader had no reason to suspect.
    expect(rows()).toHaveLength(1);
    // Switched off in this mount (no `enabled`), so the name carries the note.
    expect(row("Review sweep").getAttribute("aria-label")).toBe(
      "Run Review sweep on this ticket (manual only)",
    );
    // Each row names the column that offers it, so a hand-run across lanes is
    // readable without a heading per column.
    expect(text()).toContain("Needs Review");
    // And running it is the row's own press — no menu in the way.
    await act(async () => {
      row("Review sweep").click();
    });

    expect(runAutomationOnTicket).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { kind: "automation", automationId: "a1" },
        ticketId: "t1",
        modelOverride: null,
      }),
    );
    // A hand-run moves nothing: the Ticket stays in the column it was in.
    expect(TICKET.status).toBe("doing");
  });

  it("marks this column's Armed automation, and leads with it", async () => {
    await mount({
      automations: [
        automation({
          id: "a2",
          name: "Nightly sweep",
          trigger: { kind: "columns", columns: ["done"] },
        }),
        automation(),
      ],
      armings: [ARMING],
    });

    // This Ticket's own column first, and inside it the armed record says so
    // rather than repeating the status pill two blocks up.
    const [first, second] = rows();
    expect(first?.textContent).toContain("Review sweep");
    expect(first?.dataset.armed).toBe("true");
    expect(first?.textContent).toContain("Armed");
    expect(second?.textContent).toContain("Nightly sweep");
    expect(second?.dataset.armed).toBeUndefined();
    expect(second?.textContent).toContain("Done");
  });

  it("presses the Armed automation of this Ticket's current column", async () => {
    await mount({ automations: [automation()], armings: [ARMING] });

    await act(async () => {
      row("Review sweep").click();
    });

    expect(runAutomationOnTicket).toHaveBeenCalledWith({
      target: { kind: "automation", automationId: "a1" },
      automationName: "Review sweep",
      ticketId: "t1",
      ticketDisplayId: "VC-6",
      modelOverride: null,
    });
  });

  it("runs an Automation this column merely offers", async () => {
    await mount({
      automations: [automation(), automation({ id: "a2", name: "Nightly sweep" })],
      armings: [ARMING],
    });

    await act(async () => {
      row("Nightly sweep").click();
    });

    expect(runAutomationOnTicket).toHaveBeenCalledWith({
      target: { kind: "automation", automationId: "a2" },
      automationName: "Nightly sweep",
      ticketId: "t1",
      ticketDisplayId: "VC-6",
      modelOverride: null,
    });
  });

  it("caps its own height instead of growing with the project", async () => {
    await mount({
      automations: Array.from({ length: 12 }, (_, index) =>
        automation({ id: `a${index}`, name: `Sweep ${index}` }),
      ),
    });

    // Twelve rows, all of them present and reachable — bounded by a scroller
    // rather than by hiding eleven of them. The cap is what keeps the roster
    // under this block from being pushed off the resting view.
    expect(rows()).toHaveLength(12);
    const list = document.querySelector('[data-testid="ticket-rail-automation-list"]');
    expect(list?.className).toContain("max-h-40");
    expect(list?.className).toContain("overflow-y-auto");
  });

  it("offers a switched-off Automation with a slashed bolt, rather than withholding it", async () => {
    // VC-112: running by hand is universal; the switch governs what starts an
    // Automation BESIDES a person. VC-406 moved the note off the row's face —
    // `Manual only · Doing` cost the name half its width — and into the bolt,
    // the hover title and the accessible name.
    await mount({ automations: [automation()], armings: [ARMING] });

    const offered = row("Review sweep");
    expect(offered.dataset.triggers).toBe("off");
    expect(offered.getAttribute("aria-label")).toBe(
      "Run Review sweep on this ticket (manual only)",
    );
    expect(offered.getAttribute("title")).toBe("Review sweep — Manual only · Armed");
    // The right edge says ONE thing.
    expect(offered.textContent).toBe("Review sweepArmed");
    await act(async () => {
      offered.click();
    });
    expect(runAutomationOnTicket).toHaveBeenCalled();
  });

  it("wears a plain bolt once the Automation is switched on here", async () => {
    await mount({ automations: [automation()], armings: [ARMING], enabled: ["a1"] });

    const offered = row("Review sweep");
    expect(offered.dataset.triggers).toBe("on");
    expect(offered.getAttribute("aria-label")).toBe("Run Review sweep on this ticket");
    expect(offered.getAttribute("title")).toBe("Review sweep — Armed");
  });

  it("keeps the name a floor so the qualifier cannot outlive it", async () => {
    await mount({ automations: [automation()], armings: [ARMING] });

    const name = row("Review sweep").querySelector("span.truncate");
    expect(name?.className).toContain("min-w-24");
  });

  it("offers no Run once, and no stand-in press, where the column arms nothing (VC-406)", async () => {
    await mount({ automations: [automation()] });

    // Nothing is marked Armed, and there is no button under the list: the
    // block ends where its last row does. A one-off is `+ Chat` and typing.
    expect(rows()[0]?.dataset.armed).toBeUndefined();
    expect(document.querySelector('[data-testid="ticket-rail-run-once"]')).toBeNull();
    expect(text()).not.toContain("Run once");
    expect(
      document.querySelectorAll('[data-testid="ticket-rail-automations"] button'),
    ).toHaveLength(
      // The page door, and one activation target per row.
      1 + rows().length,
    );
  });

  it("keeps its page door in the heading row, at every state", async () => {
    await mount({});

    expect(text()).toContain("No automations in this project yet.");

    const panel = document.querySelector('[data-testid="ticket-rail-automations"]');
    const heading = panel?.querySelector("h2");
    const door = control("Open Automations");
    expect(heading?.textContent).toBe("Automations");
    // VC-257 is a layout change: the heading and door must be siblings in the
    // shared heading row, not merely somewhere inside the same rail panel.
    expect(door.parentElement).toBe(heading?.parentElement);
    // The empty sentence is a report, never a second door under that row.
    expect(panel?.querySelector("a")).toBeNull();
    expect(
      [...(panel?.querySelectorAll("button") ?? [])].filter(
        (candidate) => candidate.textContent === "Automations",
      ),
    ).toHaveLength(0);

    await act(async () => {
      door.click();
    });
    expect(useWorkspaceStore.getState().byProject.p1?.nav).toBe("automations");
  });

  it("keeps that door when the project HAS automations to arrange", async () => {
    // It used to be the empty state's consolation prize, which left the one
    // reader who could not reach the page from here as the one whose project
    // has lanes to arrange (VC-406).
    await mount({ automations: [automation()], armings: [ARMING] });

    expect(document.querySelector('[aria-label="Open Automations"]')).not.toBeNull();
  });

  it("does not claim an empty state before reads land", async () => {
    const list = deferred<{ ok: true; automations: Automation[] }>();
    doors.list.mockReturnValue(list.promise);
    doors.armings.mockResolvedValue({ ok: true, armings: [] });
    doors.enablement.mockResolvedValue({ ok: true, enabledAutomationIds: [] });
    Object.defineProperty(window, "api", { configurable: true, value: { automations: doors } });
    await render();

    expect(text()).not.toContain("No automations in this project yet.");
    // The wait is drawn as rows, not as a sentence (VC-406): two skeleton rows
    // before anything has been read, so the first read moves as little as it
    // can and a re-read moves nothing.
    expect(text()).not.toContain("Reading automations…");
    const unread = document.querySelector('[data-testid="ticket-rail-automations-unread"]');
    expect(unread).not.toBeNull();
    expect(unread?.getAttribute("aria-busy")).toBe("true");
    expect(unread?.children).toHaveLength(2);
  });

  it("lists nothing, and claims nothing, until its own reads have landed", async () => {
    // The race the rail must not lose: this Ticket's column IS armed, and for
    // the frame before the read lands an ungated rail would draw rows from
    // whatever a cache filled elsewhere happened to hold.
    const list = deferred<{ ok: true; automations: Automation[] }>();
    doors.list.mockReturnValue(list.promise);
    doors.armings.mockResolvedValue({ ok: true, armings: [ARMING] });
    doors.enablement.mockResolvedValue({ ok: true, enabledAutomationIds: [] });
    Object.defineProperty(window, "api", { configurable: true, value: { automations: doors } });
    await render();

    expect(rows()).toHaveLength(0);
    expect(document.querySelector('[data-testid="ticket-rail-automations-unread"]')).not.toBeNull();
    // And no claim about the project, which it has not read.
    expect(text()).not.toContain("No automations in this project yet.");

    await act(async () => {
      list.resolve({ ok: true, automations: [automation()] });
    });

    expect(row("Review sweep").dataset.armed).toBe("true");
  });

  it("does not list an arming this rail inherited from an earlier read", async () => {
    // A cache filled before someone re-armed the column in another window. The
    // rail re-reads on arrival, and until that read lands it lists nothing:
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
    Object.defineProperty(window, "api", { configurable: true, value: { automations: doors } });
    await render();

    expect(rows()).toHaveLength(0);
    expect(document.querySelector('[data-testid="ticket-rail-automations-unread"]')).not.toBeNull();

    // The read lands on the truth: nothing arms this column any more.
    await act(async () => {
      list.resolve({ ok: true, automations: [automation()] });
    });
    expect(row("Review sweep").dataset.armed).toBeUndefined();
  });

  it("does not mark a stale arming its re-read FAILED to replace", async () => {
    // The warm-cache half of the same rule. The caches have landed, so
    // `selectPlanningLoaded` is true and stays true — a failed read toasts and
    // leaves the old value exactly where it was. If the rail counted a settled
    // read as a read, the arming this column dropped an hour ago in another
    // window would be drawn as this column's default.
    useAutomationsStore.setState({
      byProject: { p1: [automation()] },
      armingByProject: { p1: [ARMING] },
      enablementRead: true,
    });
    doors.list.mockResolvedValue({ ok: true, automations: [automation()] });
    doors.armings.mockResolvedValue({ ok: false, error: "database is locked" });
    doors.enablement.mockResolvedValue({ ok: true, enabledAutomationIds: [] });
    Object.defineProperty(window, "api", { configurable: true, value: { automations: doors } });
    await render();

    // Landed caches, and still nothing listed: the rail says what it knows.
    expect(useAutomationsStore.getState().armingByProject.p1).toEqual([ARMING]);
    expect(rows()).toHaveLength(0);
    expect(document.querySelector('[data-testid="ticket-rail-automations-unread"]')).not.toBeNull();
    expect(runAutomationOnTicket).not.toHaveBeenCalled();
  });

  it("holds no authoring form: nothing here creates, edits or deletes a record", async () => {
    await mount({ automations: [automation()], armings: [ARMING] });
    await openRowMenu("Review sweep");

    expect(text()).not.toContain("New Automation");
    expect(text()).not.toContain("Edit");
    expect(text()).not.toContain("Duplicate");
    expect(text()).not.toContain("Delete");
    expect(useAutomationsStore.getState().editor).toBeNull();
  });
});

describe("the per-invocation override", () => {
  it("spends the model it names on that row's own Run", async () => {
    await mount({ automations: [automation()], armings: [ARMING] });
    await openRowMenu("Review sweep");
    await openSubmenu("Run on model");
    await openSubmenu("claude-opus");
    await act(async () => {
      menuItem("high").click();
    });

    expect(runAutomationOnTicket).toHaveBeenCalledWith({
      target: { kind: "automation", automationId: "a1" },
      automationName: "Review sweep",
      ticketId: "t1",
      ticketDisplayId: "VC-6",
      modelOverride: {
        providerId: "anthropic",
        modelId: "claude-opus",
        reasoningLevel: "high",
      },
    });
  });

  it("is reachable on a row this column merely offers, not only on the Armed one", async () => {
    // Strictly more than the caret offered: that menu could only re-run the
    // split button's own default on another model, so choosing a model for any
    // other column's Automation meant running it first and changing it never.
    await mount({
      automations: [
        automation(),
        automation({
          id: "a2",
          name: "Nightly sweep",
          trigger: { kind: "columns", columns: ["done"] },
        }),
      ],
      armings: [ARMING],
    });
    await openRowMenu("Nightly sweep");
    await openSubmenu("Run on model");
    await openSubmenu("claude-opus");
    await act(async () => {
      menuItem("high").click();
    });

    expect(runAutomationOnTicket).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { kind: "automation", automationId: "a2" },
        modelOverride: {
          providerId: "anthropic",
          modelId: "claude-opus",
          reasoningLevel: "high",
        },
      }),
    );
  });
});
