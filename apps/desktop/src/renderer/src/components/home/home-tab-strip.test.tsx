import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { HOME_BOARD_TAB } from "./home-tab-strip";
import { HomeTabStrip, type HomeTabDescriptor } from "./home-tab-strip";

const noop = (): void => {};

function draw(tabs: readonly HomeTabDescriptor[], activeTabId: string): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <HomeTabStrip
        tabs={tabs}
        activeTabId={activeTabId}
        onSelect={noop}
        onClose={noop}
        onRename={noop}
        onPinFile={noop}
        onNewSession={noop}
        onNewChat={noop}
        creating={false}
        railCollapsed={false}
        railTogglable
        onToggleRail={noop}
      />
    </TooltipProvider>,
  );
}

describe("HomeTabStrip file tabs", () => {
  const file: HomeTabDescriptor = {
    kind: "file",
    id: "file:src/app.ts",
    relPath: "src/app.ts",
    title: "app.ts",
    hint: null,
    preview: true,
    dirty: false,
  };

  it("draws a closable italic preview beside the permanent Board tab", () => {
    const html = draw([HOME_BOARD_TAB, file], file.id);

    expect(html).toContain('data-testid="home-file-tab"');
    expect(html).toContain('data-rel-path="src/app.ts"');
    expect(html).toContain('data-preview="true"');
    expect(html).toContain("italic");
    expect(html).toContain('aria-label="Close app.ts"');
  });

  it("draws dirty state on a pinned file without preview styling", () => {
    const html = draw([HOME_BOARD_TAB, { ...file, preview: false, dirty: true }], file.id);

    expect(html).toContain('data-dirty="true"');
    expect(html).not.toContain('data-preview="true"');
    expect(html).not.toContain("italic");
  });
});
