/**
 * The section header draws ONE rule, not two.
 *
 * `PrefRow` suppresses its own top border with `first:border-t-0`, which only
 * fires when the row really is its parent's first child. When rows were direct
 * children of the `<section>`, the HEADER was the first child instead, `first:`
 * matched nothing, and every section on both surfaces drew the header's rule
 * and the first row's rule eight pixels apart.
 *
 * The wrapper is what fixes it, so the wrapper is what these assert. Checking
 * only that the row still carries `first:border-t-0` would pass with the
 * wrapper deleted and the bug back.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { PrefRow } from "./pref-row";
import { PrefSection } from "./pref-section";

function twoRows() {
  return renderToStaticMarkup(
    <PrefSection title="Window">
      <PrefRow label="Show the project switcher">
        <input aria-label="switcher" type="checkbox" />
      </PrefRow>
      <PrefRow label="Keep the sidebar open">
        <input aria-label="sidebar" type="checkbox" />
      </PrefRow>
    </PrefSection>,
  );
}

describe("PrefSection", () => {
  it("wraps its rows, so the first row is a first child and `first:` can fire", () => {
    // The header's own `</div>`, then a bare wrapper, then the first row. If
    // the wrapper goes, the row follows the header as a sibling and this fails.
    expect(twoRows()).toMatch(/<\/div><div><div class="flex justify-between/);
  });

  it("draws the rule under the header exactly once", () => {
    const html = twoRows();
    const header = html.slice(0, html.indexOf("Show the project switcher"));

    // The lookahead matters: a bare /border-b/ also matches inside
    // `border-border/50`, which is the colour, and counted three.
    expect(header.match(/border-b(?![a-z-])/g)).toHaveLength(1);
    expect(html).toContain("first:border-t-0");
  });

  it("still rules BETWEEN rows, which is what the hairlines are for", () => {
    const html = twoRows();
    const rows = html.match(/class="flex justify-between[^"]*"/g) ?? [];

    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row).toContain("border-t");
  });

  it("has no rule at all when a section holds something other than rows", () => {
    // A table draws its own header hairline, so the section's rule is the only
    // one it should meet.
    const html = renderToStaticMarkup(
      <PrefSection title="Skills">
        <p>a table would go here</p>
      </PrefSection>,
    );

    expect(html).toMatch(/<\/div><div><p>/);
  });
});
