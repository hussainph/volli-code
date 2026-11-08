import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { PrefRow } from "./pref-row";
import { PrefSection } from "./pref-section";

describe("PrefSection", () => {
  it("keeps the heading outside the single framed row group", () => {
    const html = renderToStaticMarkup(
      <PrefSection
        title="Terminal"
        hint="Volli writes an overlay file and never edits your Ghostty config."
      >
        <PrefRow label="Zoom">
          <input />
        </PrefRow>
        <PrefRow label="Diff layout">
          <input />
        </PrefRow>
      </PrefSection>,
    );
    expect(html.indexOf("Terminal")).toBeLessThan(html.indexOf("rounded-container"));
    expect(html).toContain("never edits your Ghostty config");
    expect(html).not.toContain("border-b ");
    expect(html.match(/first:border-t-0/g)).toHaveLength(2);
    expect(html).not.toContain("About Terminal");
  });
});

it("hides only an explicitly redundant title while preserving the named group and actions", () => {
  const html = renderToStaticMarkup(
    <PrefSection title="Skills" titleHidden action={<button>Reload</button>}>
      <PrefRow label="Mode">
        <input />
      </PrefRow>
    </PrefSection>,
  );
  expect(html).toContain("aria-labelledby=");
  expect(html).toContain('data-slot="pref-section-title"');
  expect(html).toContain("text-ui font-medium");
  expect(html).toContain("gap-2 sr-only");
  expect(html).toContain("Reload");
  expect(html).toContain("rounded-container border");
});
