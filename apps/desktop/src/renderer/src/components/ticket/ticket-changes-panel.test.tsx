// @vitest-environment jsdom
/**
 * What a Change Set row IS, for the two readers who cannot see it (VC-311).
 *
 * A real DOM rather than a string of markup, because every question this file
 * asks is about something a string cannot answer: which element a keyboard
 * lands on, what the accessibility tree calls it, where the focus goes when a
 * diff opens and closes again, and whether a bubble opens over a row that is
 * hiding nothing. jsdom lays nothing out, so the one fact it cannot supply —
 * whether a line is clipped — is stubbed onto the line the way
 * `models/model-name.test.tsx` and `ui/tab-strip.test.tsx` stub it.
 *
 * The fixture is the audit's own: seven files, two of them the confusable pair
 * `split-view-divider.test.tsx` and `split-view-divider.tsx`.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ChangeSetFile } from "@volli/shared";

import {
  TicketChangesList,
  toChangeListRow,
  WorktreeStateStrip,
  type ChangeListRow,
} from "./ticket-changes-panel";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { sortChangeSetFiles } from "./ticket-changes-model";
import { EMPTY_CHANGE_RECENCY_STATE } from "./ticket-change-recency";

function file(overrides: Partial<ChangeSetFile> & Pick<ChangeSetFile, "path">): ChangeSetFile {
  return {
    status: "modified",
    insertions: 1,
    deletions: 0,
    binary: false,
    ...overrides,
  };
}

const noop = (_path: string): void => {};

/** The audit's seven-file change set, including the confusable pair. */
const AUDIT_CHANGE_SET: readonly ChangeSetFile[] = [
  file({
    path: "apps/desktop/src/renderer/src/components/split/split-view-divider.test.tsx",
    insertions: 11,
    deletions: 2,
  }),
  file({
    path: "apps/desktop/src/renderer/src/components/ui/split-view-divider.tsx",
    insertions: 34,
    deletions: 12,
  }),
  file({
    path: "apps/desktop/src/renderer/src/components/ticket/rail-panel-parts.tsx",
    status: "added",
    insertions: 96,
    deletions: 0,
  }),
  file({
    path: "apps/desktop/src/renderer/src/components/ticket/ticket-changes-model.ts",
    previousPath: "apps/desktop/src/renderer/src/components/ticket/changes-model.ts",
    status: "renamed",
    insertions: 8,
    deletions: 4,
  }),
  file({ path: "apps/desktop/src/renderer/lab/fixtures.ts", status: "untracked", deletions: 0 }),
  file({ path: "assets/volli-mark.png", status: "added", binary: true }),
  file({ path: "README.md", insertions: 2, deletions: 2 }),
];

/** Row actions are tooltip triggers; the real tree always has a provider. */
function render(rows: readonly ChangeListRow[], props: { hiddenCount?: number } = {}): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <TicketChangesList rows={rows} currentPath={null} onSelectRow={noop} {...props} />
    </TooltipProvider>,
  );
}

function listRows(files: readonly ChangeSetFile[]): ChangeListRow[] {
  return sortChangeSetFiles(files).map((f) => toChangeListRow(f, EMPTY_CHANGE_RECENCY_STATE));
}

describe("WorktreeStateStrip", () => {
  it("renders working, local, and remote state as one compact summary", () => {
    const html = renderToStaticMarkup(
      <WorktreeStateStrip
        status={{
          uncommitted: true,
          sequencerActive: false,
          aheadOfBase: 3,
          behindBase: 0,
          unpushed: 1,
        }}
      />,
    );

    expect(html).toContain('data-testid="ticket-changes-git-state"');
    expect(html).toContain("Working");
    expect(html).toContain("Changes");
    expect(html).toContain("Local");
    expect(html).toContain("3 commits");
    expect(html).toContain("Remote");
    expect(html).toContain("1 to push");
  });
});

describe("TicketChangesList markup", () => {
  it("renders a compact flat list with filename leading and parent muted", () => {
    const html = render(
      listRows([
        file({ path: "src/rail.tsx", insertions: 11, deletions: 2 }),
        file({
          path: "assets/logo.png",
          status: "added",
          insertions: null,
          deletions: null,
          binary: true,
        }),
        file({
          path: "src/new.ts",
          previousPath: "src/old.ts",
          status: "renamed",
          insertions: 0,
          deletions: 0,
        }),
        file({ path: "conflicted.ts", status: "conflicted", insertions: 1, deletions: 1 }),
      ]),
    );

    expect(html).toContain("rail.tsx");
    expect(html).toContain("Modified");
    expect(html).toContain("Binary");
    expect(html).toContain("Conflicted");
    expect(html).toContain("←");
    expect(html).toContain("src/old.ts");
    // Flat list — no nested tree markup.
    expect(html).not.toContain("<ul><ul>");
    expect(html).toContain('data-testid="ticket-changes-list"');
  });

  it("colours insertions and deletions as two spans", () => {
    // The two halves are separate marks in separate inks, so they must not be
    // rendered from one joined string.
    const html = render(listRows([file({ path: "src/rail.tsx", insertions: 11, deletions: 2 })]));

    expect(html).toContain(">+11<");
    expect(html).toContain(">−2<");
    expect(html).not.toContain("+11 −2");
  });

  it("gives every Change Set status a glyph", () => {
    for (const status of [
      "added",
      "modified",
      "deleted",
      "renamed",
      "untracked",
      "conflicted",
    ] as const) {
      const html = render(listRows([file({ path: "a.ts", status })]));
      expect(html).toContain("<svg");
    }
  });

  it("renders a framed empty state when there are no changes", () => {
    const html = render([]);
    expect(html).toContain("No changes vs base");
    expect(html).toContain("The branch is up to date.");
  });

  it("says how many files the cap left out rather than silently dropping them", () => {
    const html = render(listRows([file({ path: "src/a.ts" })]), { hiddenCount: 4000 });
    expect(html).toContain('data-testid="ticket-changes-truncated"');
    expect(html).toContain("more files not shown");
  });

  it("has no trailing row when nothing was cut", () => {
    const html = render(listRows([file({ path: "src/a.ts" })]));
    expect(html).not.toContain('data-testid="ticket-changes-truncated"');
  });

  it("renders updated awareness as visible text with an accessible explanation", () => {
    const html = render([
      {
        ...toChangeListRow(file({ path: "src/ticket.tsx" }), EMPTY_CHANGE_RECENCY_STATE),
        updatedLabel: "Updated",
        updatedDescription: "Updated since you last opened this file",
      },
    ]);

    expect(html).toContain(">Updated<");
    expect(html).toContain('aria-label="Updated since you last opened this file"');
  });
});

let container: HTMLElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  vi.unstubAllGlobals();
});

function mount(props: {
  files?: readonly ChangeSetFile[];
  rows?: readonly ChangeListRow[];
  currentPath?: string | null;
  onSelectRow?: (path: string) => void;
}): void {
  const rows = props.rows ?? listRows(props.files ?? AUDIT_CHANGE_SET);
  act(() => {
    root?.render(
      <TooltipProvider>
        <TicketChangesList
          rows={rows}
          currentPath={props.currentPath ?? null}
          onSelectRow={props.onSelectRow ?? noop}
        />
      </TooltipProvider>,
    );
  });
}

function list(): HTMLElement {
  const found = container?.querySelector<HTMLElement>('[data-testid="ticket-changes-list"]');
  if (found === null || found === undefined) throw new Error("no changes list");
  return found;
}

/** The row's activation target — the element a pointer and a keyboard land on. */
function row(path: string): HTMLElement {
  const found = container?.querySelector<HTMLElement>(
    `[data-testid="ticket-changes-row"][data-path="${path}"]`,
  );
  if (found === null || found === undefined) throw new Error(`no row for ${path}`);
  return found;
}

/** The `<li>` that row belongs to, actions included. */
function item(path: string): HTMLElement {
  const found = row(path).closest("li");
  if (found === null) throw new Error(`row ${path} is not in a list item`);
  return found;
}

/** Both drawn lines of a row, name first. */
function lines(path: string): HTMLElement[] {
  return [...item(path).querySelectorAll<HTMLElement>('[data-slot="changes-row-line"]')];
}

/** jsdom measures nothing; this is a line too long for the box it is drawn in. */
function clip(element: HTMLElement): void {
  Object.defineProperty(element, "clientWidth", { configurable: true, get: () => 120 });
  Object.defineProperty(element, "scrollWidth", { configurable: true, get: () => 480 });
}

/** What the reveal is saying, if it is open at all. It portals to the body. */
function revealText(): string | null {
  return document.body.querySelector('[data-slot="tooltip-content"]')?.textContent ?? null;
}

const PAIR_TEST = "apps/desktop/src/renderer/src/components/split/split-view-divider.test.tsx";
const PAIR_PLAIN = "apps/desktop/src/renderer/src/components/ui/split-view-divider.tsx";
const RENAMED = "apps/desktop/src/renderer/src/components/ticket/ticket-changes-model.ts";

describe("the Change Set list in the accessibility tree", () => {
  // THE LIST IS A LIST, NOT A LISTBOX: an `option` may not hold interactive
  // descendants, and every row here holds three (the activation target plus
  // Copy and Open). The old `listbox`/`option` pair was a content-model
  // violation screen readers answer by flattening the row.
  it("is a named list of list items, with no selection-widget roles anywhere", () => {
    mount({});

    expect(list().tagName).toBe("UL");
    expect(list().getAttribute("role")).toBeNull();
    expect(list().getAttribute("aria-label")).toBe("Change Set");
    expect(list().querySelectorAll("li")).toHaveLength(AUDIT_CHANGE_SET.length);
    expect(container?.querySelector('[role="listbox"]')).toBeNull();
    expect(container?.querySelector('[role="option"]')).toBeNull();
    expect(container?.querySelector("[aria-selected]")).toBeNull();
  });

  it("keeps every row's three controls inside its own list item, named for its file", () => {
    // The finding behind the ticket: the actions are SIBLINGS of the activation
    // target, so the row must be something that may legally hold them.
    mount({});
    const buttons = [...item(PAIR_TEST).querySelectorAll("button")];

    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual([
      `Modified: ${PAIR_TEST}, 11 insertions, 2 deletions`,
      `Copy ${PAIR_TEST}`,
      `Open ${PAIR_TEST} in tab`,
    ]);
    // A row is a button, which is what makes Enter and Space open a diff
    // without this list implementing a keyboard model of its own.
    expect(row(PAIR_TEST).tagName).toBe("BUTTON");
  });

  it("names every file with its status, its FULL path and its counts in words", () => {
    mount({});

    expect(
      [...list().querySelectorAll<HTMLElement>('[data-testid="ticket-changes-row"]')].map((r) =>
        r.getAttribute("aria-label"),
      ),
    ).toEqual([
      // Path order, which is the list's own (decision #53).
      "Modified: README.md, 2 insertions, 2 deletions",
      "Untracked: apps/desktop/src/renderer/lab/fixtures.ts, 1 insertion, 0 deletions",
      `Modified: ${PAIR_TEST}, 11 insertions, 2 deletions`,
      "Added: apps/desktop/src/renderer/src/components/ticket/rail-panel-parts.tsx, 96 insertions, 0 deletions",
      `Renamed: ${RENAMED}, 8 insertions, 4 deletions, renamed from apps/desktop/src/renderer/src/components/ticket/changes-model.ts`,
      `Modified: ${PAIR_PLAIN}, 34 insertions, 12 deletions`,
      "Added: assets/volli-mark.png, binary file",
    ]);
  });

  it("marks the row whose diff is on screen current, and only that one", () => {
    mount({ currentPath: PAIR_PLAIN });

    expect(row(PAIR_PLAIN).getAttribute("aria-current")).toBe("true");
    expect(row(PAIR_TEST).getAttribute("aria-current")).toBeNull();
    expect(container?.querySelectorAll('[aria-current="true"]')).toHaveLength(1);
  });

  it("says no row is current when the person is looking at something else", () => {
    // The stale-announcement bug: `current` used to be the last row CLICKED,
    // which nothing ever took back — so a closed diff went on being announced
    // as the current file.
    mount({ currentPath: PAIR_PLAIN });
    mount({ currentPath: null });

    expect(container?.querySelector('[aria-current="true"]')).toBeNull();
  });
});

describe("opening and closing a diff from the keyboard", () => {
  it("activates the focused row and keeps the keyboard on it through open and close", () => {
    const opened: string[] = [];
    mount({ onSelectRow: (path) => opened.push(path) });

    act(() => row(PAIR_TEST).focus());
    act(() => row(PAIR_TEST).click());
    expect(opened).toEqual([PAIR_TEST]);

    // The host answers by opening the diff tab, which comes back as a new
    // `currentPath`. The keyboard must not move when it does.
    mount({ currentPath: PAIR_TEST, onSelectRow: (path) => opened.push(path) });
    expect(document.activeElement).toBe(row(PAIR_TEST));

    // …and must not move when the diff is closed again.
    mount({ currentPath: null, onSelectRow: (path) => opened.push(path) });
    expect(document.activeElement).toBe(row(PAIR_TEST));
    expect(opened).toEqual([PAIR_TEST]);
  });

  it("holds the keyboard still while a filesystem refresh rewrites the rows", () => {
    // Decision #48, where it actually lives: a refresh replaces the row array,
    // and a row that lost its DOM element would drop the keyboard on the body.
    mount({});
    act(() => row(PAIR_TEST).focus());

    mount({ files: [...AUDIT_CHANGE_SET, file({ path: "src/fresh-untracked.ts" })] });

    expect(document.activeElement).toBe(row(PAIR_TEST));
    expect(row(PAIR_TEST).getAttribute("aria-current")).toBeNull();
  });
});

describe("what a row shows at rail width", () => {
  it("draws each line as ONE text node, so nothing reads a name broken in half", () => {
    // A truncating span beside a `shrink-0` span draws the same picture and
    // then answers `innerText` — and a copy, and find-in-page, and this repo's
    // Change Set smokes — with `split-view-divider\n.test.tsx`.
    mount({});
    const [name, path] = lines(PAIR_TEST);

    expect(name?.childNodes).toHaveLength(1);
    expect(name?.textContent).toBe("split-view-divider.test.tsx");
    expect(path?.textContent).toBe("apps/desktop/src/renderer/src/components/split");
  });

  it("ellipsizes each line at its START, so the end that tells files apart survives", () => {
    mount({});

    for (const line of [...lines(PAIR_TEST), ...lines(PAIR_PLAIN)]) {
      expect(line.className).toContain("truncate");
      // An rtl box ellipsizes at its start edge; `text-left` keeps a short
      // name off the right margin, and the inner `dir="ltr"` run keeps the
      // characters in their own order.
      expect(line.getAttribute("dir")).toBe("rtl");
      expect(line.className).toContain("text-left");
      expect(line.firstElementChild?.getAttribute("dir")).toBe("ltr");
    }
  });

  it("keeps the confusable pair apart by the ends of both of its lines", () => {
    mount({});
    const [testName, testPath] = lines(PAIR_TEST);
    const [plainName, plainPath] = lines(PAIR_PLAIN);

    // What survives a start-side cut is the tail, and these tails differ twice
    // over: `.test.tsx` against `.tsx`, and `/split` against `/ui`.
    expect(testName?.textContent).not.toBe(plainName?.textContent);
    expect(testName?.textContent?.endsWith(".test.tsx")).toBe(true);
    expect(plainName?.textContent?.endsWith(".tsx")).toBe(true);
    expect(testPath?.textContent?.endsWith("/split")).toBe(true);
    expect(plainPath?.textContent?.endsWith("/ui")).toBe(true);
  });

  it("pins the rename mark outside the line, where the ellipsis cannot eat it", () => {
    mount({});
    const [, path] = lines(RENAMED);

    expect(item(RENAMED).textContent).toContain("←");
    expect(path?.textContent).toBe(
      "apps/desktop/src/renderer/src/components/ticket/changes-model.ts",
    );
  });
});

describe("the row's full-path reveal", () => {
  it("opens on the row's own focus when the PATH line is clipped", () => {
    mount({});
    const [, path] = lines(PAIR_TEST);
    if (path !== undefined) clip(path);

    act(() => row(PAIR_TEST).focus());

    expect(revealText()).toBe(PAIR_TEST);
  });

  it("opens when only the NAME line is clipped", () => {
    // The gap this replaced: the reveal was measured on the path line alone,
    // so a long filename over a short parent clipped in silence.
    mount({ files: [file({ path: "src/a-very-long-filename-indeed.tsx" })] });
    const [name] = lines("src/a-very-long-filename-indeed.tsx");
    if (name !== undefined) clip(name);

    act(() => row("src/a-very-long-filename-indeed.tsx").focus());

    expect(revealText()).toBe("src/a-very-long-filename-indeed.tsx");
  });

  it("stays quiet for a row that is drawing everything it holds", () => {
    // A bubble over a row hiding nothing is the noise that teaches people to
    // ignore the ones that matter.
    mount({});

    act(() => row("README.md").focus());

    expect(revealText()).toBeNull();
  });

  it("carries both paths of a rename", () => {
    mount({});
    const [, path] = lines(RENAMED);
    if (path !== undefined) clip(path);

    act(() => row(RENAMED).focus());

    expect(revealText()).toBe(
      `${RENAMED} ← apps/desktop/src/renderer/src/components/ticket/changes-model.ts`,
    );
  });

  it("closes again when the keyboard leaves the row", () => {
    mount({});
    const [, path] = lines(PAIR_TEST);
    if (path !== undefined) clip(path);
    act(() => row(PAIR_TEST).focus());
    expect(revealText()).toBe(PAIR_TEST);

    act(() => row(PAIR_TEST).blur());

    expect(revealText()).toBeNull();
  });
});
