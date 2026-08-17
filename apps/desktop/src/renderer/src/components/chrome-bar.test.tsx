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
  });
});
