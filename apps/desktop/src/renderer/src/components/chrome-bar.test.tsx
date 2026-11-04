/**
 * The chrome band's copy, pinned where it carries CONTEXT.md's VC-57 naming
 * ruling: "project" is the one user-facing word for a rail entry. The rail
 * toggle's aria-label/title/sr-only were the last surfaces still saying
 * "workspace switcher", and prose alone is how that drifted in the first
 * place. Static markup with the app's own `SidebarProvider` wrapper (it wraps
 * the whole real tree); effects never run, and every store read lands on
 * shipped defaults.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { SidebarProvider } from "@renderer/components/ui/sidebar";

import { ChromeBar } from "./chrome-bar";

describe("chrome band copy", () => {
  it("gives both sidebar toggles the same icon box", () => {
    const html = renderToStaticMarkup(
      <SidebarProvider>
        <ChromeBar />
      </SidebarProvider>,
    );
    const buttons = html.match(/<button[^>]+>/g) ?? [];
    const toggles = buttons.filter((button) =>
      /aria-label="(?:Hide project switcher|Toggle navigation sidebar)"/.test(button),
    );
    expect(toggles).toHaveLength(2);
    for (const toggle of toggles) {
      expect(toggle).toContain('data-size="icon-sm"');
      expect(toggle).toContain('data-variant="toolbar"');
    }
    expect(html).toContain("search-capsule");
    expect(html).toContain("[&amp;_svg:not([class*=&#x27;size-&#x27;])]:size-4");
  });
  it("keeps the two toggles immediately beside search in the centered cluster", () => {
    const html = renderToStaticMarkup(
      <SidebarProvider>
        <ChromeBar />
      </SidebarProvider>,
    );
    const cluster = html.slice(html.indexOf("absolute left-1/2 top-[19px]"));
    expect(cluster.indexOf('aria-label="Hide project switcher"')).toBeLessThan(
      cluster.indexOf('aria-label="Toggle navigation sidebar"'),
    );
    expect(cluster.indexOf('aria-label="Toggle navigation sidebar"')).toBeLessThan(
      cluster.indexOf('aria-label="Search tickets, sessions, and commands"'),
    );
  });
  it("labels the rail toggle with the ruled word — project switcher, never workspace", () => {
    const html = renderToStaticMarkup(
      <SidebarProvider>
        <ChromeBar />
      </SidebarProvider>,
    );

    expect(html).toContain("project switcher");
    expect(html).not.toContain("workspace switcher");
    // The sidebar trigger beside it names the pane, not the rail concept.
    expect(html).toContain("Toggle navigation sidebar");
    // Usage limits is window chrome too, so every ordinary page inherits it.
    expect(html).toContain('aria-label="Usage limits"');
  });
});
