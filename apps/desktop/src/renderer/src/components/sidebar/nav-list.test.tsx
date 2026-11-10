// @vitest-environment jsdom
/**
 * The primary nav's shape (VC-127): that Automations is a nav DESTINATION
 * beside Home, and not a room inside Home.
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
  it("offers Automations as its own row beside Home", () => {
    const markup = draw();

    expect(markup).toContain("Home");
    expect(markup).toContain("Automations");
    // Agent configuration is in the persistent Settings footer, not a third destination.
    expect(markup).not.toContain(">Configure<");
  });

  it("puts Home and Automations in sibling rows rather than nesting them", () => {
    const markup = draw();
    const home = markup.indexOf(">Home<");
    const automations = markup.indexOf(">Automations<");
    const doc = new DOMParser().parseFromString(markup, "text/html");
    const menu = doc.querySelector('[data-slot="sidebar-menu"]')!;

    expect(home).toBeGreaterThan(-1);
    expect(automations).toBeGreaterThan(home);
    expect(menu.children).toHaveLength(2);
    expect([...menu.children].map((row) => row.textContent)).toEqual(["Home", "Automations"]);
  });
});
