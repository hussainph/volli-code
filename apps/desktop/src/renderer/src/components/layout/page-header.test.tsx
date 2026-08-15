import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { PageHeader } from "./page-header";

describe("PageHeader", () => {
  it("titles the page with an h1 and draws nothing for the slots it wasn't given", () => {
    const html = renderToStaticMarkup(<PageHeader title="Board" />);

    expect(html).toContain("<h1");
    expect(html).toContain("Board");
    // No description paragraph and no actions cluster when neither was passed —
    // an empty right-parked div would still consume the row's `ml-auto`.
    expect(html).not.toContain("<p");
    expect(html).not.toContain("ml-auto");
  });

  it("keeps actions parked right of whatever flows through children", () => {
    const html = renderToStaticMarkup(
      <PageHeader title="Board" actions={<button type="button">New ticket</button>}>
        <span>12</span>
      </PageHeader>,
    );

    expect(html.indexOf(">12<")).toBeLessThan(html.indexOf("New ticket"));
    expect(html).toContain("ml-auto");
  });

  it("takes its inset from the reading column and its title one step above the sections below", () => {
    const workbench = renderToStaticMarkup(<PageHeader title="Board" />);
    const reading = renderToStaticMarkup(
      <PageHeader variant="reading" title="Appearance" description="Theming for this project." />,
    );

    // Tier B pays its own gutter; Tier A is already inside <ContentColumn>'s.
    expect(workbench).toContain("px-gutter");
    expect(reading).not.toContain("px-gutter");
    expect(workbench).toContain("text-sm font-semibold");
    expect(reading).toContain("text-heading font-semibold");
    expect(reading).toContain("Theming for this project.");
  });
});
