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
import { FileSearchPanel, searchSummaryLine } from "./search-panel";
import {
  clearRememberedNavigatorViews,
  navigatorScopeKey,
  readNavigatorView,
} from "./navigator-scope-state";
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

async function mount(
  scope: SearchScope,
  result: FileSearchResult | (() => Promise<FileSearchResult>) = oneMatch,
) {
  const search = vi.fn(async (): Promise<FileSearchResult> =>
    typeof result === "function" ? await result() : result,
  );
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

/** Types into the search box WITHOUT letting the debounce elapse. */
async function typeOnly(text: string): Promise<void> {
  const input = document.querySelector("input");
  if (input === null) throw new Error("no search input");
  await act(async () => {
    // The native setter, so React's value tracker sees a real change rather
    // than the assignment it made itself.
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, text);
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}

/** Types into the search box and lets the debounce settle. */
async function type(text: string): Promise<void> {
  await typeOnly(text);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 260));
  });
}

function summaryText(): string | null {
  return document.querySelector('[data-testid="file-search-summary"]')?.textContent ?? null;
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
  // The typed query now OUTLIVES the page (VC-406), which is the point — and
  // which means one test's words would otherwise be the next one's starting
  // state, in the same module-level map the app uses.
  clearRememberedNavigatorViews();
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

  it("gives a late hit space in the row, even when main sends the whole short line", async () => {
    const preview = `${"x".repeat(100)}MIN_PANE_PX = 240;`;
    await mount(
      { kind: "home", projectId: "p1" },
      {
        ok: true,
        files: [
          {
            relPath: "src/layout.ts",
            matches: [{ line: 42, column: 101, preview, start: 100, end: 111 }],
          },
        ],
        matches: 1,
        limit: "none",
      },
    );
    await type("MIN_PANE_PX");

    const row = rows('[data-testid="file-search-match"]')[0];
    const hit = row?.querySelector("mark");
    const before = hit?.previousElementSibling;
    const after = hit?.nextElementSibling;
    expect(row?.getAttribute("data-line")).toBe("42");
    expect(before?.textContent).toBe(`…${"x".repeat(12)}`);
    expect(hit?.textContent).toBe("MIN_PANE_PX");
    expect(after?.textContent).toBe(" = 240;");
    // Unlike an inline mark inside a single truncating span, the context can
    // shrink while the hit stays fixed. Pin the parent structure too: an outer
    // `truncate` could clip the mark despite its own shrink-0. jsdom cannot
    // verify pixel clipping.
    const snippet = hit?.parentElement;
    expect(snippet?.classList.contains("flex")).toBe(true);
    expect(snippet?.classList.contains("min-w-0")).toBe(true);
    expect(snippet?.classList.contains("overflow-hidden")).toBe(true);
    expect(snippet?.classList.contains("whitespace-nowrap")).toBe(true);
    expect(snippet?.classList.contains("truncate")).toBe(false);
    expect(hit?.classList.contains("shrink-0")).toBe(true);
    expect(before?.classList.contains("min-w-0")).toBe(true);
    expect(after?.classList.contains("min-w-0")).toBe(true);

    await act(async () => {
      row?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });
    expect(onOpenMatch).toHaveBeenCalledWith("src/layout.ts");
    expect(takeFileReveal(fileRevealKey({ projectId: "p1", relPath: "src/layout.ts" }))).toEqual({
      line: 42,
      column: 101,
      length: 11,
    });
  });

  it("does not re-segment an unchanged match when the search input rerenders", async () => {
    const { search } = await mount({ kind: "home", projectId: "p1" });
    await type("needle");
    const segment = vi.spyOn(Intl.Segmenter.prototype, "segment");
    try {
      // A subsequent search returns the same match object. Until it finishes,
      // the previous result also stays mounted through input updates.
      await type("need");
      expect(search).toHaveBeenCalledTimes(2);
      expect(rows('[data-testid="file-search-match"]')).toHaveLength(1);
      expect(segment).not.toHaveBeenCalled();
    } finally {
      segment.mockRestore();
    }
  });

  it("says out loud that a capped search is not the whole answer", async () => {
    await mount({ kind: "home", projectId: "p1" }, { ...oneMatch, matches: 500, limit: "matches" });

    await type("needle");

    expect(document.querySelector('[data-testid="file-search-summary"]')?.textContent).toBe(
      "First 500 matches in 1 file",
    );
    expect(rows('[data-testid="file-search-truncated"]')).toHaveLength(1);
  });

  it("keeps zero results distinct from a truncated result", async () => {
    await mount(
      { kind: "home", projectId: "p1" },
      { ok: true, files: [], matches: 0, limit: "none" },
    );
    await type("absent");
    expect(rows('[data-testid="file-search-empty"]')[0]?.textContent).toBe("No matches");
    expect(rows('[data-testid="file-search-truncated"]')).toHaveLength(0);
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

/**
 * VC-406: a result on screen is an answer to a QUESTION, and the page never
 * lets the two drift apart — not while a second query is in flight, not when a
 * re-search fails, and never by claiming a checkout holds no matches on the
 * strength of a read that did not happen.
 */
describe("the summary line, as pure text", () => {
  const outcome = {
    query: "needle",
    files: oneMatch.ok ? oneMatch.files : [],
    matches: 3,
    limit: "none" as const,
  };

  it("says nothing at rest", () => {
    expect(searchSummaryLine({ pending: null, outcome: null, failed: false })).toBeNull();
  });

  it("names the query it is still searching for", () => {
    expect(searchSummaryLine({ pending: "needle", outcome: null, failed: false })).toBe(
      "Searching “needle”…",
    );
  });

  it("names BOTH queries when a new one runs over an old answer", () => {
    expect(searchSummaryLine({ pending: "needles", outcome, failed: false })).toBe(
      "Searching “needles” · results below are for “needle”",
    );
  });

  it("says the rows are the LAST read when the newest attempt failed", () => {
    expect(searchSummaryLine({ pending: null, outcome, failed: true })).toBe(
      "Last read for “needle” · 3 matches in 1 file",
    );
  });

  it("is just the count once a search has settled", () => {
    expect(searchSummaryLine({ pending: null, outcome, failed: false })).toBe(
      "3 matches in 1 file",
    );
  });
});

describe("a read that has not landed", () => {
  it("never draws 'No matches' for a search that failed", async () => {
    await mount({ kind: "home", projectId: "p1" }, { ok: false, error: "Search is unavailable" });

    await type("needle");

    expect(rows('[data-testid="file-search-error"]')).toHaveLength(1);
    expect(rows('[data-testid="file-search-empty"]')).toHaveLength(0);
  });

  it("offers a retry that re-runs the same query", async () => {
    const { search } = await mount(
      { kind: "home", projectId: "p1" },
      { ok: false, error: "Search is unavailable" },
    );
    await type("needle");
    expect(search).toHaveBeenCalledTimes(1);

    const retry = document.querySelector<HTMLButtonElement>(
      '[data-testid="file-search-error"] button',
    );
    await act(async () => {
      retry?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });

    expect(search).toHaveBeenCalledTimes(2);
    expect(search).toHaveBeenLastCalledWith({ projectId: "p1", query: "needle" });
  });

  it("claims no matches only once a search has actually returned none", async () => {
    await mount(
      { kind: "home", projectId: "p1" },
      { ok: true, files: [], matches: 0, limit: "none" },
    );

    await type("needle");

    expect(rows('[data-testid="file-search-empty"]')).toHaveLength(1);
    expect(rows('[data-testid="file-search-error"]')).toHaveLength(0);
  });
});

/** A search whose answer the test decides when to give. */
function deferred() {
  const queue: ((result: FileSearchResult) => void)[] = [];
  return {
    next: async () => await new Promise<FileSearchResult>((resolve) => queue.push(resolve)),
    async settle(result: FileSearchResult) {
      const resolve = queue.shift();
      await act(async () => {
        resolve?.(result);
      });
    },
  };
}

describe("a re-search over results already on screen", () => {
  it("keeps the rows and names both queries while the new one is in flight", async () => {
    const answers = deferred();
    await mount({ kind: "home", projectId: "p1" }, answers.next);

    await type("needle");
    await answers.settle(oneMatch);
    expect(rows('[data-testid="file-search-match"]')).toHaveLength(1);

    await type("needles");

    expect(rows('[data-testid="file-search-match"]')).toHaveLength(1);
    expect(document.querySelector('[data-testid="file-search-summary"]')?.textContent).toBe(
      "Searching “needles” · results below are for “needle”",
    );
  });

  it("keeps the rows when the re-search fails, and says so on the heading", async () => {
    const answers = deferred();
    await mount({ kind: "home", projectId: "p1" }, answers.next);

    await type("needle");
    await answers.settle(oneMatch);
    await type("needles");
    await answers.settle({ ok: false, error: "Search is unavailable" });

    // The rows are still there, because they were true for the query they name.
    expect(rows('[data-testid="file-search-match"]')).toHaveLength(1);
    // The fault rides the heading rather than replacing the list.
    const status = document.querySelector('[data-testid="file-search-read-status"]');
    expect(status?.getAttribute("data-read-status")).toBe("refresh-failed");
    expect(rows('[data-testid="file-search-error"]')).toHaveLength(0);
    expect(document.querySelector('[data-testid="file-search-summary"]')?.textContent).toBe(
      "Last read for “needle” · 1 match in 1 file",
    );
  });

  it("writes nothing after the page is gone", async () => {
    const answers = deferred();
    await mount({ kind: "home", projectId: "p1" }, answers.next);
    await type("needle");

    await act(async () => {
      root?.unmount();
    });
    root = null;

    // Landing after the unmount must be a no-op, not a state write.
    await expect(answers.settle(oneMatch)).resolves.toBeUndefined();
  });
});

/**
 * VC-406 review: the mislabelled window was the DEBOUNCE, not the request. A
 * query typed over a retained answer is a different question from the moment it
 * is typed, and the 200ms before any IPC leaves is where a rapidly edited query
 * spends most of its visible life.
 */
describe("a query typed over an answer, before the debounce elapses", () => {
  it("names the pending question and says which query the rows belong to", async () => {
    const answers = deferred();
    await mount({ kind: "home", projectId: "p1" }, answers.next);
    await type("needle");
    await answers.settle(oneMatch);
    expect(summaryText()).toBe("1 match in 1 file");

    // No debounce settle: nothing has been asked of main yet.
    await typeOnly("needles");

    expect(summaryText()).toBe("Searching “needles” · results below are for “needle”");
    // The rows stay, because they are still the answer they name.
    expect(rows('[data-testid="file-search-match"]')).toHaveLength(1);
  });

  it("says it is searching before the first request leaves, rather than nothing", async () => {
    const answers = deferred();
    await mount({ kind: "home", projectId: "p1" }, answers.next);

    await typeOnly("needle");

    expect(summaryText()).toBe("Searching “needle”…");
    expect(rows('[data-testid="file-search-pending"]')).toHaveLength(1);
  });

  it("does not talk over a failure with a search that is not happening", async () => {
    const answers = deferred();
    await mount({ kind: "home", projectId: "p1" }, answers.next);
    await type("needle");
    await answers.settle(oneMatch);
    await type("needles");
    await answers.settle({ ok: false, error: "Search is unavailable" });
    expect(summaryText()).toBe("Last read for “needle” · 1 match in 1 file");

    // Typing again while the last attempt is still the failed one: nothing is in
    // flight, so the line keeps naming what the rows are and the heading keeps
    // the fault and its retry.
    await typeOnly("needlessly");

    expect(summaryText()).toBe("Last read for “needle” · 1 match in 1 file");
    expect(
      document
        .querySelector('[data-testid="file-search-read-status"]')
        ?.getAttribute("data-read-status"),
    ).toBe("refresh-failed");

    // Once the debounce elapses the read really is out, and the line names both
    // questions again.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 260));
    });

    expect(summaryText()).toBe("Searching “needlessly” · results below are for “needle”");
  });
});

/**
 * VC-406 review: the rail mounts this page ONCE and hands it another scope, so
 * the old answer has to be gone in the same frame the new scope's name arrives —
 * a click on a retained row opens a path in a checkout the reader is no longer
 * looking at.
 */
describe("a scope swapped under the page", () => {
  async function show(scope: SearchScope): Promise<void> {
    await act(async () => {
      root?.render(
        <FileSearchPanel scope={scope} root="volli/VC-193-search" onOpenMatch={onOpenMatch} />,
      );
    });
  }

  it("drops the previous checkout's matches in the frame the new scope arrives", async () => {
    const answers = deferred();
    await mount({ kind: "ticket", projectId: "p1", ticketId: "t1" }, answers.next);
    await type("needle");
    await answers.settle(oneMatch);
    const before = document.querySelector('[data-testid="file-search-panel"]');
    expect(rows('[data-testid="file-search-match"]')).toHaveLength(1);

    await show({ kind: "ticket", projectId: "p1", ticketId: "t2" });

    // Keyed by the scope: a new instance, not the old one asked to forget.
    const after = document.querySelector('[data-testid="file-search-panel"]');
    expect(after).not.toBe(before);
    expect(before?.isConnected).toBe(false);
    expect(rows('[data-testid="file-search-match"]')).toHaveLength(0);
    expect(summaryText()).toBeNull();
    expect(rows('[data-testid="file-search-idle"]')).toHaveLength(1);
  });

  it("lets a search the old scope left in flight write nothing here", async () => {
    const answers = deferred();
    await mount({ kind: "ticket", projectId: "p1", ticketId: "t1" }, answers.next);
    await type("needle");

    await show({ kind: "ticket", projectId: "p1", ticketId: "t2" });
    // The first ticket's search answering after the swap.
    await answers.settle(oneMatch);

    expect(rows('[data-testid="file-search-match"]')).toHaveLength(0);
    expect(rows('[data-testid="file-search-error"]')).toHaveLength(0);
    expect(rows('[data-testid="file-search-idle"]')).toHaveLength(1);
  });
});

describe("the query across a tab switch", () => {
  it("remembers what was typed, per checkout", async () => {
    await mount({ kind: "ticket", projectId: "p1", ticketId: "t1" });
    await type("needle");

    expect(
      readNavigatorView(navigatorScopeKey("search", { projectId: "p1", ticketId: "t1" })),
    ).toEqual({ cwd: "", filtering: false, query: "needle" });
    // Another ticket's Search page is a different question about a different
    // checkout, and must not inherit it.
    expect(
      readNavigatorView(navigatorScopeKey("search", { projectId: "p1", ticketId: "t2" })).query,
    ).toBe("");
    expect(readNavigatorView(navigatorScopeKey("search", { projectId: "p1" })).query).toBe("");
  });

  it("comes back with the words still in the box after a remount", async () => {
    await mount({ kind: "ticket", projectId: "p1", ticketId: "t1" });
    await type("needle");
    await act(async () => {
      root?.unmount();
    });
    root = null;
    container?.remove();

    const { search } = await mount({ kind: "ticket", projectId: "p1", ticketId: "t1" });

    expect(document.querySelector("input")?.value).toBe("needle");
    // And it asks again for what is in the box, rather than drawing an idle page.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 260));
    });
    expect(search).toHaveBeenCalledWith({ projectId: "p1", ticketId: "t1", query: "needle" });
  });
});
