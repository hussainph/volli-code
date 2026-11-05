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
      expect(toggle).toContain('data-size="icon"');
      expect(toggle).toContain('data-variant="toolbar"');
    }
    expect(html).toContain("search-capsule");
    expect(html).toContain("size-4");
  });
  it("groups sidebar toggles with history, leaves search centred and puts inspection last", () => {
    const html = renderToStaticMarkup(
      <SidebarProvider>
        <ChromeBar />
      </SidebarProvider>,
    );
    const names = [
      "Back",
      "Forward",
      "Hide project switcher",
      "Toggle navigation sidebar",
      "Search tickets, sessions, and commands",
      "Hide details rail",
    ];
    const offsets = names.map((name) => html.indexOf(`aria-label="${name}"`));
    expect(offsets.every((at) => at >= 0)).toBe(true);
    expect(offsets).toEqual(offsets.toSorted((a, b) => a - b));
    const cluster = html.slice(html.indexOf("absolute left-1/2 top-1/2"));
    expect(cluster).not.toContain('aria-label="Toggle navigation sidebar"');
    expect(html).toContain('data-inspector-trigger="shell"');
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
