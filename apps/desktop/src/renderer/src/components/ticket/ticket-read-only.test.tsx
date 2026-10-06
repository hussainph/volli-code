// @vitest-environment jsdom
/** VC-576: ticket writes follow their project's link, not the selected project. */
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { USER_ACTOR, type Ticket, type TicketComment } from "@volli/shared";

import { hostWorld, type HostWorld } from "@renderer/components/hosts/hosts.test-support";
import { AUTOSAVE_IDLE_MS } from "@renderer/editor/autosave-plan";
import { useBoardStore } from "@renderer/stores/board";
import { useTicketActivityStore } from "@renderer/stores/ticket-activity";

import { TicketActivityFeed } from "./ticket-activity-feed";
import { TicketBodyEditor } from "./ticket-body-editor";
import { TicketProperties } from "./ticket-properties";
import { TicketTitle } from "./ticket-title";

const { toast, markSaved, peek } = vi.hoisted(() => {
  const saved = vi.fn();
  return {
    toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
    markSaved: saved,
    peek: vi.fn(() => ({ markSaved: saved })),
  };
});
vi.mock("sonner", () => ({ toast, Toaster: () => null }));
vi.mock("@renderer/editor/monaco-runtime", () => ({
  loadMonacoRuntime: () => Promise.resolve({ registry: { peek } }),
}));
// Same onChange boundary as ticket-body-editor.test.tsx: the real autosaver
// owns the draft, while Monaco itself cannot run in jsdom.
vi.mock("@renderer/components/editor/monaco-document-editor", () => ({
  MonacoDocumentEditor: ({
    value,
    onChange,
    ariaLabel,
  }: {
    value: string;
    onChange(next: string): void;
    ariaLabel?: string;
  }) => (
    <textarea
      aria-label={ariaLabel}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));

const OFFLINE = { status: "offline", since: 0, retryAt: null } as const;
const REASON = "Can’t reach hetzner-1 · Read-only";
const TICKET: Ticket = {
  id: "remote-ticket",
  projectId: "remote",
  ticketNumber: 1,
  title: "Remote ticket",
  body: "Original description",
  status: "todo",
  priority: "medium",
  labels: [],
  usesWorktree: false,
  preferredHarnessId: "claude-code",
  order: 0,
  worktreePath: null,
  branch: null,
  baseBranch: null,
  prUrl: null,
  createdAt: 1,
  updatedAt: 1,
};
const COMMENT: TicketComment = {
  id: "own-comment",
  ticketId: TICKET.id,
  sessionId: null,
  actor: USER_ACTOR,
  body: "My existing comment",
  createdAt: 1,
  updatedAt: 1,
};
const doors = {
  events: vi.fn(async () => ({ ok: true as const, events: [] })),
  list: vi.fn(async () => ({ ok: true as const, comments: [COMMENT] })),
  create: vi.fn(async () => ({ ok: true as const, comment: COMMENT })),
};
let world: HostWorld | null = null;
let container: HTMLElement;
const originalBoard = useBoardStore.getState();
const updateTicket = vi.fn<typeof originalBoard.updateTicket>(async () => {});
let originalApi: PropertyDescriptor | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  originalApi = Object.getOwnPropertyDescriptor(window, "api");
  Object.defineProperty(window, "api", {
    configurable: true,
    value: { tickets: { events: doors.events }, comments: doors },
  });
  useBoardStore.setState({
    updateTicket,
    labelsByProject: { remote: [] },
    ticketsByProject: { remote: [TICKET] },
    lastPlanningChange: { version: 1, ticketId: null, projectId: null },
  });
  useTicketActivityStore.setState({ byTicket: {}, listingState: {}, listingError: {} });
});

afterEach(async () => {
  await world?.cleanup();
  world = null;
  useBoardStore.setState(originalBoard, true);
  useTicketActivityStore.setState({ byTicket: {}, listingState: {}, listingError: {} });
  if (originalApi) Object.defineProperty(window, "api", originalApi);
  else Reflect.deleteProperty(window, "api");
  vi.useRealTimers();
});

function query<T extends Element>(selector: string): T {
  const element = container.querySelector<T>(selector);
  if (element === null) throw new Error(`No element matching ${selector}`);
  return element;
}

async function type(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype =
    element instanceof HTMLInputElement
      ? HTMLInputElement.prototype
      : HTMLTextAreaElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  if (!setter) throw new Error("No native value setter");
  await act(async () => {
    setter.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function enter(element: HTMLElement, metaKey = false) {
  await act(async () => {
    element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey, bubbles: true }));
  });
}

function note() {
  return container.querySelector('[data-slot="host-read-only-note"]');
}

function commentButton() {
  const button = [...container.querySelectorAll("button")].find((element) =>
    element.textContent?.includes("Comment"),
  );
  if (!button) throw new Error("No Comment button");
  return button;
}

function expectCommentActions(present: boolean) {
  for (const name of ["Edit comment", "Delete comment"]) {
    expect(container.querySelector(`button[aria-label="${name}"]`) !== null).toBe(present);
  }
}

describe("TicketTitle read-only", () => {
  it("reads as a plain h1 offline, ignores clicks, and offers editing again when open", async () => {
    world = hostWorld({ selected: "local", hetzner: { link: OFFLINE } });
    container = await world.render(<TicketTitle ticket={TICKET} />);
    const heading = query<HTMLHeadingElement>("h1");
    expect(heading.textContent).toBe(TICKET.title);
    expect(heading.hasAttribute("role")).toBe(false);
    await act(async () => heading.click());
    expect(container.querySelector("input")).toBeNull();
    world.setHetzner({ link: { status: "open" } });
    expect(query("h1").getAttribute("role")).toBe("button");
    await act(async () => query<HTMLHeadingElement>("h1").click());
    expect(query<HTMLInputElement>('input[aria-label="Ticket title"]').value).toBe(TICKET.title);
  });

  it("refuses a rename committed after the host goes offline and toasts the reason", async () => {
    world = hostWorld();
    container = await world.render(<TicketTitle ticket={TICKET} />);
    await act(async () => query<HTMLHeadingElement>("h1").click());
    const input = query<HTMLInputElement>('input[aria-label="Ticket title"]');
    await type(input, "Renamed ticket");
    world.setHetzner({ link: OFFLINE });
    await enter(input);
    expect(updateTicket).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(REASON, { id: "host-read-only" });
    expect(query("h1").textContent).toBe(TICKET.title);

    world.setHetzner({ link: { status: "open" } });
    await act(async () => query<HTMLHeadingElement>("h1").click());
    const reopened = query<HTMLInputElement>('input[aria-label="Ticket title"]');
    await type(reopened, "Renamed ticket");
    await enter(reopened);
    expect(updateTicket).toHaveBeenCalledExactlyOnceWith({
      ticketId: TICKET.id,
      title: "Renamed ticket",
    });
  });

  it("still edits and renames with cloud off and the host offline", async () => {
    world = hostWorld({ cloud: false, hetzner: { link: OFFLINE } });
    container = await world.render(<TicketTitle ticket={TICKET} />);
    expect(query("h1").getAttribute("role")).toBe("button");
    await act(async () => query<HTMLHeadingElement>("h1").click());
    const input = query<HTMLInputElement>('input[aria-label="Ticket title"]');
    await type(input, "Flag-off rename");
    await enter(input);
    expect(updateTicket).toHaveBeenCalledExactlyOnceWith({
      ticketId: TICKET.id,
      title: "Flag-off rename",
    });
    expect(toast).not.toHaveBeenCalled();
  });
});

describe("TicketProperties read-only", () => {
  it("disables Status and Priority offline and enables both again when open", async () => {
    world = hostWorld({ selected: "local", hetzner: { link: OFFLINE } });
    container = await world.render(<TicketProperties projectId="remote" ticket={TICKET} />);
    for (const field of ["status", "priority"]) {
      expect(
        query<HTMLButtonElement>(`[data-testid="ticket-rail-property-${field}"]`).disabled,
      ).toBe(true);
    }
    world.setHetzner({ link: { status: "open" } });
    for (const field of ["status", "priority"]) {
      expect(
        query<HTMLButtonElement>(`[data-testid="ticket-rail-property-${field}"]`).disabled,
      ).toBe(false);
    }
  });

  it("keeps both triggers enabled with cloud off and the host offline", async () => {
    world = hostWorld({ cloud: false, hetzner: { link: OFFLINE } });
    container = await world.render(<TicketProperties projectId="remote" ticket={TICKET} />);
    for (const field of ["status", "priority"]) {
      expect(
        query<HTMLButtonElement>(`[data-testid="ticket-rail-property-${field}"]`).disabled,
      ).toBe(false);
    }
  });
});

describe("TicketActivityFeed read-only", () => {
  it("keeps the draft on ⌘Enter offline, shows why, hides own comment actions, then restores writing", async () => {
    world = hostWorld({ selected: "local", hetzner: { link: OFFLINE } });
    container = await world.render(<TicketActivityFeed ticket={TICKET} />);
    expect(container.textContent).toContain(COMMENT.body);
    expectCommentActions(false);
    expect(note()?.textContent).toBe(REASON);
    const textarea = query<HTMLTextAreaElement>('textarea[aria-label="Add a comment"]');
    await type(textarea, "  A held draft  ");
    expect(commentButton().disabled).toBe(true);
    // Greyed and desaturated like every write control, not a quieter orange.
    expect(commentButton().hasAttribute("data-host-read-only")).toBe(true);
    await enter(textarea, true);
    expect(doors.create).not.toHaveBeenCalled();
    expect(textarea.value).toBe("  A held draft  ");
    expect(toast).toHaveBeenCalledWith(REASON, { id: "host-read-only" });

    world.setHetzner({ link: { status: "open" } });
    expect(note()).toBeNull();
    expectCommentActions(true);
    expect(commentButton().disabled).toBe(false);
    expect(commentButton().hasAttribute("data-host-read-only")).toBe(false);
    expect(textarea.value).toBe("  A held draft  ");
    await enter(textarea, true);
    expect(doors.create).toHaveBeenCalledExactlyOnceWith({
      ticketId: TICKET.id,
      body: "A held draft",
    });
    expect(textarea.value).toBe("");
  });

  it("keeps comment submission and own comment actions with cloud off and the host offline", async () => {
    world = hostWorld({ cloud: false, hetzner: { link: OFFLINE } });
    container = await world.render(<TicketActivityFeed ticket={TICKET} />);
    expect(note()).toBeNull();
    expectCommentActions(true);
    const textarea = query<HTMLTextAreaElement>('textarea[aria-label="Add a comment"]');
    await type(textarea, "Flag-off comment");
    expect(commentButton().disabled).toBe(false);
    await act(async () => commentButton().click());
    expect(doors.create).toHaveBeenCalledExactlyOnceWith({
      ticketId: TICKET.id,
      body: "Flag-off comment",
    });
    expect(toast).not.toHaveBeenCalled();
  });
});

describe("TicketBodyEditor read-only", () => {
  it("holds the draft without autosaving or marking it saved offline, then saves it when open", async () => {
    vi.useFakeTimers();
    world = hostWorld({ selected: "local", hetzner: { link: OFFLINE } });
    container = await world.render(<TicketBodyEditor ticket={TICKET} />);
    expect(note()?.textContent).toBe(REASON);
    await type(
      query<HTMLTextAreaElement>('textarea[aria-label="Ticket description"]'),
      "Held description draft",
    );
    await act(async () => {
      vi.advanceTimersByTime(AUTOSAVE_IDLE_MS + 1);
    });
    expect(updateTicket).not.toHaveBeenCalled();
    expect(markSaved).not.toHaveBeenCalled();

    world.setHetzner({ link: { status: "open" } });
    await act(async () => {});
    expect(note()).toBeNull();
    expect(updateTicket).toHaveBeenCalledExactlyOnceWith({
      ticketId: TICKET.id,
      body: "Held description draft",
    });
    expect(markSaved).toHaveBeenCalledExactlyOnceWith(null);
    await act(async () => {
      vi.advanceTimersByTime(AUTOSAVE_IDLE_MS + 1);
    });
    expect(updateTicket).toHaveBeenCalledTimes(1);
  });

  it("still autosaves with cloud off and the host offline", async () => {
    vi.useFakeTimers();
    world = hostWorld({ cloud: false, hetzner: { link: OFFLINE } });
    container = await world.render(<TicketBodyEditor ticket={TICKET} />);
    expect(note()).toBeNull();
    await type(
      query<HTMLTextAreaElement>('textarea[aria-label="Ticket description"]'),
      "Flag-off description",
    );
    await act(async () => {
      vi.advanceTimersByTime(AUTOSAVE_IDLE_MS + 1);
    });
    expect(updateTicket).toHaveBeenCalledExactlyOnceWith({
      ticketId: TICKET.id,
      body: "Flag-off description",
    });
    expect(toast).not.toHaveBeenCalled();
  });
});
