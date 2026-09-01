// @vitest-environment jsdom
/**
 * The primary nav's shape (VC-127): that Automations is a nav DESTINATION
 * beside Home and Configure, and not a room inside Home.
 *
 * The guardrail this defends is written in `nav-list.tsx` itself and cited by
 * VC-112 — Home must not become a junk drawer. It is the kind of rule that is
 * never broken deliberately: a later ticket moves one page inside Home for a
 * good local reason, and nothing anywhere fails.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { NavList } from "./nav-list";
import { SidebarProvider } from "@renderer/components/ui/sidebar";

function draw(): string {
  return renderToStaticMarkup(
    <SidebarProvider>
      <NavList />
    </SidebarProvider>,
  );
}

describe("NavList", () => {
  it("offers Automations as its own row beside Home and Configure", () => {
    const markup = draw();

    expect(markup).toContain("Home");
    expect(markup).toContain("Automations");
    expect(markup).toContain("Configure");
  });

  it("puts Automations between Home and Configure rather than under either", () => {
    const markup = draw();
    const home = markup.indexOf(">Home<");
    const automations = markup.indexOf(">Automations<");
    const configure = markup.indexOf(">Configure<");

    expect(home).toBeGreaterThan(-1);
    expect(automations).toBeGreaterThan(home);
    expect(configure).toBeGreaterThan(automations);
  });
});
