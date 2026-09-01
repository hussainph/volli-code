// @vitest-environment jsdom
/**
 * The nested context-menu surface (VC-112: the per-invocation override lives on
 * the deliberate surfaces, never the drag path), as the BOARD CARD hosts it —
 * "run one without opening the Ticket".
 *
 * A real jsdom environment rather than a static render, for the reason the
 * rail's own test states: the promises here are a right-click, a nested submenu
 * and a run that must not navigate. Where a Run lands is `run-automation.ts`'s
 * decision and is tested there; what this file owns is whether the menu asks
 * for the right one — and whether it asks at all before it has read anything.
 */
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Automation, ColumnArming, Ticket } from "@volli/shared";

import { TicketAutomationMenuItems } from "./automation-run-menu";
import { runAutomationOnTicket } from "./run-automation";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "@renderer/components/ui/context-menu";
import { ModelAccessProvider } from "@renderer/lib/model-access-client";
import { useAutomationsStore } from "@renderer/stores/automations";
import { useProjectsStore } from "@renderer/stores/projects";

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
  ticketNumber: 12,
  title: "Calm Stack",
  status: "doing",
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

const doors = { list: vi.fn(), armings: vi.fn(), enablement: vi.fn() };

/** One available model with one level, so the override rows have something to name. */
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

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** Mount the submenu's rows inside a real menu, and right-click it open. */
async function open(): Promise<void> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <ModelAccessProvider client={MODEL_ACCESS}>
        <ContextMenu>
          <ContextMenuTrigger>
            <span>card</span>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <TicketAutomationMenuItems ticket={TICKET} projectId="p1" />
          </ContextMenuContent>
        </ContextMenu>
      </ModelAccessProvider>,
    );
  });
  const trigger = document.querySelector('[data-slot="context-menu-trigger"]');
  await act(async () => {
    trigger?.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 }),
    );
  });
}

function text(): string {
  return document.body.textContent ?? "";
}

function menuItem(label: string): HTMLElement {
  const found = [...document.querySelectorAll('[data-slot="context-menu-item"]')].find(
    (candidate) => candidate.textContent?.includes(label),
  );
  if (found === undefined) throw new Error(`no menu item named ${label}`);
  return found as HTMLElement;
}

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
  vi.mocked(runAutomationOnTicket).mockReset();
  vi.mocked(runAutomationOnTicket).mockResolvedValue(undefined);
  doors.list.mockResolvedValue({ ok: true, automations: [automation()] });
  doors.armings.mockResolvedValue({ ok: true, armings: [ARMING] });
  doors.enablement.mockResolvedValue({ ok: true, enabledAutomationIds: [] });
  Object.defineProperty(window, "api", { configurable: true, value: { automations: doors } });
  useProjectsStore.setState({ projects: [PROJECT], selectedProjectId: "p1" });
  useAutomationsStore.setState({
    byProject: {},
    armingByProject: {},
    enabledIds: [],
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

describe("the board card's Automations submenu", () => {
  it("offers this column's list and runs one without opening the Ticket", async () => {
    await open();

    await act(async () => {
      menuItem("Review sweep").click();
    });

    // VC-234's universal landing: no navigation, a toast whose action is the door.
    expect(runAutomationOnTicket).toHaveBeenCalledWith({
      target: { kind: "automation", automationId: "a1" },
      automationName: "Review sweep",
      ticketId: "t1",
      ticketDisplayId: "VC-12",
      modelOverride: null,
    });
  });

  it("carries a per-invocation override from its nested item", async () => {
    await open();
    await openSubmenu("Run on model");

    await act(async () => {
      menuItem("claude-opus").click();
    });

    expect(runAutomationOnTicket).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { kind: "automation", automationId: "a1" },
        modelOverride: { providerId: "anthropic", modelId: "claude-opus", reasoningLevel: "high" },
      }),
    );
  });

  it("offers no Run once, because a card has nowhere to type one", async () => {
    await open();

    expect(text()).not.toContain("Run once");
  });

  it("says it is reading rather than listing a cache it has not refreshed", async () => {
    const list = deferred<{ ok: true; automations: Automation[] }>();
    doors.list.mockReturnValue(list.promise);
    // A cache from an earlier surface, holding an arming this menu has not
    // re-read: it must offer nothing until its own read lands.
    useAutomationsStore.setState({
      byProject: { p1: [automation()] },
      armingByProject: { p1: [ARMING] },
      enablementRead: true,
    });

    await open();

    expect(text()).toContain("Reading automations…");
    expect(document.querySelectorAll('[data-slot="context-menu-item"]')).toHaveLength(0);

    await act(async () => {
      list.resolve({ ok: true, automations: [automation()] });
    });
    expect(text()).toContain("Review sweep");
  });

  it("keeps saying so when the re-read of a warm cache fails", async () => {
    // A landed cache whose re-read failed is indistinguishable, in the slice,
    // from one just confirmed — the old value is still there. The menu counts
    // the read as unmade rather than listing an arming nobody re-read.
    doors.armings.mockResolvedValue({ ok: false, error: "database is locked" });
    useAutomationsStore.setState({
      byProject: { p1: [automation()] },
      armingByProject: { p1: [ARMING] },
      enablementRead: true,
    });

    await open();

    expect(text()).toContain("Reading automations…");
    expect(document.querySelectorAll('[data-slot="context-menu-item"]')).toHaveLength(0);
    expect(runAutomationOnTicket).not.toHaveBeenCalled();
  });

  it("says so plainly when this column offers nothing", async () => {
    doors.list.mockResolvedValue({ ok: true, automations: [] });
    doors.armings.mockResolvedValue({ ok: true, armings: [] });

    await open();

    expect(text()).toContain("No automations offered in this column");
  });
});
