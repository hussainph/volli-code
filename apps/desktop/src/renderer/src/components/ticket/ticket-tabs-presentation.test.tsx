import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { TicketTabStrip, type TicketTabDescriptor } from "./ticket-tabs";
const noop = () => {};
function render(tab: TicketTabDescriptor) {
  return renderToStaticMarkup(
    <TooltipProvider>
      <TicketTabStrip
        projectId="p1"
        ticketId="t1"
        tabs={[tab]}
        activeTabId={tab.id}
        onSelectTab={noop}
        onCloseTab={noop}
        onRenameSessionTab={noop}
        creating={false}
        onNewSession={noop}
        onNewChat={noop}
        onNewBrowser={noop}
        railCollapsed={false}
        onToggleRail={noop}
      />
    </TooltipProvider>,
  );
}
describe("ticket tab presentation", () => {
  it("draws chat activity with the shared state badge rather than a colour-only dot", () => {
    const html = render({ id: "chat:s1", kind: "chat", label: "Review", status: "waiting" });
    expect(html).toContain('data-session-glyph="waiting"');
    expect(html).toContain("Waiting for you");
    expect(html).not.toContain('data-slot="status-dot"');
    // The active tab is marked by main's folder silhouette (VC-614), not an inset ring.
  });
  it("keeps the file's preview and worktree marks beside its kind glyph", () => {
    const html = render({
      id: "file:README.md",
      kind: "file",
      label: "README.md",
      relPath: "README.md",
      preview: true,
      badge: "worktree",
    });
    expect(html).toContain('data-preview="true"');
    expect(html).toContain("italic");
    expect(html).toContain('aria-label="Worktree copy"');
  });
});
