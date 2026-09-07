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
        projectId="project-1"
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
  it("draws a live-titled closable tab, with its entry point inside the one menu", () => {
    const browser: HomeTabDescriptor = {
      kind: "browser",
      id: "browser:tab-7",
      tabId: "tab-7",
      title: "Volli docs",
      loading: true,
      driven: false,
      heldBy: null,
    };

    const html = draw([HOME_BOARD_TAB, browser], browser.id);

    expect(html).toContain('data-testid="home-browser-tab"');
    expect(html).toContain("Volli docs");
    expect(html).toContain('aria-label="Close Volli docs"');
    // The way in is the "+" menu's Browser row now, not a second labelled
    // button on the strip — see `new-session-control.test.tsx`.
    expect(html).not.toContain('aria-label="New Browser Tab"');
    // The person's own tab wears the plain browser glyph, and a free tab
    // wears no holder dot.
    expect(html).toContain('data-browser-tab-mark="user"');
    expect(html).not.toContain('aria-label="Driven by a Session"');
    expect(html).not.toContain("browser-holder-dot");
  });

  it("marks a promoted agent tab as driven, so the strip says an agent may still be steering it", () => {
    // "Open as tab" puts a Session's tab in the person's strip beside their
    // own (VC-238 §4). Without the mark the two are indistinguishable, and the
    // person cannot tell which page moves under them.
    const promoted: HomeTabDescriptor = {
      kind: "browser",
      id: "browser:tab-8",
      tabId: "tab-8",
      title: "Agent page",
      loading: false,
      driven: true,
      heldBy: null,
    };

    const html = draw([HOME_BOARD_TAB, promoted], promoted.id);

    expect(html).toContain('data-browser-tab-mark="session"');
    expect(html).toContain('aria-label="Driven by a Session"');
    // Owned but not held: the two marks are independent, which is the whole
    // reason there are two of them.
    expect(html).not.toContain("browser-holder-dot");
  });

  it("wears the holder's colour dot on a held tab, on screen or not (VC-239)", () => {
    const held: HomeTabDescriptor = {
      kind: "browser",
      id: "browser:tab-8",
      tabId: "tab-8",
      title: "Checkout",
      loading: false,
      driven: false,
      heldBy: { kind: "session", sessionId: "ses-a", name: "Fix checkout form", color: "#d07c00" },
    };
    // Not the active tab: the dot is how a person learns a Session is driving
    // a tab they are not looking at.
    const html = draw([HOME_BOARD_TAB, held], HOME_BOARD_TAB.id);
    expect(html).toContain('data-slot="browser-holder-dot"');
    expect(html).toContain("background-color:#d07c00");
    expect(html).toContain('title="Held by Fix checkout form"');
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
