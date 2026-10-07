// @vitest-environment jsdom
/**
 * Every board create path stands down while the project's host cannot serve
 * (VC-576, review B4), through the one `useCanWrite` gate: the header's and
 * the empty board's New ticket, the list view's New, a column composer that
 * was already open (Enter and blur keep the draft and write nothing), a
 * collapsed column's expand, and an arming menu that was already open. With
 * the flag off every one of them is exactly as before.
 */
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EMPTY_TICKET_FILTER, type TicketStatus } from "@volli/shared";

import { hostWorld, type HostWorld } from "@renderer/components/hosts/hosts.test-support";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { useAutomationsStore } from "@renderer/stores/automations";
import { useBoardStore } from "@renderer/stores/board";
import { useUiStore } from "@renderer/stores/ui";

import { BoardEmpty } from "./board-empty";
import { BoardHeader } from "./board-header";
import { BoardListView } from "./board-list-view";
import { useTicketComposer } from "./use-ticket-composer";

const toast = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast, Toaster: () => null }));

const OFFLINE = { status: "offline", since: 0, retryAt: null } as const;
const REASON = "Can’t reach hetzner-1 · Read-only";

let world: HostWorld | null = null;

beforeEach(() => {
  useBoardStore.setState({
    ticketsByProject: { remote: [] },
    labelsByProject: { remote: [] },
    filterByProject: {},
  });
});

afterEach(async () => {
  await world?.cleanup();
  world = null;
  useUiStore.setState({ newTicketOpen: false });
  toast.mockClear();
  vi.restoreAllMocks();
});

const EMPTY_GROUPS: Record<TicketStatus, never[]> = {
  backlog: [],
  todo: [],
  doing: [],
  needs_review: [],
  done: [],
};

function button(container: ParentNode, name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim().startsWith(name) === true,
  );
  if (found === undefined) throw new Error(`No button "${name}"`);
  return found;
}

function expectStoodDown(control: HTMLButtonElement): void {
  expect(control.disabled).toBe(true);
  expect(control.hasAttribute("data-host-read-only")).toBe(true);
}

function expectUntouched(control: HTMLButtonElement): void {
  expect(control.disabled).toBe(false);
  expect(control.hasAttribute("data-host-read-only")).toBe(false);
}

describe("board create controls", () => {
  it("the header's New ticket stands down, greyed, and comes back", async () => {
    world = hostWorld({ hetzner: { link: OFFLINE } });
    const container = await world.render(
      <TooltipProvider>
        <BoardHeader projectId="remote" ticketCount={0} tickets={[]} filter={EMPTY_TICKET_FILTER} />
      </TooltipProvider>,
    );
    expectStoodDown(button(container, "New ticket"));
    world.setHetzner({ link: { status: "open" } });
    expectUntouched(button(container, "New ticket"));
  });

  it("the empty board's New ticket stands down and opens nothing", async () => {
    world = hostWorld({ hetzner: { link: OFFLINE } });
    const container = await world.render(<BoardEmpty projectId="remote" />);
    const control = button(container, "New ticket");
    expectStoodDown(control);
    act(() => control.click());
    expect(useUiStore.getState().newTicketOpen).toBe(false);
  });

  it("the list view's New stands down", async () => {
    world = hostWorld({ hetzner: { link: OFFLINE } });
    const container = await world.render(
      <BoardListView
        projectId="remote"
        ticketPrefix="VC"
        projectLabels={[]}
        groups={EMPTY_GROUPS}
        shownStatuses={["todo"]}
        emptyDropStatuses={[]}
        boardEmpty={false}
        dragActive={false}
        aimedStatus={null}
        selectedIds={[]}
        draggingIds={[]}
        groupDragIds={[]}
        onSelect={() => {}}
        onOpen={() => {}}
      />,
    );
    expectStoodDown(button(container, "New"));
    world.setHetzner({ link: { status: "open" } });
    expectUntouched(button(container, "New"));
  });

  it("changes nothing with the flag off, whatever the host is doing", async () => {
    world = hostWorld({ cloud: false, hetzner: { link: OFFLINE } });
    const container = await world.render(<BoardEmpty projectId="remote" />);
    const control = button(container, "New ticket");
    expectUntouched(control);
    act(() => control.click());
    expect(useUiStore.getState().newTicketOpen).toBe(true);
  });
});

describe("a column composer", () => {
  let composer: ReturnType<typeof useTicketComposer> | null = null;
  function Probe({ initiallyOpen = false }: { initiallyOpen?: boolean }) {
    composer = useTicketComposer({ projectId: "remote", status: "todo", initiallyOpen });
    return null;
  }

  afterEach(() => {
    composer = null;
  });

  it("already open, writes nothing on Enter or blur once offline, and keeps the draft", async () => {
    world = hostWorld();
    const addTicket = vi.spyOn(useBoardStore.getState(), "addTicket").mockResolvedValue(null);
    const onClose = vi.fn();
    function Closing() {
      composer = useTicketComposer({
        projectId: "remote",
        status: "todo",
        initiallyOpen: true,
        onClose,
      });
      return null;
    }
    await world.render(<Closing />);
    act(() => composer!.setTitle("Do not write while offline"));
    world.setHetzner({ link: OFFLINE });
    expect(composer!.canWrite).toBe(false);

    const preventDefault = vi.fn();
    act(() => composer!.handleKeyDown({ key: "Enter", preventDefault } as never));
    expect(addTicket).not.toHaveBeenCalled();
    expect(composer!.title).toBe("Do not write while offline");
    expect(toast).toHaveBeenCalledWith(REASON, { id: "host-read-only" });

    act(() => composer!.handleBlur());
    expect(addTicket).not.toHaveBeenCalled();
    expect(composer!.open).toBe(false);
    expect(composer!.title).toBe("Do not write while offline");
    expect(onClose).toHaveBeenCalledOnce();

    // Back online, the held draft goes on the next Enter.
    world.setHetzner({ link: { status: "open" } });
    act(() => composer!.openComposer());
    expect(composer!.open).toBe(true);
    act(() => composer!.handleKeyDown({ key: "Enter", preventDefault } as never));
    expect(addTicket).toHaveBeenCalledWith("remote", "todo", "Do not write while offline");
  });

  it("an empty blur while offline simply closes", async () => {
    world = hostWorld();
    await world.render(<Probe initiallyOpen />);
    world.setHetzner({ link: OFFLINE });
    act(() => composer!.handleBlur());
    expect(composer!.open).toBe(false);
    expect(toast).not.toHaveBeenCalled();
  });

  it("does not open while read-only — not from New, not from a collapsed column's expand", async () => {
    world = hostWorld({ hetzner: { link: OFFLINE } });
    await world.render(<Probe initiallyOpen />);
    expect(composer!.open).toBe(false);
    act(() => composer!.openComposer());
    expect(composer!.open).toBe(false);
    expect(toast).toHaveBeenCalledWith(REASON, { id: "host-read-only" });
  });

  it("with the flag off, opens and submits exactly as before", async () => {
    world = hostWorld({ cloud: false, hetzner: { link: OFFLINE } });
    const addTicket = vi.spyOn(useBoardStore.getState(), "addTicket").mockResolvedValue(null);
    await world.render(<Probe initiallyOpen />);
    expect(composer!.open).toBe(true);
    act(() => composer!.setTitle("Written"));
    act(() => composer!.handleBlur());
    expect(addTicket).toHaveBeenCalledWith("remote", "todo", "Written");
    expect(composer!.title).toBe("");
  });
});

describe("column arming", () => {
  it("an arming menu open before the host went away cannot arm through it", async () => {
    world = hostWorld();
    const arm = vi.fn(async () => null);
    useAutomationsStore.setState({
      byProject: {
        remote: [
          {
            id: "a1",
            projectId: "remote",
            name: "Implement",
            instructions: "/implement",
            trigger: { kind: "columns", columns: ["todo"] },
            runtime: null,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      },
      armingByProject: { remote: [] },
      orderByProject: {},
      enabledIds: ["a1"],
      arm,
      refresh: vi.fn(async () => {}),
      refreshArming: vi.fn(async () => {}),
      refreshOrder: vi.fn(async () => {}),
      refreshEnablement: vi.fn(async () => {}),
    } as never);
    const { ColumnArmingButton } = await import("./column-arming");
    const container = await world.render(
      <TooltipProvider>
        <ColumnArmingButton projectId="remote" status="todo" />
      </TooltipProvider>,
    );
    const trigger = container.querySelector<HTMLButtonElement>("[data-column-arming]")!;
    expectUntouched(trigger);
    await act(async () => {
      trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    });
    const item = [...document.querySelectorAll('[role="menuitemradio"]')].find(
      (row) => row.textContent?.includes("Implement") === true,
    ) as HTMLElement | undefined;
    expect(item).toBeDefined();

    world.setHetzner({ link: OFFLINE });
    await act(async () => item!.click());
    expect(arm).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(REASON, { id: "host-read-only" });
    expectStoodDown(trigger);
  });
});
