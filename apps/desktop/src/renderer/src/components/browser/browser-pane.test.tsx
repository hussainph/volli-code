import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { BROWSER_START_URL } from "../../../../browser-start-page";
import type { BrowserTabState } from "../../../../ipc/contract";
import type { BrowserApi } from "./browser-api";
import { BrowserPane } from "./browser-pane";

/**
 * The pane's native plane is driven from a layout effect, which
 * `renderToStaticMarkup` never runs — so this stub exists only to satisfy the
 * prop, and no call on it is expected.
 */
const api = new Proxy({} as BrowserApi, {
  get() {
    return () => {
      throw new Error("BrowserPane must not command the host while rendering");
    };
  },
});

function tab(overrides: Partial<BrowserTabState> = {}): BrowserTabState {
  return {
    tabId: "tab-1",
    projectId: "project-1",
    ticketId: null,
    createdBy: "user",
    url: "https://volli.dev/docs",
    title: "Volli docs",
    loading: false,
    error: null,
    canGoBack: false,
    canGoForward: false,
    generation: 0,
    ...overrides,
  };
}

function draw(state: BrowserTabState, visible = true): string {
  return renderToStaticMarkup(
    <BrowserPane tab={state} visible={visible} api={api} onTabState={() => undefined} />,
  );
}

describe("BrowserPane address bar", () => {
  it("shows a real destination as the address", () => {
    expect(draw(tab())).toContain('value="https://volli.dev/docs"');
  });

  it("leaves the address empty on a blank tab rather than echoing the start URL", () => {
    // `about:blank` is policy, not a destination anyone typed. Showing it would
    // make the first thing a new tab asks you to do be "delete this text".
    const html = draw(tab({ url: BROWSER_START_URL, title: "" }));

    expect(html).toContain('value=""');
    expect(html).not.toContain(BROWSER_START_URL);
    expect(html).toContain('placeholder="Enter a URL"');
  });

  it("shows the main-owned load failure instead of silently swallowing it", () => {
    const html = draw(tab({ error: "Could not load page: CONNECTION_REFUSED" }));

    expect(html).toContain('role="alert"');
    expect(html).toContain("Could not load page: CONNECTION_REFUSED");
  });
});
