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
        onCloseOtherFiles={noop}
        onNewSession={noop}
        onNewChat={noop}
        onNewBrowser={noop}
        creating={false}
        railCollapsed={false}
        railTogglable
        onToggleRail={noop}
      />
    </TooltipProvider>,
  );
}

describe("HomeTabStrip Browser Tabs", () => {
  it("draws a live-titled closable tab and a strip entry point", () => {
    const browser: HomeTabDescriptor = {
      kind: "browser",
      id: "browser:tab-7",
      tabId: "tab-7",
      title: "Volli docs",
      loading: true,
    };

    const html = draw([HOME_BOARD_TAB, browser], browser.id);

    expect(html).toContain('data-testid="home-browser-tab"');
    expect(html).toContain("Volli docs");
    expect(html).toContain('aria-label="Close Volli docs"');
    expect(html).toContain('aria-label="New Browser Tab"');
  });
});

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
    expect(html).toContain('data-preview="false"');
    expect(html).not.toContain("italic");
  });

  it("disambiguates two tabs that share a basename with the parent hint", () => {
    const other: HomeTabDescriptor = {
      ...file,
      id: "file:docs/app.ts",
      relPath: "docs/app.ts",
      hint: "docs",
    };
    const html = draw([HOME_BOARD_TAB, { ...file, hint: "src" }, other], file.id);

    expect(html).toContain(">src<");
    expect(html).toContain(">docs<");
  });
});
