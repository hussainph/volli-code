// @vitest-environment jsdom
/**
 * The Search page's behaviour (VC-193, plan §4.7): what it sends, what it draws
 * when a search was capped, and what a click on a match actually does.
 *
 * The last one is the feature's whole promise — "a click opens the file at the
 * match line" is two separate acts (open the tab, land on the line), and this
 * is the only place they are joined.
 *
 * A real jsdom ENVIRONMENT rather than a hand-built JSDOM, unlike the hook
 * probes beside this file: react-dom decides whether it can install its event
 * system when it is first imported, so a window stubbed in afterwards renders
 * fine and receives no clicks or keystrokes at all — and clicking is the thing
 * under test here.
 */
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { FileSearchResult } from "../../../../ipc/contract";
import { fileRevealKey, takeFileReveal } from "@renderer/editor/reveal-line";
import { FileSearchPanel } from "./search-panel";
import type { SearchScope } from "./search-model";

const onOpenMatch = vi.fn();
let root: Root | null = null;
let container: HTMLElement | null = null;

const oneMatch: FileSearchResult = {
  ok: true,
  files: [
    {
      relPath: "src/app.ts",
      matches: [{ line: 12, column: 7, preview: "const needle = 1;", start: 6, end: 12 }],
    },
  ],
  matches: 1,
  limit: "none",
};

async function mount(scope: SearchScope, result: FileSearchResult = oneMatch) {
  const search = vi.fn(async (): Promise<FileSearchResult> => result);
  Object.defineProperty(window, "api", {
    configurable: true,
    // `listExternalApps` is a file row's context menu asking what is installed;
    // nothing else on this page reaches main.
    value: { files: { search, listExternalApps: async () => ({ ok: true, apps: [] }) } },
  });

  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <FileSearchPanel scope={scope} root="volli/VC-193-search" onOpenMatch={onOpenMatch} />,
    );
  });
  return { search };
}

/** Types into the search box and lets the debounce settle. */
async function type(text: string): Promise<void> {
  const input = document.querySelector("input");
  if (input === null) throw new Error("no search input");
  await act(async () => {
    // The native setter, so React's value tracker sees a real change rather
    // than the assignment it made itself.
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, text);
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 260));
  });
}

function rows(selector: string): Element[] {
  return [...document.querySelectorAll(selector)];
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  onOpenMatch.mockReset();
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

describe("what the page sends", () => {
  it("asks nothing until there is a query", async () => {
    const { search } = await mount({ kind: "home", projectId: "p1" });

    expect(search).not.toHaveBeenCalled();
    expect(rows('[data-testid="file-search-idle"]')).toHaveLength(1);
  });

  it("searches Main from Home", async () => {
    const { search } = await mount({ kind: "home", projectId: "p1" });

    await type("needle");

    expect(search).toHaveBeenCalledWith({ projectId: "p1", query: "needle" });
  });

  // The scope pair is the whole safety property: a Ticket workspace must not be
  // answered about the main checkout, because the click that follows opens the
  // ticket's own copy of that path.
  it("searches the ticket's worktree from a Ticket workspace", async () => {
    const { search } = await mount({ kind: "ticket", projectId: "p1", ticketId: "t1" });

    await type("needle");

    expect(search).toHaveBeenCalledWith({ projectId: "p1", ticketId: "t1", query: "needle" });
  });

  it("sends the trimmed query, once, after typing settles", async () => {
    const { search } = await mount({ kind: "home", projectId: "p1" });

    await type("  needle  ");

    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith({ projectId: "p1", query: "needle" });
  });
});

describe("what the page draws", () => {
  it("groups matches under their file", async () => {
    await mount({ kind: "home", projectId: "p1" });

    await type("needle");

    const files = rows('[data-testid="file-search-file"]');
    expect(files).toHaveLength(1);
    expect(files[0]?.getAttribute("data-path")).toBe("src/app.ts");
    expect(rows('[data-testid="file-search-match"]')).toHaveLength(1);
    expect(document.querySelector("mark")?.textContent).toBe("needle");
  });

  it("says out loud that a capped search is not the whole answer", async () => {
    await mount({ kind: "home", projectId: "p1" }, { ...oneMatch, matches: 500, limit: "matches" });

    await type("needle");

    expect(document.querySelector('[data-testid="file-search-summary"]')?.textContent).toBe(
      "First 500 matches in 1 file",
    );
    expect(rows('[data-testid="file-search-truncated"]')).toHaveLength(1);
  });

  it("reports a failed search rather than drawing it as no matches", async () => {
    await mount({ kind: "home", projectId: "p1" }, { ok: false, error: "Search is unavailable" });

    await type("needle");

    expect(rows('[data-testid="file-search-error"]')).toHaveLength(1);
  });

  it("clears results when the box is emptied again", async () => {
    await mount({ kind: "home", projectId: "p1" });
    await type("needle");
    expect(rows('[data-testid="file-search-match"]')).toHaveLength(1);

    await type("");

    expect(rows('[data-testid="file-search-idle"]')).toHaveLength(1);
    expect(rows('[data-testid="file-search-match"]')).toHaveLength(0);
  });
});

describe("what a click does", () => {
  it("opens the file as a preview and asks that editor to land on the match", async () => {
    await mount({ kind: "ticket", projectId: "p1", ticketId: "t1" });
    await type("needle");

    const match = rows('[data-testid="file-search-match"]')[0];
    await act(async () => {
      match?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });

    expect(onOpenMatch).toHaveBeenCalledWith("src/app.ts");
    // The reveal waits where the editor about to mount will claim it — keyed to
    // the TICKET's copy of that path, never Main's.
    expect(
      takeFileReveal(fileRevealKey({ projectId: "p1", ticketId: "t1", relPath: "src/app.ts" })),
    ).toEqual({ line: 12, column: 7, length: 6 });
  });
});
