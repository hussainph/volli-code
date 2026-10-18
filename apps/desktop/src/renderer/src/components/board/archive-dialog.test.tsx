// @vitest-environment jsdom
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ArchivedTicket, Project } from "@volli/shared";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { hostWorld, type HostWorld } from "@renderer/components/hosts/hosts.test-support";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { useBoardStore } from "@renderer/stores/board";

import {
  ARCHIVE_SEARCH_THRESHOLD,
  ArchiveDialog,
  ArchiveRow,
  matchesArchiveQuery,
} from "./archive-dialog";

/**
 * The handlers' own write gate, separately from the disabled control: a host
 * that drops between a render and a click leaves the button enabled for that
 * click, which is the case `canWriteNow` exists for. `null` defers to the real
 * read.
 */
const writeGate = vi.hoisted(() => ({ override: null as boolean | null }));
vi.mock("@renderer/components/hosts/use-hosts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@renderer/components/hosts/use-hosts")>();
  return {
    ...actual,
    canWriteNow: (projectId: string | null) => writeGate.override ?? actual.canWriteNow(projectId),
  };
});

const project: Project = {
  id: "remote",
  name: "Volli Code",
  path: "/repo/volli",
  ticketPrefix: "VC",
  baseBranch: "main",
  colorIndex: 0,
  sortOrder: 0,
  createdAt: 0,
  updatedAt: 0,
};

function archived(overrides: Partial<ArchivedTicket> = {}): ArchivedTicket {
  return {
    id: "t1",
    projectId: "remote",
    ticketNumber: 12,
    title: "MCP server",
    body: "",
    status: "done",
    priority: "medium",
    labels: [],
    usesWorktree: true,
    preferredHarnessId: "claude-code",
    order: 0,
    worktreePath: null,
    branch: null,
    baseBranch: null,
    prUrl: null,
    createdAt: 0,
    updatedAt: 0,
    archivedAt: 0,
    ...overrides,
  };
}

const noop = () => {};

function row(ticket: ArchivedTicket, canWrite = true): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <ArchiveRow
        project={project}
        ticket={ticket}
        canWrite={canWrite}
        onInspect={noop}
        onRequestDelete={noop}
      />
    </TooltipProvider>,
  );
}

describe("ArchiveRow — retained record", () => {
  it("shows the retained branch name when the archived ticket kept one", () => {
    expect(row(archived({ branch: "volli/VC-12-mcp-server" }))).toContain("volli/VC-12-mcp-server");
  });

  it("marks a retained PR", () => {
    expect(row(archived({ prUrl: "https://github.com/x/y/pull/9" }))).toContain(">PR<");
  });

  it("omits both the branch and PR affordances when neither was retained", () => {
    const html = row(archived());
    expect(html).not.toContain(">PR<");
    // Still shows the always-present column + archived-on meta.
    expect(html).toContain("Done");
    expect(html).toContain("Archived");
  });
});

describe("matchesArchiveQuery", () => {
  const ticket = archived({ ticketNumber: 42, title: "Fix the Terminal" });

  it("matches everything on a blank query", () => {
    expect(matchesArchiveQuery("VC", ticket, "   ")).toBe(true);
  });

  it("matches the display id and the title, case-insensitively", () => {
    expect(matchesArchiveQuery("VC", ticket, "vc-42")).toBe(true);
    expect(matchesArchiveQuery("VC", ticket, " terminal ")).toBe(true);
    expect(matchesArchiveQuery("VC", ticket, "browser")).toBe(false);
  });
});

let world: HostWorld | null = null;

afterEach(async () => {
  await world?.cleanup();
  world = null;
  useBoardStore.setState({ archivedByProject: {}, labelsByProject: {} });
  writeGate.override = null;
  vi.restoreAllMocks();
});

/**
 * Mounts the Archive dialog over `tickets` for the world's selected project
 * ("remote", prefix VC), with the load and both writes stubbed.
 */
async function renderArchive(
  tickets: ArchivedTicket[],
  { offline = false }: { offline?: boolean } = {},
) {
  world = offline
    ? hostWorld({ hetzner: { link: { status: "offline", since: 0, retryAt: null } } })
    : hostWorld({ cloud: false });
  const loadArchived = vi.fn(async () => true);
  const unarchiveTicket = vi.fn(async () => undefined);
  const deleteArchivedTicket = vi.fn(async () => undefined);
  useBoardStore.setState({
    archivedByProject: { [project.id]: tickets },
    labelsByProject: { [project.id]: [] },
    loadArchived,
    unarchiveTicket,
    deleteArchivedTicket,
  });
  const onOpenChange = vi.fn();
  await world.render(
    <TooltipProvider>
      <ArchiveDialog open onOpenChange={onOpenChange} />
    </TooltipProvider>,
  );
  return { unarchiveTicket, deleteArchivedTicket, onOpenChange };
}

function dialog(): HTMLElement {
  const found = document.querySelector<HTMLElement>('[data-slot="dialog-content"]');
  if (found === null) throw new Error("No dialog");
  return found;
}

function buttonNamed(name: string, scope: ParentNode = document.body): HTMLButtonElement {
  const found = [...scope.querySelectorAll("button")].find(
    (candidate) =>
      candidate.textContent?.trim() === name || candidate.getAttribute("aria-label") === name,
  );
  if (found === undefined) throw new Error(`No button "${name}"`);
  return found;
}

function rowTarget(ticketId: string): HTMLButtonElement {
  const found = dialog().querySelector<HTMLButtonElement>(
    `button[data-archived-ticket-id="${ticketId}"]`,
  );
  if (found === null) throw new Error(`No row for ${ticketId}`);
  return found;
}

function search(): HTMLInputElement | null {
  return dialog().querySelector<HTMLInputElement>('input[type="search"]');
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function many(count: number): ArchivedTicket[] {
  return Array.from({ length: count }, (_, index) =>
    archived({ id: `t${index + 1}`, ticketNumber: index + 1, title: `Ticket number ${index + 1}` }),
  );
}

async function pressEscape(): Promise<void> {
  await act(async () => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
  });
}

describe("ArchiveList — inspect", () => {
  it("opens a row read-only without restoring, and Back returns to its row", async () => {
    const { unarchiveTicket, deleteArchivedTicket } = await renderArchive([
      archived({
        title: "MCP server",
        body: "## Plan\n\nShip the **server**.",
        labels: ["infra"],
        branch: "volli/VC-12-mcp-server",
        prUrl: "https://github.com/x/y/pull/9",
      }),
    ]);

    await act(async () => rowTarget("t1").click());

    const view = dialog();
    expect(view.querySelector('[data-slot="dialog-title"]')?.textContent).toBe("MCP server");
    expect(view.textContent).toContain("VC-12");
    expect(view.querySelector(".typeset h2")?.textContent).toBe("Plan");
    expect(view.querySelector(".typeset strong")?.textContent).toBe("server");
    expect(view.textContent).toContain("infra");
    expect(view.textContent).toContain("volli/VC-12-mcp-server");
    // The view only reads: neither lifecycle action is reachable from it.
    expect(() => buttonNamed("Restore", view)).toThrow();
    expect(() => buttonNamed("Delete permanently", view)).toThrow();
    expect(document.activeElement).toBe(buttonNamed("Archive", view));

    const open = vi.spyOn(window, "open").mockReturnValue(null);
    await act(async () => buttonNamed("PR", view).click());
    expect(open).toHaveBeenCalledWith("https://github.com/x/y/pull/9", "_blank", "noopener");

    await act(async () => buttonNamed("Archive", view).click());
    expect(document.activeElement).toBe(rowTarget("t1"));
    expect(unarchiveTicket).not.toHaveBeenCalled();
    expect(deleteArchivedTicket).not.toHaveBeenCalled();
  });

  it("Escape steps back to the list first, and only then closes the dialog", async () => {
    const { onOpenChange } = await renderArchive([archived()]);

    await act(async () => rowTarget("t1").click());
    expect(dialog().querySelector('[data-slot="dialog-title"]')?.textContent).toBe("MCP server");
    await pressEscape();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(dialog().querySelector('[data-slot="dialog-title"]')?.textContent).toBe("Archive");
    expect(document.activeElement).toBe(rowTarget("t1"));

    await pressEscape();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("says so when the archived ticket had no description", async () => {
    await renderArchive([archived()]);
    await act(async () => rowTarget("t1").click());
    expect(dialog().textContent).toContain("No description.");
  });
});

describe("ArchiveList — search", () => {
  it("has no find field for a short archive", async () => {
    await renderArchive(many(ARCHIVE_SEARCH_THRESHOLD));
    expect(search()).toBeNull();
  });

  it("filters a long archive by title or display id, and keeps the field while searching", async () => {
    await renderArchive(many(ARCHIVE_SEARCH_THRESHOLD + 1));
    const field = search()!;

    await type(field, "vc-9");
    expect(dialog().querySelectorAll("li")).toHaveLength(1);
    expect(rowTarget("t9").textContent).toContain("Ticket number 9");

    await type(field, "number 1");
    expect([...dialog().querySelectorAll("li")].map((li) => li.textContent)).toEqual([
      expect.stringContaining("Ticket number 1"),
    ]);

    await type(field, "nothing like this");
    expect(dialog().textContent).toContain("No matching tickets.");
    expect(search()).not.toBeNull();
  });

  it("keeps the query across an inspect and back", async () => {
    await renderArchive(many(ARCHIVE_SEARCH_THRESHOLD + 1));
    await type(search()!, "vc-3");
    await act(async () => rowTarget("t3").click());
    await act(async () => buttonNamed("Archive", dialog()).click());
    expect(search()!.value).toBe("vc-3");
    expect(dialog().querySelectorAll("li")).toHaveLength(1);
  });
});

describe("ArchiveList — restore and delete stay apart", () => {
  it("restores from its labelled pill, and permanent delete is a separate glyph behind a confirm", async () => {
    const { unarchiveTicket, deleteArchivedTicket } = await renderArchive([archived()]);
    const restore = buttonNamed("Restore", dialog());
    const remove = buttonNamed("Delete permanently", dialog());
    // Two different controls, neither inside the row's own target.
    expect(restore).not.toBe(remove);
    expect(remove.textContent?.trim()).toBe("");
    expect(rowTarget("t1").contains(restore)).toBe(false);
    expect(rowTarget("t1").contains(remove)).toBe(false);

    await act(async () => restore.click());
    expect(unarchiveTicket).toHaveBeenCalledWith("remote", "t1");
    expect(deleteArchivedTicket).not.toHaveBeenCalled();

    await act(async () => remove.click());
    expect(deleteArchivedTicket).not.toHaveBeenCalled();
    const confirm = document.querySelector<HTMLElement>('[role="alertdialog"]')!;
    expect(confirm.textContent).toContain("VC-12 “MCP server” and its full history");
    await act(async () => buttonNamed("Delete", confirm).click());
    expect(deleteArchivedTicket).toHaveBeenCalledWith("remote", "t1");
    expect(unarchiveTicket).toHaveBeenCalledTimes(1);
  });

  it("Cancel on the confirm deletes nothing", async () => {
    const { deleteArchivedTicket } = await renderArchive([archived()]);
    await act(async () => buttonNamed("Delete permanently", dialog()).click());
    const confirm = document.querySelector<HTMLElement>('[role="alertdialog"]')!;
    await act(async () => buttonNamed("Cancel", confirm).click());
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(deleteArchivedTicket).not.toHaveBeenCalled();
  });

  it("offline: Restore and Delete are disabled, and inspecting still works", async () => {
    await renderArchive([archived({ body: "Still readable." })], { offline: true });
    const restore = buttonNamed("Restore", dialog());
    expect(restore.disabled).toBe(true);
    expect(restore.hasAttribute("data-host-read-only")).toBe(true);
    expect(buttonNamed("Delete permanently", dialog()).disabled).toBe(true);

    await act(async () => rowTarget("t1").click());
    expect(dialog().textContent).toContain("Still readable.");
  });

  it("a host that stops serving after the render: Restore and the confirm's Delete still write nothing", async () => {
    const { unarchiveTicket, deleteArchivedTicket } = await renderArchive([archived()]);
    const restore = buttonNamed("Restore", dialog());
    await act(async () => buttonNamed("Delete permanently", dialog()).click());
    const confirmDelete = buttonNamed(
      "Delete",
      document.querySelector<HTMLElement>('[role="alertdialog"]')!,
    );
    // Both controls drew enabled; the gate is the handlers' own read at click time.
    expect(restore.disabled).toBe(false);
    expect(confirmDelete.disabled).toBe(false);
    writeGate.override = false;

    await act(async () => confirmDelete.click());
    expect(deleteArchivedTicket).not.toHaveBeenCalled();
    await act(async () => restore.click());
    expect(unarchiveTicket).not.toHaveBeenCalled();
  });
});
