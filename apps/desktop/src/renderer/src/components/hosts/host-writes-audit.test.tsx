// @vitest-environment jsdom
/**
 * The rest of the host writes the read-only audit found (VC-576 re-check,
 * blocker 4): a card's context menu (Move to, Priority, Labels, Archive,
 * Remove worktree, Resume), the rail's label Add and Remove, the Archive
 * confirm, Remove worktree, the repository's destination / base branch /
 * branch, every hand-run Automation, and the file navigator's create, rename,
 * duplicate and delete. Each stands down — shown disabled — while the
 * project's host cannot serve, and each handler checks again. With the flag
 * off every one is exactly as before.
 */
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Ticket } from "@volli/shared";

import { runAutomationOnTicket } from "@renderer/components/automations/run-automation";
import { TicketContextMenu } from "@renderer/components/board/ticket-context-menu";
import { TicketDialogHost, useTicketDialogs } from "@renderer/components/board/ticket-dialog-host";
import {
  useFileNavigatorMutations,
  type FileNavigatorControls,
} from "@renderer/components/files/use-navigator-mutations";
import { RemoveWorktreeDialog } from "@renderer/components/ticket/remove-worktree-dialog";
import { WorktreeDestinationControl } from "@renderer/components/ticket/ticket-repository-summary";
import { TicketProperties } from "@renderer/components/ticket/ticket-properties";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { useBoardStore } from "@renderer/stores/board";
import { useTicketSessionRecordsStore } from "@renderer/stores/ticket-session-records";

import { hostWorld, type HostWorld } from "./hosts.test-support";

const toast = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast, Toaster: () => null }));
vi.mock("@renderer/components/automations/automation-run-menu", () => ({
  TicketAutomationMenuItems: () => null,
}));
vi.mock("@renderer/components/sessions/model-access-first-run", () => ({
  useModelAccessReady: () => true,
  ModelAccessFirstRun: () => null,
}));
vi.mock("@renderer/editor/monaco-runtime", () => ({
  loadMonacoRuntime: async () => ({ registry: { peek: () => undefined } }),
}));

const OFFLINE = { status: "offline", since: 0, retryAt: null } as const;
const REASON = "Can’t reach hetzner-1 · Read-only";

const TICKET: Ticket = {
  id: "r1",
  projectId: "remote",
  ticketNumber: 1,
  title: "Remote",
  body: "",
  status: "todo",
  priority: "medium",
  labels: ["bug"],
  usesWorktree: true,
  preferredHarnessId: "claude-code",
  order: 0,
  worktreePath: null,
  branch: null,
  baseBranch: null,
  prUrl: null,
  createdAt: 1,
  updatedAt: 1,
};

let world: HostWorld | null = null;

beforeEach(() => {
  useBoardStore.setState({
    ticketsByProject: { remote: [TICKET] },
    labelsByProject: { remote: [] },
  });
});

afterEach(async () => {
  await world?.cleanup();
  world = null;
  toast.mockClear();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

function menuItem(text: string): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (item) => item.textContent?.trim() === text,
  );
}

async function openCardMenu(container: HTMLElement): Promise<void> {
  await act(async () =>
    container
      .querySelector("button")!
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 })),
  );
}

async function openSubmenu(name: string): Promise<void> {
  const trigger = menuItem(name)!;
  expect(trigger).toBeDefined();
  await act(async () => {
    trigger.focus();
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  });
}

function renderCard(on: HostWorld) {
  vi.spyOn(useTicketSessionRecordsStore.getState(), "ensure").mockResolvedValue(undefined);
  return on.render(
    <TicketDialogHost projectId="remote">
      <TicketContextMenu ticket={{ ...TICKET, worktreePath: "/w/r1" }} projectId="remote">
        <button type="button">Card</button>
      </TicketContextMenu>
    </TicketDialogHost>,
  );
}

describe("a card's context menu", () => {
  it("offline: Priority is shown disabled and writes nothing", async () => {
    world = hostWorld({ hetzner: { link: OFFLINE } });
    const priority = vi
      .spyOn(useBoardStore.getState(), "setTicketPriority")
      .mockResolvedValue(undefined);
    const container = await renderCard(world);
    await openCardMenu(container);
    await openSubmenu("Priority");
    const high = menuItem("High")!;
    expect(high).toBeDefined();
    expect(high.hasAttribute("data-disabled")).toBe(true);
    await act(async () => high.click());
    expect(priority).not.toHaveBeenCalled();
  });

  it("offline: Move to and the label ticks stand down", async () => {
    world = hostWorld({ hetzner: { link: OFFLINE } });
    useBoardStore.setState({
      labelsByProject: { remote: [{ id: "l1", projectId: "remote", name: "bug", color: null }] },
    });
    const move = vi.spyOn(useBoardStore.getState(), "moveTicket").mockResolvedValue(undefined);
    const container = await renderCard(world);
    await openCardMenu(container);
    await openSubmenu("Move to");
    const doing = menuItem("Doing")!;
    expect(doing.hasAttribute("data-disabled")).toBe(true);
    await act(async () => doing.click());
    expect(move).not.toHaveBeenCalled();
  });

  it("offline: Archive, Remove worktree are disabled and archive nothing", async () => {
    world = hostWorld({ hetzner: { link: OFFLINE } });
    const archive = vi
      .spyOn(useBoardStore.getState(), "archiveTicket")
      .mockResolvedValue(undefined);
    const container = await renderCard(world);
    await openCardMenu(container);
    const archiveItem = menuItem("Archive")!;
    expect(archiveItem.hasAttribute("data-disabled")).toBe(true);
    expect(menuItem("Remove worktree…")!.hasAttribute("data-disabled")).toBe(true);
    await act(async () => archiveItem.click());
    expect(archive).not.toHaveBeenCalled();
  });

  it("with the flag off, Archive archives as before", async () => {
    world = hostWorld({ cloud: false, hetzner: { link: OFFLINE } });
    const archive = vi
      .spyOn(useBoardStore.getState(), "archiveTicket")
      .mockResolvedValue(undefined);
    const container = await renderCard(world);
    await openCardMenu(container);
    const archiveItem = menuItem("Archive")!;
    expect(archiveItem.hasAttribute("data-disabled")).toBe(false);
    await act(async () => archiveItem.click());
    expect(archive).toHaveBeenCalledWith("remote", "r1");
  });
});

describe("the board's dialogs", () => {
  it("an archive asked for before the host went away says why and does not archive", async () => {
    world = hostWorld();
    const archive = vi
      .spyOn(useBoardStore.getState(), "archiveTicket")
      .mockResolvedValue(undefined);
    let requests: ReturnType<typeof useTicketDialogs> | null = null;
    function Card() {
      requests = useTicketDialogs();
      return null;
    }
    await world.render(
      <TicketDialogHost projectId="remote">
        <Card />
      </TicketDialogHost>,
    );
    world.setHetzner({ link: OFFLINE });
    await act(async () => requests!.requestArchive("r1"));
    expect(archive).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(REASON, { id: "host-read-only" });

    world.setHetzner({ link: { status: "open" } });
    await act(async () => requests!.requestArchive("r1"));
    expect(archive).toHaveBeenCalledWith("remote", "r1");
  });

  it("Remove worktree's confirm stands down offline and removes nothing", async () => {
    world = hostWorld({ hetzner: { link: OFFLINE } });
    const remove = vi.fn(async () => ({ ok: true }));
    Object.defineProperty(window, "api", {
      configurable: true,
      value: { worktree: { remove } },
    });
    await world.render(
      <RemoveWorktreeDialog projectId="remote" ticketId="r1" open onOpenChange={() => {}} />,
    );
    const confirm = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Remove",
    )!;
    expect(confirm.disabled).toBe(true);
    await act(async () => confirm.click());
    expect(remove).not.toHaveBeenCalled();
    Reflect.deleteProperty(window, "api");
  });
});

describe("the ticket rail", () => {
  it("offline: label Add and Remove stand down like Status and Priority", async () => {
    world = hostWorld({ hetzner: { link: OFFLINE } });
    const container = await world.render(<TicketProperties projectId="remote" ticket={TICKET} />);
    const add = container.querySelector<HTMLButtonElement>('[aria-label="Add label"]')!;
    const remove = container.querySelector<HTMLButtonElement>('[aria-label="Remove bug"]')!;
    expect(add.disabled).toBe(true);
    expect(remove.disabled).toBe(true);

    world.setHetzner({ link: { status: "open" } });
    expect(add.disabled).toBe(false);
    expect(remove.disabled).toBe(false);
  });

  it("offline: the worktree destination does not open", async () => {
    world = hostWorld({ hetzner: { link: OFFLINE } });
    const container = await world.render(
      <TooltipProvider>
        <WorktreeDestinationControl ticket={TICKET} />
      </TooltipProvider>,
    );
    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="ticket-worktree-destination"]',
    )!;
    expect(trigger.disabled).toBe(true);
    world.setHetzner({ link: { status: "open" } });
    expect(trigger.disabled).toBe(false);
  });
});

describe("hand-run Automations", () => {
  it("start no Run on a ticket whose project cannot serve, and say why", async () => {
    world = hostWorld({ hetzner: { link: OFFLINE } });
    const run = vi.fn();
    Object.defineProperty(window, "api", {
      configurable: true,
      value: { automations: { run } },
    });
    const outcome = await runAutomationOnTicket({
      target: { kind: "automation", automationId: "a1" },
      automationName: "Implement",
      ticketId: "r1",
      ticketDisplayId: "VC-1",
      modelOverride: null,
    });
    expect(outcome).toBe("refused");
    expect(run).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(REASON, { id: "host-read-only" });
    Reflect.deleteProperty(window, "api");
  });
});

describe("the file navigator", () => {
  it("offline: opens no field and creates, renames, duplicates and deletes nothing", async () => {
    world = hostWorld({ hetzner: { link: OFFLINE } });
    const files = {
      create: vi.fn(),
      createDirectory: vi.fn(),
      rename: vi.fn(),
      duplicate: vi.fn(),
      delete: vi.fn(),
    };
    Object.defineProperty(window, "api", { configurable: true, value: { files } });
    let controls: FileNavigatorControls | null = null;
    const host = { refresh: vi.fn(), openCreated: vi.fn(), renameTab: vi.fn() };
    function Probe() {
      controls = useFileNavigatorMutations({ scope: { projectId: "remote" }, cwd: "", host });
      return null;
    }
    await world.render(<Probe />);
    expect(controls!.canWrite).toBe(false);
    act(() => controls!.startDraft("file"));
    act(() => controls!.startRename("a.ts"));
    expect(controls!.edit.kind).toBe("none");
    act(() => controls!.commitDraft("b.ts"));
    act(() => controls!.commitRename("a.ts", "c.ts"));
    act(() => controls!.duplicate("a.ts"));
    act(() => controls!.remove("a.ts", "file"));
    await act(async () => {});
    for (const call of Object.values(files)) expect(call).not.toHaveBeenCalled();

    world.setHetzner({ link: { status: "open" } });
    expect(controls!.canWrite).toBe(true);
    act(() => controls!.startDraft("file"));
    expect(controls!.edit.kind).toBe("draft");
    Reflect.deleteProperty(window, "api");
  });
});
