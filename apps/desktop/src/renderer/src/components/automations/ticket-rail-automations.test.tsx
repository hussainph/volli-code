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

import { runAutomationOnTicket, type AutomationRunOutcome } from "./run-automation";
import { TicketAutomationsPanel } from "./ticket-rail-automations";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { ModelAccessProvider } from "@renderer/lib/model-access-client";
import { useAutomationsStore } from "@renderer/stores/automations";
import { useProjectsStore } from "@renderer/stores/projects";
import { useWorkspaceStore } from "@renderer/stores/workspace";

vi.mock("./run-automation", () => ({
  runAutomationOnTicket: vi.fn(() => Promise.resolve("started")),
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

/** Draw the panel for one project into the current root — again, for a switch. */
async function paint(projectId: string): Promise<void> {
  await act(async () => {
    root?.render(
      // The header's door wears a tooltip, which needs the provider the app
      // root mounts once.
      <TooltipProvider>
        <ModelAccessProvider client={MODEL_ACCESS}>
          <TicketAutomationsPanel projectId={projectId} ticket={TICKET} />
        </ModelAccessProvider>
      </TooltipProvider>,
    );
  });
}

async function render(projectId = "p1") {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await paint(projectId);
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

/** Radix opens a popover trigger on click, and a dropdown on pointerdown. */
async function press(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    element.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, button: 0 }));
    element.click();
  });
}

/** Open a row's inspection — the one surface both press routes reach (VC-406). */
async function inspect(name: string): Promise<void> {
  await press(row(name));
}

/** Right-click a row. The same inspection, and still no launch. */
async function rightClick(name: string): Promise<void> {
  await act(async () => {
    row(name).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, button: 2 }));
  });
}

/** The open inspection, or `null`. */
function inspection(): HTMLElement | null {
  return document.querySelector('[data-testid="ticket-rail-automation-inspect"]');
}

/** The body's refused-first-read frame, or `null`. */
function fault(): HTMLElement | null {
  return document.querySelector('[data-testid="ticket-rail-automations-error"]');
}

/** The eyebrow's caveat about a read that happened over rows, or `null`. */
function readStatus(): HTMLElement | null {
  return document.querySelector('[data-testid="ticket-rail-automations-read-status"]');
}

/** The skeleton the block draws only when it has nothing to retain. */
function skeleton(): HTMLElement | null {
  return document.querySelector('[data-testid="ticket-rail-automations-unread"]');
}

/** Press one of the block's own retry controls (heading mark, or body frame). */
async function pressRetry(scope: HTMLElement): Promise<void> {
  const button = scope.querySelector("button");
  if (button === null) throw new Error("no retry control");
  await press(button);
}

/**
 * Move the planning clock past every rail cache, the way a board move does:
 * the next render's read is no longer answered by what these slices hold.
 */
function stalePlanningClock(): void {
  useAutomationsStore.setState({ railReadAt: {} });
}

/** The inspection's explicit Run control. */
function runButton(): HTMLButtonElement {
  const found = document.querySelector<HTMLButtonElement>(
    '[data-testid="ticket-rail-automation-run"]',
  );
  if (found === null) throw new Error("the inspection has no Run control");
  return found;
}

/** One row of an open dropdown, by the words on its face. */
function menuItem(label: string): HTMLElement {
  const found = [...document.querySelectorAll('[data-slot="dropdown-menu-radio-item"]')].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (found === undefined) throw new Error(`no menu item named ${label}`);
  return found as HTMLElement;
}

async function choose(label: string): Promise<void> {
  const item = menuItem(label);
  await act(async () => {
    item.dispatchEvent(new MouseEvent("pointermove", { bubbles: true }));
    item.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    item.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, button: 0 }));
    item.click();
  });
}

/** A launch this test holds open, so the pending gate can be seen mid-flight. */
function heldLaunch(): { resolve(outcome: AutomationRunOutcome): Promise<void> } {
  let settle!: (outcome: AutomationRunOutcome) => void;
  vi.mocked(runAutomationOnTicket).mockImplementation(
    () =>
      new Promise<AutomationRunOutcome>((resolveLaunch) => {
        settle = resolveLaunch;
      }),
  );
  return {
    resolve: async (outcome) => {
      await act(async () => {
        settle(outcome);
      });
    },
  };
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  for (const door of Object.values(doors)) door.mockReset();
  doors.columnOrders.mockResolvedValue({ ok: true, orders: [] });
  vi.mocked(runAutomationOnTicket).mockReset();
  vi.mocked(runAutomationOnTicket).mockResolvedValue("started");
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
    // The press OPENS the record; it does not spend a Session on it (VC-406).
    expect(row("Review sweep").getAttribute("aria-label")).toBe("Inspect Review sweep");
    // Each row names the column that offers it, so a hand-run across lanes is
    // readable without a heading per column.
    expect(text()).toContain("Needs Review");
    // And the launch is the inspection's own explicit, labelled act.
    await inspect("Review sweep");
    expect(runAutomationOnTicket).not.toHaveBeenCalled();
    await press(runButton());

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

    await inspect("Review sweep");
    await press(runButton());

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

    await inspect("Nightly sweep");
    await press(runButton());

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
    expect(offered.getAttribute("aria-label")).toBe("Inspect Review sweep");
    expect(offered.getAttribute("title")).toBe("Review sweep — Armed · Doing · Manual only");
    // The right edge says ONE thing.
    expect(offered.textContent).toBe("Review sweepArmed");
    await inspect("Review sweep");
    await press(runButton());
    expect(runAutomationOnTicket).toHaveBeenCalled();
  });

  it("wears a plain bolt once the Automation is switched on here", async () => {
    await mount({ automations: [automation()], armings: [ARMING], enabled: ["a1"] });

    const offered = row("Review sweep");
    expect(offered.dataset.triggers).toBe("on");
    expect(offered.getAttribute("aria-label")).toBe("Inspect Review sweep");
    expect(offered.getAttribute("title")).toBe("Review sweep — Armed · Doing");
  });

  it("keeps the name a floor, and makes the qualifier yield first", async () => {
    await mount({ automations: [automation()], armings: [ARMING] });

    const offered = row("Review sweep");
    const name = offered.querySelector("span.truncate");
    expect(name?.className).toContain("min-w-24");
    // One qualifier, and it is the half of the row that gives way: at the
    // 240px floor the column's own words are what a reader can afford to lose.
    const qualifier = offered.lastElementChild;
    expect(qualifier?.textContent).toBe("Armed");
    expect(qualifier?.className).toContain("max-w-20");
    expect(qualifier?.className).toContain("truncate");
    expect(qualifier?.className).not.toContain("shrink-0");
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
    // VC-257 is a layout change: the heading and the door must share the
    // shared heading ROW, not merely sit somewhere inside the same rail panel.
    // (The label and the block's read mark share a span inside that row, so
    // the door is the row's child rather than the heading's sibling.)
    const headingRow = heading?.closest("div") ?? null;
    expect(headingRow).not.toBeNull();
    expect(door.parentElement).toBe(headingRow);
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

    // Landed caches, and still nothing listed: this mount has read nothing
    // ITSELF, and a slice another surface filled is not a snapshot it may draw
    // rows from — least of all one whose arming half just failed to land.
    expect(useAutomationsStore.getState().armingByProject.p1).toEqual([ARMING]);
    expect(rows()).toHaveLength(0);
    // The refused read says so, with the one press that retries it, instead of
    // a skeleton that waits for a read nobody is going to make (VC-406).
    expect(fault()).not.toBeNull();
    expect(document.querySelector('[data-testid="ticket-rail-automations-unread"]')).toBeNull();
    expect(runAutomationOnTicket).not.toHaveBeenCalled();
  });

  it("holds no authoring form: nothing here creates, edits or deletes a record", async () => {
    await mount({ automations: [automation()], armings: [ARMING] });
    await rightClick("Review sweep");

    expect(text()).not.toContain("New Automation");
    expect(text()).not.toContain("Edit");
    expect(text()).not.toContain("Duplicate");
    expect(text()).not.toContain("Delete");
    expect(useAutomationsStore.getState().editor).toBeNull();
  });
});

/**
 * What the block says about its OWN read, and where (VC-406).
 *
 * The two halves are one decision: a read that has never landed owns the body,
 * because there is nothing there to caveat and "nothing here" and "this could
 * not be read" are opposite claims; a read that happens OVER rows owns the
 * eyebrow, because the rows were true a second ago and hiding them behind a
 * skeleton loses the thing the reader came for. What never changes across the
 * pair is the launch: a Run is spent on an arming, and an arming a failed
 * re-read left unproven is not something to spend one on.
 */
describe("what it says about its own read", () => {
  it("says a refused FIRST read failed, and reads again when asked", async () => {
    doors.list.mockResolvedValue({ ok: false, error: "database is locked" });
    doors.armings.mockResolvedValue({ ok: true, armings: [] });
    doors.enablement.mockResolvedValue({ ok: true, enabledAutomationIds: [] });
    Object.defineProperty(window, "api", { configurable: true, value: { automations: doors } });
    await render();

    const refused = fault();
    expect(refused).not.toBeNull();
    expect(refused?.textContent).toContain("Automations failed to read");
    // Not a skeleton waiting for a read nobody will make, and not a claim
    // about a project this block never read.
    expect(skeleton()).toBeNull();
    expect(text()).not.toContain("No automations in this project yet.");
    expect(rows()).toHaveLength(0);

    // The one press that changes it, local to the block: no planning change,
    // no ticket switch, no app-wide refresh.
    doors.list.mockResolvedValue({ ok: true, automations: [automation()] });
    await pressRetry(refused as HTMLElement);

    expect(fault()).toBeNull();
    expect(rows()).toHaveLength(1);
    expect(row("Review sweep")).toBeTruthy();
  });

  it("keeps the rows it last read while a re-read is out, and caveats them in the eyebrow", async () => {
    await mount({ automations: [automation()], armings: [ARMING] });
    expect(rows()).toHaveLength(1);

    const second = deferred<{ ok: true; automations: Automation[] }>();
    doors.list.mockReturnValue(second.promise);
    await act(async () => {
      stalePlanningClock();
    });

    // The rows stay, at their own height: no skeleton over data that was true
    // a second ago, and nothing under this block moves.
    expect(rows()).toHaveLength(1);
    expect(skeleton()).toBeNull();
    expect(readStatus()?.dataset.readStatus).toBe("refreshing");
    expect(text()).toContain("Refreshing · last read shown");

    // Readable, not pressable: the arming behind the row is exactly what this
    // read has not confirmed yet.
    await inspect("Review sweep");
    expect(text()).toContain("Run waits for a fresh read.");
    expect(runButton().disabled).toBe(true);
    await press(runButton());
    expect(runAutomationOnTicket).not.toHaveBeenCalled();

    await act(async () => {
      second.resolve({ ok: true, automations: [automation()] });
    });
    expect(readStatus()).toBeNull();
    expect(runButton().disabled).toBe(false);
  });

  it("holds the last COHERENT read when a re-read fails halfway, and refuses the launch behind it", async () => {
    await mount({ automations: [automation()], armings: [ARMING] });
    expect(row("Review sweep").dataset.armed).toBe("true");

    // The partial cache: the list half lands a record the rail has never seen
    // armed, the arming half fails. Composing from the slices now would draw a
    // combination no read ever returned.
    doors.list.mockResolvedValue({
      ok: true,
      automations: [automation({ id: "a2", name: "Nightly sweep" })],
    });
    doors.armings.mockResolvedValue({ ok: false, error: "database is locked" });
    await act(async () => {
      stalePlanningClock();
    });

    expect(text()).not.toContain("Nightly sweep");
    expect(rows()).toHaveLength(1);
    expect(skeleton()).toBeNull();
    expect(fault()).toBeNull();
    const status = readStatus();
    expect(status?.dataset.readStatus).toBe("refresh-failed");
    expect(text()).toContain("Refresh failed · last read shown");

    // The armed row is still ON SCREEN and still un-pressable — the refusal
    // VC-112 makes about a stale arming, spent on the Run rather than on the
    // reader's ability to see what is there.
    await inspect("Review sweep");
    expect(runButton().disabled).toBe(true);
    await press(runButton());
    expect(runAutomationOnTicket).not.toHaveBeenCalled();

    // And the eyebrow's own retry is the way back to a pressable row: the half
    // that failed is re-read, the whole answer becomes current, and the rows
    // the reader was looking at are replaced by the ones the read returned.
    doors.armings.mockResolvedValue({ ok: true, armings: [ARMING] });
    await pressRetry(status as HTMLElement);

    expect(readStatus()).toBeNull();
    expect(text()).toContain("Nightly sweep");
    await inspect("Nightly sweep");
    expect(runButton().disabled).toBe(false);
    await press(runButton());
    expect(runAutomationOnTicket).toHaveBeenCalledTimes(1);
  });

  it("retains nothing across a project switch: the rows it held were that project's", async () => {
    const second = deferred<{ ok: true; automations: Automation[] }>();
    doors.list.mockImplementation(({ projectId }: { projectId: string }) =>
      projectId === "p1"
        ? Promise.resolve({ ok: true, automations: [automation()] })
        : second.promise,
    );
    doors.armings.mockResolvedValue({ ok: true, armings: [ARMING] });
    doors.enablement.mockResolvedValue({ ok: true, enabledAutomationIds: [] });
    Object.defineProperty(window, "api", { configurable: true, value: { automations: doors } });
    await render();
    expect(rows()).toHaveLength(1);

    // The rail arrives on another project before its read lands. Retention is
    // scoped to the project and column it was read for, so nothing of the one
    // just left is drawn — or pressable — under the new heading.
    await paint("p2");

    expect(rows()).toHaveLength(0);
    expect(text()).not.toContain("Review sweep");
    expect(readStatus()).toBeNull();
    expect(skeleton()).not.toBeNull();
    expect(text()).not.toContain("No automations in this project yet.");

    await act(async () => {
      second.resolve({ ok: true, automations: [automation({ id: "b1", name: "Deploy check" })] });
    });
    expect(rows()).toHaveLength(1);
    expect(text()).toContain("Deploy check");
  });
});

describe("the inspection", () => {
  it("opens beside the row, with no scrim over the app", async () => {
    await mount({ automations: [automation()], armings: [ARMING] });
    await inspect("Review sweep");

    const open = inspection();
    expect(open).not.toBeNull();
    // Anchored and non-modal: Radix mounts no overlay, and nothing behind the
    // popover is made inert.
    expect(document.querySelector('[data-slot="popover-overlay"]')).toBeNull();
    expect(document.querySelector("[data-aria-hidden]")).toBeNull();
    expect(open?.getAttribute("data-state")).toBe("open");
  });

  it("holds the saved instructions, the model and one explicit Run together", async () => {
    await mount({
      automations: [automation({ instructions: "Review every behavioural change" })],
      armings: [ARMING],
    });
    await inspect("Review sweep");

    // The record's own instructions, as saved — not a fixture's words.
    expect(
      document.querySelector('[data-testid="ticket-rail-automation-instructions"]')?.textContent,
    ).toBe("Review every behavioural change");
    // How it would start, in which column.
    expect(inspection()?.textContent).toContain("Armed · Doing");
    // The Runtime this invocation would use, and the one press that spends it.
    expect(control("Run on model").textContent).toContain("Saved model");
    expect(runButton().textContent).toContain("Run");
    // And no second door to the page, no Diffs shortcut, no authoring.
    expect(inspection()?.textContent).not.toContain("Automations page");
    expect(inspection()?.textContent).not.toContain("Diffs");
    expect(inspection()?.textContent).not.toContain("Edit");
  });

  it("opens on right-click too, and neither route launches anything", async () => {
    await mount({ automations: [automation()], armings: [ARMING] });

    await rightClick("Review sweep");
    expect(inspection()).not.toBeNull();
    // Inspecting is reading. A press that silently ran the record is what this
    // replaced, and a right-click that ran it would be the same mistake with
    // a different button.
    expect(runAutomationOnTicket).not.toHaveBeenCalled();
    // The same controls as the left-click route, not a second menu.
    expect(control("Run on model")).not.toBeNull();
    expect(runButton()).not.toBeNull();
  });
});

describe("the per-invocation override", () => {
  it("spends the model it names on that row's own Run", async () => {
    await mount({ automations: [automation()], armings: [ARMING] });
    await inspect("Review sweep");
    await press(control("Run on model"));
    await choose("claude-opus · high");
    await press(runButton());

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
    await inspect("Nightly sweep");
    await press(control("Run on model"));
    await choose("claude-opus · high");
    await press(runButton());

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

describe("the pending gate and the failure that earns a retry", () => {
  it("refuses a second press while the first launch is still in flight", async () => {
    await mount({ automations: [automation()], armings: [ARMING] });
    const launch = heldLaunch();
    await inspect("Review sweep");
    await press(runButton());

    // One press, one Run — and the control says so rather than staying
    // pressable and minting a second Session.
    expect(runAutomationOnTicket).toHaveBeenCalledTimes(1);
    expect(runButton().disabled).toBe(true);
    expect(runButton().textContent).toContain("Starting…");
    // The row carries the same acknowledgment, so the popover need not stay
    // open to prove the press was heard.
    expect(row("Review sweep").dataset.launch).toBe("pending");
    expect(row("Review sweep").textContent).toContain("Starting…");

    await press(runButton());
    expect(runAutomationOnTicket).toHaveBeenCalledTimes(1);

    await launch.resolve("started");
    expect(row("Review sweep").dataset.launch).toBe("idle");
  });

  it("offers Retry after a refusal, keeping the model that was chosen", async () => {
    await mount({ automations: [automation()], armings: [ARMING] });
    const launch = heldLaunch();
    await inspect("Review sweep");
    await press(control("Run on model"));
    await choose("claude-opus · high");
    await press(runButton());
    await launch.resolve("refused");

    // The toast is gone by the time anyone reads this; the popover says the
    // Session did not start, beside the press that tries again.
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Couldn’t start the Session",
    );
    expect(runButton().disabled).toBe(false);
    expect(runButton().textContent).toContain("Retry Run");
    // The override survives the failure: a retry is the same intent.
    expect(control("Run on model").textContent).toContain("claude-opus · high");

    vi.mocked(runAutomationOnTicket).mockResolvedValue("started");
    await press(runButton());
    expect(runAutomationOnTicket).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        modelOverride: { providerId: "anthropic", modelId: "claude-opus", reasoningLevel: "high" },
      }),
    );
  });

  it("offers Retry after a transport failure, and clears the alert on the next attempt", async () => {
    await mount({ automations: [automation()], armings: [ARMING] });
    let launch = heldLaunch();
    await inspect("Review sweep");
    await press(runButton());
    await launch.resolve("failed");

    expect(runButton().textContent).toContain("Retry Run");

    launch = heldLaunch();
    await press(runButton());
    // The alert belonged to the attempt that produced it.
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(runButton().textContent).toContain("Starting…");
    await launch.resolve("started");
  });

  it("does not offer Retry for a missing default model: that recovery is Settings", async () => {
    // AGENTS.md: configuration failures require explicit user recovery, and
    // pressing Run again would fail the same way.
    await mount({ automations: [automation()], armings: [ARMING] });
    const launch = heldLaunch();
    await inspect("Review sweep");
    await press(runButton());
    await launch.resolve("needs-model-access");

    // The gate is released and nothing is marked failed: reopening the
    // inspection offers a plain Run, with no alert to dismiss.
    expect(row("Review sweep").dataset.launch).toBe("idle");
    await inspect("Review sweep");
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(runButton().textContent).toContain("Run");
    expect(runButton().textContent).not.toContain("Retry");
  });

  it("lands in the background without taking focus back from where the person went", async () => {
    // VC-234: no Run door navigates. The inspection adds one rule of its own —
    // a landing closes it only while the person is still following that
    // launch, which is what focus inside the popover means.
    await mount({ automations: [automation()], armings: [ARMING] });
    const launch = heldLaunch();
    await inspect("Review sweep");
    await press(runButton());

    // The person moves on. Focus leaving the popover light-dismisses it, the
    // way every anchored surface in the app behaves — that is them leaving,
    // not the Run doing anything.
    const elsewhere = document.createElement("button");
    document.body.append(elsewhere);
    await act(async () => {
      elsewhere.focus();
    });
    expect(inspection()).toBeNull();

    await launch.resolve("started");

    // Nothing was stolen when it landed: focus stayed where they put it, no
    // popover reopened under them, and the workspace did not navigate.
    expect(document.activeElement).toBe(elsewhere);
    expect(inspection()).toBeNull();
    expect(useWorkspaceStore.getState().byProject.p1?.nav).toBeUndefined();
    // The row still tells the truth about the launch it started.
    expect(row("Review sweep").dataset.launch).toBe("idle");
    elsewhere.remove();
  });

  it("closes the inspection when the launch lands while it still holds focus", async () => {
    await mount({ automations: [automation()], armings: [ARMING] });
    const launch = heldLaunch();
    await inspect("Review sweep");
    await act(async () => {
      runButton().focus();
    });
    await press(runButton());
    await launch.resolve("started");

    expect(inspection()).toBeNull();
  });

  it("lists no Run of its own: a Run is a Session, and the roster owns it", async () => {
    await mount({ automations: [automation()], armings: [ARMING] });
    await inspect("Review sweep");
    await press(runButton());

    // One row per saved record, before and after a launch — the block never
    // grows a second feed of what it started (VC-406).
    expect(rows()).toHaveLength(1);
    expect(text()).not.toContain("Runs");
  });
});
