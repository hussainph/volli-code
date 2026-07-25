import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { FileTabStrip } from "./file-tab-strip";

const noop = () => {};

function render(
  tabs: readonly { relPath: string; pinned: boolean }[],
  activeRelPath: string | null,
  dirtyPaths: ReadonlySet<string> = new Set(),
) {
  return renderToStaticMarkup(
    <FileTabStrip
      tabs={tabs}
      activeRelPath={activeRelPath}
      dirtyPaths={dirtyPaths}
      onSelect={noop}
      onPin={noop}
      onClose={noop}
      onCloseOthers={noop}
    />,
  );
}

describe("FileTabStrip", () => {
  it("renders one tab per open file, labelled by basename", () => {
    const html = render(
      [
        { relPath: "src/main/index.ts", pinned: true },
        { relPath: "docs/CONCEPT.md", pinned: true },
      ],
      "docs/CONCEPT.md",
    );

    expect(html).toContain('data-testid="file-tab-strip"');
    expect(html).toContain('data-rel-path="src/main/index.ts"');
    expect(html).toContain('data-rel-path="docs/CONCEPT.md"');
    expect(html).toContain("CONCEPT.md");
  });

  it("exposes a tablist with roving tabindex on the active tab", () => {
    const html = render(
      [
        { relPath: "a.ts", pinned: true },
        { relPath: "b.ts", pinned: true },
      ],
      "b.ts",
    );

    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-selected="true"');
    // Exactly one tab is reachable by Tab; the arrows move between them.
    expect(html.match(/tabindex="0"/g)).toHaveLength(1);
    expect(html.match(/tabindex="-1"/g)).toHaveLength(1);
    // …and it is the ACTIVE tab that holds the tab stop.
    expect(html).toMatch(/data-rel-path="b\.ts"[^>]*tabindex="0"/);
  });

  it("keeps the strip keyboard-reachable when no tab is active — the first tab takes the tab stop", () => {
    // A strip can be open with nothing active (nothing selected yet, or an
    // activeRelPath naming a tab that is no longer open). Keying the roving
    // tabindex solely off `active` would leave every tab at -1 and drop the
    // whole strip out of the document's tab order.
    for (const active of [null, "gone.ts"]) {
      const html = render(
        [
          { relPath: "a.ts", pinned: true },
          { relPath: "b.ts", pinned: true },
        ],
        active,
      );

      expect(html.match(/tabindex="0"/g)).toHaveLength(1);
      expect(html.match(/tabindex="-1"/g)).toHaveLength(1);
      // The fallback entry point is the FIRST tab…
      expect(html).toMatch(/data-rel-path="a\.ts"[^>]*tabindex="0"/);
      // …and a tab stop is not a selection: nothing is marked active.
      expect(html).not.toContain('aria-selected="true"');
    }
  });

  it("renders a preview tab's label in italics — the unpinned/replaceable convention", () => {
    const html = render([{ relPath: "src/index.ts", pinned: false }], "src/index.ts");

    expect(html).toContain('data-preview="true"');
    expect(html).toContain("italic");
  });

  it("does not italicize a pinned tab", () => {
    const html = render([{ relPath: "src/index.ts", pinned: true }], "src/index.ts");

    expect(html).toContain('data-preview="false"');
    expect(html).not.toContain("italic");
  });

  it("shows a dirty indicator on a tab with unsaved changes", () => {
    const html = render(
      [{ relPath: "src/index.ts", pinned: true }],
      "src/index.ts",
      new Set(["src/index.ts"]),
    );

    expect(html).toContain('data-testid="file-tab-dirty"');
    expect(html).toContain('data-dirty="true"');
    expect(html).toContain("Unsaved changes");
  });

  it("gives every tab a close control the smoke can target", () => {
    const html = render([{ relPath: "src/index.ts", pinned: true }], "src/index.ts");

    expect(html).toContain('data-testid="file-tab-close"');
    expect(html).toContain('aria-label="Close index.ts"');
  });

  it("disambiguates tabs that share a basename with a muted parent hint", () => {
    const html = render(
      [
        { relPath: "src/main/index.ts", pinned: true },
        { relPath: "src/preload/index.ts", pinned: true },
      ],
      "src/main/index.ts",
    );

    expect(html).toContain("main");
    expect(html).toContain("preload");
    expect(html).toContain('data-testid="file-tab-hint"');
  });

  it("renders nothing at all when no file is open", () => {
    expect(render([], null)).toBe("");
  });
});
