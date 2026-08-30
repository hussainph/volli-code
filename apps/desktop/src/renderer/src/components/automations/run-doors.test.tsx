// @vitest-environment jsdom
/**
 * VC-220 — every Run door, driven from the control a person actually presses,
 * as far as the one seam they all have to reach.
 *
 * The report said the kickoff never fired "across ALL Run doors", and the
 * answer to that claim cannot be one call to the shared runner: the whole point
 * of a per-door test is to catch the door that does NOT arrive at the shared
 * seam — the surface that grew its own call, or stopped making one at all. So
 * each case here starts at the real entry path (a click on the rail's split
 * button, a board card's context-menu row, the page's Ticket chooser, the
 * palette's run-by-name row, the armed column's countdown expiring) with the
 * real `run-automation.ts` glue behind it, and asserts what reached
 * `window.api.automations.run` — the preload's `volli:automation-run`.
 *
 * That channel is where this file stops, and the rest of the chain is pinned
 * where it lives:
 *
 *  - channel → `runner.run()`, attendance decided by being that handler:
 *    `main/automations/ipc.test.ts`.
 *  - `runner.run()` → the composed Instructions delivered as the Session's
 *    FIRST turn under the Run's durable ids, and the loud failure when the
 *    attach that would have carried them is refused:
 *    `main/automations/run.test.ts`.
 *  - the two doors that never touch the renderer — the agent verb and the
 *    schedule timer — reach the same runner in `agent-tool-door.test.ts` and
 *    `automations/scheduler.test.ts`.
 *
 * Nothing here asserts where a started Run LANDS (a tab, a toast, Model
 * Access); that is `run-automation-model.ts`'s decision and each surface's own
 * test. What is asserted is that the door asks, and asks for the right Run.
 */
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ARMED_RUN_DELAY_MS, NO_AUTOMATION_TRIGGER } from "@volli/shared";
import type {
  Automation,
  AutomationRun,
  AutomationSkippedOccurrence,
  ColumnArming,
  Ticket,
} from "@volli/shared";

import { noteDeliberateMove, resetArmedRuns } from "./armed-run";
import { TicketAutomationMenuItems } from "./automation-run-menu";
import { AutomationsPage } from "./automations-page";
import { TicketAutomationsPanel } from "./ticket-rail-automations";
import { CommandPalette } from "@renderer/components/command-palette";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@renderer/components/ui/context-menu";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { ModelAccessProvider } from "@renderer/lib/model-access-client";
import { useAutomationsStore } from "@renderer/stores/automations";
import { useBoardStore } from "@renderer/stores/board";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";
import { useProjectsStore } from "@renderer/stores/projects";
import { useWorkspaceStore } from "@renderer/stores/workspace";

// The landing's toasts are noise here, and `sonner` needs a real DOM host it
// has no reason to get in this file.
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), info: vi.fn(), success: vi.fn() }),
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
  ticketNumber: 12,
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

const AUTOMATION: Automation = {
  id: "a1",
  projectId: "p1",
  name: "Review sweep",
  instructions: "/review",
  trigger: { kind: "columns", columns: ["doing"] },
  runtime: null,
  createdAt: 1,
  updatedAt: 1,
};

/** A record nothing but a person starts — what the page's Ticket chooser is for. */
const MANUAL: Automation = {
  ...AUTOMATION,
  id: "a2",
  name: "Manual sweep",
  trigger: NO_AUTOMATION_TRIGGER,
};

const NIGHTLY: Automation = {
  ...AUTOMATION,
  id: "a3",
  name: "Nightly sweep",
  trigger: {
    kind: "schedule",
    schedule: { preset: "daily", hour: 21, minute: 0, timeZone: "Europe/London" },
  },
};

const ARMING: ColumnArming = { projectId: "p1", status: "doing", automationId: "a1", armedAt: 5 };

/** The one Run door every renderer surface has to reach, and its Project twin. */
const run = vi.fn(async () => ({
  ok: true as const,
  run: { sessionId: "s1" },
  projectId: "p1",
  receipt: { id: "r", commandId: "c", status: "completed", recordedAt: 0 },
}));
const runForProject = vi.fn(async () => ({
  ok: true as const,
  run: { sessionId: "s1" },
  projectId: "p1",
  receipt: { id: "r", commandId: "c", status: "completed", recordedAt: 0 },
}));

/** Every read a mounted surface makes on arrival, answered from the seed. */
const doors = {
  run,
  runForProject,
  list: vi.fn(async (): Promise<{ ok: true; automations: Automation[] }> => ({
    ok: true,
    automations: [AUTOMATION],
  })),
  armings: vi.fn(async (): Promise<{ ok: true; armings: ColumnArming[] }> => ({
    ok: true,
    armings: [ARMING],
  })),
  enablement: vi.fn(async (): Promise<{ ok: true; enabledAutomationIds: string[] }> => ({
    ok: true,
    enabledAutomationIds: [],
  })),
  runsForTicket: vi.fn(async (): Promise<{ ok: true; runs: AutomationRun[] }> => ({
    ok: true,
    runs: [],
  })),
  runsForProject: vi.fn(async (): Promise<{ ok: true; runs: AutomationRun[] }> => ({
    ok: true,
    runs: [],
  })),
  skipsForProject: vi.fn(async (): Promise<{ ok: true; skips: AutomationSkippedOccurrence[] }> => ({
    ok: true,
    skips: [],
  })),
  columnOrders: vi.fn(async () => ({ ok: true, orders: [] })),
  setColumnOrder: vi.fn(async () => ({ ok: true, orders: [], receipt: {} })),
  setEnabled: vi.fn(async () => ({ ok: true, enabledAutomationIds: [], receipt: {} })),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};

/** One available model, so the per-invocation override rows have one to name. */
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

/**
 * The rest of `window.api` a started Run touches on its way to a landing —
 * adopting the fresh Session, refreshing the rail, the composer's supply for
 * the Run once form. Stubbed rather than avoided: a door whose glue threw on
 * the way back would not be a door that reached the seam.
 */
function installApi(automations: Partial<typeof doors> = {}): void {
  Object.defineProperty(window, "api", {
    configurable: true,
    value: {
      automations: { ...doors, ...automations },
      sessions: {
        list: vi.fn(async () => ({ ok: true, sessions: [] })),
        listForTicket: vi.fn(async () => ({ ok: true, sessions: [] })),
      },
      sessionRpc: {
        onEvent: () => () => {},
        request: vi.fn(async () => ({ ok: true })),
        subscribe: vi.fn(() => () => {}),
      },
      files: {
        promptTemplates: vi.fn(async () => ({ ok: true, templates: [], skills: [] })),
        index: vi.fn(async () => ({ ok: true, files: [] })),
      },
    },
  });
}

async function render(element: React.ReactNode): Promise<void> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<ModelAccessProvider client={MODEL_ACCESS}>{element}</ModelAccessProvider>);
  });
}

function control(label: string): HTMLElement {
  const found = document.querySelector(`[aria-label="${label}"]`);
  if (found === null) throw new Error(`no control labelled ${label}`);
  return found as HTMLElement;
}

function itemContaining(slot: string, label: string): HTMLElement {
  const found = [...document.querySelectorAll(`[data-slot="${slot}"]`)].find((candidate) =>
    candidate.textContent?.includes(label),
  );
  if (found === undefined) throw new Error(`no ${slot} named ${label}`);
  return found as HTMLElement;
}

/** A palette row — cmdk marks its own items rather than taking a `data-slot`. */
function commandItem(label: string): HTMLElement {
  const found = [...document.querySelectorAll("[cmdk-item]")].find((candidate) =>
    candidate.textContent?.includes(label),
  );
  if (found === undefined) throw new Error(`no palette row named ${label}`);
  return found as HTMLElement;
}

function buttonContaining(label: string): HTMLElement {
  const found = [...document.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.includes(label),
  );
  if (found === undefined) throw new Error(`no button containing ${label}`);
  return found;
}

/** Type into a controlled textarea the way React's own event system sees it. */
async function typeInstructions(value: string): Promise<void> {
  const box = document.querySelector('[aria-label="Instructions"]') as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  await act(async () => {
    setter?.call(box, value);
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/**
 * What a door is expected to have asked for.
 *
 * `commandId` is the glue's own durable retry identity, and `attendance` is
 * deliberately absent: the renderer does not get to declare whether a person
 * was there (`main/automations/ipc.ts` fills it in by being that handler), so
 * an exact match here is also the assertion that no door smuggles it onto the
 * wire.
 */
function askedFor(request: Record<string, unknown>): Record<string, unknown> {
  return { commandId: expect.any(String) as unknown, ...request };
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // The board's lane view reads it; jsdom does not implement it.
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  // cmdk measures its list; jsdom has neither of these.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
  window.HTMLElement.prototype.scrollIntoView = () => {};
  vi.clearAllMocks();
  installApi();
  useProjectsStore.setState({ projects: [PROJECT], selectedProjectId: "p1" });
  useBoardStore.getState().hydrate({ p1: [TICKET] }, { p1: [] });
  useAutomationsStore.setState({
    byProject: {},
    armingByProject: {},
    orderByProject: {},
    runsByProject: {},
    runsByTicket: {},
    skipsByProject: {},
    enabledIds: [],
    enablementRead: false,
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
  resetArmedRuns();
  useChatSessionsStore.setState({ sessions: {} });
  vi.unstubAllGlobals();
});

describe("every Run door reaches the one Run seam (VC-220)", () => {
  it("the Ticket rail's split button", async () => {
    await render(<TicketAutomationsPanel projectId="p1" ticket={TICKET} />);

    await act(async () => {
      control("Run Review sweep on this ticket").click();
    });

    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(
      askedFor({
        target: { kind: "automation", automationId: "a1" },
        ticketId: "t1",
        modelOverride: null,
      }),
    );
  });

  it("the rail's per-invocation Runtime, spent on this one Run", async () => {
    // The same door with the other answer it can give (VC-112). It is its own
    // case because the override travels on the request: a door that dropped it
    // would reach the seam asking for a different Run than the one pressed.
    await render(<TicketAutomationsPanel projectId="p1" ticket={TICKET} />);

    await act(async () => {
      control("Other automations").dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, button: 0 }),
      );
    });
    await act(async () => {
      itemContaining("dropdown-menu-sub-trigger", "Run on model").click();
    });
    await act(async () => {
      itemContaining("dropdown-menu-item", "claude-opus").click();
    });

    expect(run).toHaveBeenCalledWith(
      askedFor({
        target: { kind: "automation", automationId: "a1" },
        ticketId: "t1",
        modelOverride: { providerId: "anthropic", modelId: "claude-opus", reasoningLevel: "high" },
      }),
    );
  });

  it("the rail's Run once, whose Instructions no record supplies", async () => {
    await render(<TicketAutomationsPanel projectId="p1" ticket={TICKET} />);

    await act(async () => {
      control("Other automations").dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, button: 0 }),
      );
    });
    await act(async () => {
      itemContaining("dropdown-menu-item", "Run once").click();
    });
    await typeInstructions("/review the diff once");
    await act(async () => {
      buttonContaining("Run").click();
    });

    // The Unbound Run's own words are the payload — this is the door where the
    // Instructions exist nowhere else, so losing them here loses them entirely.
    expect(run).toHaveBeenCalledWith(
      askedFor({
        target: { kind: "unbound", instructions: "/review the diff once" },
        ticketId: "t1",
        modelOverride: null,
      }),
    );
  });

  it("the board card's context menu", async () => {
    await render(
      <ContextMenu>
        <ContextMenuTrigger>
          <span>card</span>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <TicketAutomationMenuItems ticket={TICKET} projectId="p1" />
        </ContextMenuContent>
      </ContextMenu>,
    );
    await act(async () => {
      document
        .querySelector('[data-slot="context-menu-trigger"]')
        ?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 }));
    });

    await act(async () => {
      itemContaining("context-menu-item", "Review sweep").click();
    });

    expect(run).toHaveBeenCalledWith(
      askedFor({
        target: { kind: "automation", automationId: "a1" },
        ticketId: "t1",
        modelOverride: null,
      }),
    );
  });

  it("the Automations page's Run button, through its Ticket chooser", async () => {
    installApi({ list: vi.fn(async () => ({ ok: true, automations: [MANUAL] })) });
    await render(
      <TooltipProvider>
        <AutomationsPage />
      </TooltipProvider>,
    );

    await act(async () => {
      control("Run Manual sweep").click();
    });
    await act(async () => {
      buttonContaining("Calm Stack").click();
    });

    // The page has no Ticket of its own, so the chosen one is what must arrive.
    expect(run).toHaveBeenCalledWith(
      askedFor({
        target: { kind: "automation", automationId: "a2" },
        ticketId: "t1",
        modelOverride: null,
      }),
    );
  });

  it("the armed column's window, when nobody takes it back", async () => {
    // The one door with no control at the end of it: a card is dropped, 3500ms
    // pass, and the Run starts itself. It is also the door that calls the seam
    // directly rather than through the shared glue, which is exactly the kind
    // of bypass a single runner-level test cannot see.
    vi.useFakeTimers();
    try {
      useAutomationsStore.setState({
        byProject: { p1: [AUTOMATION] },
        armingByProject: { p1: [ARMING] },
        orderByProject: { p1: [] },
        enabledIds: [AUTOMATION.id],
        enablementRead: true,
      });
      noteDeliberateMove({ projectId: "p1", ticketId: "t1", from: "todo", to: "doing" });

      await vi.advanceTimersByTimeAsync(ARMED_RUN_DELAY_MS);

      expect(run).toHaveBeenCalledWith(
        askedFor({
          target: { kind: "automation", automationId: "a1" },
          ticketId: "t1",
          // Never on the drag path (VC-112).
          modelOverride: null,
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("the command palette's run-by-name row", async () => {
    // The palette runs on the OPEN Ticket, so the open Ticket is the seed.
    useWorkspaceStore.getState().openTicket("p1", "t1");
    await render(<CommandPalette open onOpenChange={() => {}} />);

    await act(async () => {
      commandItem("Run on VC-12").click();
    });

    expect(run).toHaveBeenCalledWith(
      askedFor({
        target: { kind: "automation", automationId: "a1" },
        ticketId: "t1",
        modelOverride: null,
      }),
    );
  });

  it("the page's Play on a scheduled record, at the Project", async () => {
    // The schedule's Target is the Project (VC-112), so this door reaches the
    // OTHER channel — and it must not quietly become a Ticket Run.
    installApi({ list: vi.fn(async () => ({ ok: true, automations: [NIGHTLY] })) });
    await render(
      <TooltipProvider>
        <AutomationsPage />
      </TooltipProvider>,
    );

    await act(async () => {
      control("Run Nightly sweep").click();
    });

    expect(run).not.toHaveBeenCalled();
    expect(runForProject).toHaveBeenCalledWith(askedFor({ automationId: "a3", projectId: "p1" }));
  });

  it("Run now on a Skipped occurrence", async () => {
    installApi({
      list: vi.fn(async () => ({ ok: true, automations: [NIGHTLY] })),
      skipsForProject: vi.fn(
        async (): Promise<{ ok: true; skips: AutomationSkippedOccurrence[] }> => ({
          ok: true,
          skips: [
            {
              id: "skip-1",
              automationId: "a3",
              automationName: "Nightly sweep",
              projectId: "p1",
              dueAt: 5,
              missedCount: 3,
              reason: { kind: "app-closed" },
              recordedAt: 40,
            },
          ],
        }),
      ),
    });
    await render(
      <TooltipProvider>
        <AutomationsPage />
      </TooltipProvider>,
    );

    await act(async () => {
      control("Run Nightly sweep now").click();
    });

    expect(runForProject).toHaveBeenCalledTimes(1);
    expect(runForProject).toHaveBeenCalledWith(askedFor({ automationId: "a3", projectId: "p1" }));
  });
});
