import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { PrefRow } from "./pref-row";
import { PrefSection } from "./pref-section";

describe("PrefSection", () => {
  it("keeps the heading outside the single framed row group", () => {
    const html = renderToStaticMarkup(
      <PrefSection title="Window" hint="Applies to this window.">
        <PrefRow label="Zoom">
          <input />
        </PrefRow>
        <PrefRow label="Diff layout">
          <input />
        </PrefRow>
      </PrefSection>,
    );
    expect(html.indexOf("Window")).toBeLessThan(html.indexOf("rounded-container"));
    expect(html).toContain("Applies to this window.");
    expect(html).not.toContain("border-b ");
    expect(html.match(/first:border-t-0/g)).toHaveLength(2);
    expect(html).not.toContain("About Window");
  });
});
