// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ListDirectoryResult } from "../../../../ipc/contract";
import type { Project } from "@volli/shared";

import {
  clearRememberedNavigatorViews,
  navigatorScopeKey,
  writeNavigatorView,
} from "@renderer/components/files/navigator-scope-state";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { HomeFilesList, HomeFilesPanel } from "./home-files-panel";

const noop = (_path: string): void => {};

function render(cwd: string, entries: Array<{ name: string; kind: "file" | "dir" }>): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <HomeFilesList
        projectId="project-1"
        cwd={cwd}
        entries={entries}
        onPreviewFile={noop}
        onPinFile={noop}
        onOpenDirectory={noop}
      />
    </TooltipProvider>,
  );
}

const project: Project = {
  id: "project-1",
  name: "Volli Code",
  path: "/code/volli-code",
  ticketPrefix: "VC",
  colorIndex: 0,
  sortOrder: 0,
  createdAt: 1,
  updatedAt: 1,
};

function panel(): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <HomeFilesPanel project={project} onPreviewFile={noop} onPinFile={noop} />
    </TooltipProvider>,
  );
}

afterEach(() => {
  clearRememberedNavigatorViews();
});

const OTHER_PROJECT: Project = {
  ...project,
  id: "project-2",
  name: "Other Repo",
  path: "/code/other",
};

/** A listing whose answer the test decides when to give, per requested path. */
function listings() {
  const queue: ((result: ListDirectoryResult) => void)[] = [];
  const listDirectory = vi.fn(
    async (): Promise<ListDirectoryResult> =>
      await new Promise<ListDirectoryResult>((resolve) => queue.push(resolve)),
  );
  return {
    listDirectory,
    /** Answers the OLDEST outstanding read — the one a scope change left behind. */
    async settleOldest(result: ListDirectoryResult) {
      const resolve = queue.shift();
      await act(async () => {
        resolve?.(result);
      });
    },
    async settleNewest(result: ListDirectoryResult) {
      const resolve = queue.pop();
      await act(async () => {
        resolve?.(result);
      });
    },
  };
}

function rows(): Element[] {
  return [...document.querySelectorAll('[data-testid="ticket-files-row"]')];
}

function panelNode(): Element | null {
  return document.querySelector('[data-testid="home-files-panel"]');
}

function api(listDirectory: ReturnType<typeof listings>["listDirectory"]) {
  Object.defineProperty(window, "api", {
    configurable: true,
    value: {
      projects: { syncRoots: async () => ({ ok: true }) },
      fs: { listDirectory },
      files: {
        watchDir: async () => ({ ok: true }),
        unwatchDir: async () => ({ ok: true }),
        onDirChanged: () => () => {},
        listExternalApps: async () => ({ ok: true, apps: [] }),
      },
    },
  });
}

describe("HomeFilesPanel across a project switch", () => {
  let root: Root | null = null;
  let container: HTMLElement | null = null;

  async function show(shown: Project): Promise<void> {
    await act(async () => {
      root?.render(
        <TooltipProvider>
          <HomeFilesPanel project={shown} onPreviewFile={noop} onPinFile={noop} />
        </TooltipProvider>,
      );
    });
  }

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    root = null;
    container?.remove();
    container = null;
    vi.unstubAllGlobals();
    Reflect.deleteProperty(window, "api");
  });

  // The rail hands this panel a new project rather than being remounted
  // (`home-surface.tsx`), and the swap has to be complete in the frame that
  // draws the new name — an effect that cleared the rows would have run one
  // frame too late, under the new project's heading and its New-file action.
  it("draws no trace of the previous project in the frame the new one arrives", async () => {
    const reads = listings();
    api(reads.listDirectory);
    await show(project);
    await reads.settleNewest({ ok: true, entries: [{ name: "README.md", kind: "file" }] });
    expect(rows()).toHaveLength(1);
    const before = panelNode();

    await show(OTHER_PROJECT);

    // Keyed by the project, so the swap is a fresh instance rather than the old
    // one being talked out of its state: the page a reader was looking at is
    // detached, not edited.
    const after = panelNode();
    expect(after).not.toBeNull();
    expect(after).not.toBe(before);
    expect(before?.isConnected).toBe(false);
    // And what stands there is a first read of the NEW checkout: its name, no
    // rows, and the skeleton that says why there are none.
    expect(after?.textContent).toContain("Other Repo");
    expect(after?.textContent).not.toContain("Volli Code");
    expect(rows()).toHaveLength(0);
    expect([...document.querySelectorAll('[data-testid="home-files-loading"]')]).toHaveLength(1);
  });

  it("lets no late listing from the old project land on the new one", async () => {
    const reads = listings();
    api(reads.listDirectory);
    await show(project);

    await show(OTHER_PROJECT);
    // The read the first project left in flight, answering after the switch.
    await reads.settleOldest({ ok: true, entries: [{ name: "stale.md", kind: "file" }] });

    expect(document.body.textContent).not.toContain("stale.md");
    expect(rows()).toHaveLength(0);
    // Still the new project's own first read, not a landed one.
    expect([...document.querySelectorAll('[data-testid="home-files-loading"]')]).toHaveLength(1);
  });

  it("keeps each project's remembered folder, and asks for that folder", async () => {
    writeNavigatorView(navigatorScopeKey("files", { projectId: OTHER_PROJECT.id }), {
      cwd: "src",
      filtering: true,
      query: "rail",
    });
    const reads = listings();
    api(reads.listDirectory);
    await show(project);
    await reads.settleNewest({ ok: true, entries: [] });

    await show(OTHER_PROJECT);

    expect(reads.listDirectory).toHaveBeenLastCalledWith("/code/other/src");
    expect(document.querySelector("input")?.value).toBe("rail");
  });
});

describe("HomeFilesPanel", () => {
  it("mounts as the Main-checkout navigator while its root listing loads", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <HomeFilesPanel project={project} onPreviewFile={noop} onPinFile={noop} />
      </TooltipProvider>,
    );

    expect(html).toContain('data-testid="home-files-panel"');
    // The checkout it is rooted in, and no second name for a page the Files
    // tab has already named (VC-406, revision 06).
    expect(html).toContain("Volli Code");
    expect(html).not.toContain("Project files");
    expect(html).toContain('aria-label="Loading files"');
  });

  it("offers New File in its header — the Home half of VC-191's both-scopes rule", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <HomeFilesPanel project={project} onPreviewFile={noop} onPinFile={noop} />
      </TooltipProvider>,
    );

    // Reachable before the first listing lands: an empty folder has no row to
    // right-click, which is exactly when it is needed.
    expect(html).toContain('aria-label="New file"');
  });

  it("has no paperclip — attachments belong to a Ticket (VC-406)", () => {
    const html = panel();

    expect(html).not.toContain('data-testid="rail-attachments-trigger"');
    expect(html).not.toContain("Attachments");
    // The controls this scope DOES have still ride the directory line.
    expect(html).toContain('aria-label="New file"');
    expect(html).toContain('aria-label="Filter files"');
  });

  it("reopens the folder and filter this project was left at (VC-406)", () => {
    // The rail unmounts this page on a tab switch; the scope's remembered view
    // is what survives it, and it is restored during the FIRST render rather
    // than after a listing lands.
    writeNavigatorView(navigatorScopeKey("files", { projectId: project.id }), {
      cwd: "apps/desktop",
      filtering: true,
      query: "rail",
    });

    const html = panel();

    expect(html).toContain('aria-label="Leave apps/desktop"');
    expect(html).toContain('value="rail"');
  });

  it("does not borrow another project's folder", () => {
    writeNavigatorView(navigatorScopeKey("files", { projectId: "project-2" }), {
      cwd: "elsewhere",
      filtering: false,
      query: "",
    });

    expect(panel()).not.toContain("elsewhere");
  });
});

describe("HomeFilesList", () => {
  it("uses the ticket rail's flat navigator pattern for Main-checkout entries", () => {
    const html = render("apps/desktop", [
      { name: "src", kind: "dir" },
      { name: "package.json", kind: "file" },
    ]);

    expect(html).toContain("src/");
    expect(html).toContain("package.json");
    expect(html).toContain("apps/desktop");
    expect(html.match(/<ul/g)?.length).toBe(1);
  });

  it("keeps directories navigational and files openable", () => {
    const html = render("", [
      { name: "src", kind: "dir" },
      { name: "README.md", kind: "file" },
    ]);

    expect(html).not.toContain('aria-label="Open src in tab"');
    expect(html).toContain('aria-label="Open README.md in tab"');
  });

  it("shows the shared empty hint for an empty folder", () => {
    expect(render("empty", [])).toContain("Nothing here yet");
  });
});
