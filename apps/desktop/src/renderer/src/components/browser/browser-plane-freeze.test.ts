// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  APP_ROOT_ID,
  hasNativePlaneOverlay,
  planeVisibility,
  shouldRefreshPlanePixels,
  PLANE_REFRESH_MIN_INTERVAL_MS,
} from "./browser-plane-freeze";

afterEach(() => {
  document.body.replaceChildren();
});

/** Builds the real shape: an app root, and a portal layer beside it. */
function mountAppRoot(): HTMLElement {
  const root = document.createElement("div");
  root.id = APP_ROOT_ID;
  document.body.append(root);
  return root;
}

function element(tag: string, attributes: Record<string, string>): HTMLElement {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  return node;
}

describe("hasNativePlaneOverlay", () => {
  it("is quiet when only the app root is mounted", () => {
    mountAppRoot();
    expect(hasNativePlaneOverlay(document)).toBe(false);
  });

  it("ignores a permanent listbox INSIDE the app root", () => {
    // The VC-251 bug: the Ticket Change Set renders `<ul role="listbox">` for
    // the life of the panel. Matching it detached a Browser Tab's plane and
    // never reattached it.
    const root = mountAppRoot();
    root.append(element("ul", { role: "listbox", "aria-label": "Change Set" }));
    expect(hasNativePlaneOverlay(document)).toBe(false);
  });

  it.each([
    ["dialog", { role: "dialog" }],
    ["alertdialog", { role: "alertdialog" }],
    ["menu", { role: "menu" }],
    ["listbox", { role: "listbox" }],
    ["toast", { "data-sonner-toast": "" }],
  ])("sees a portaled %s outside the app root", (_label, attributes) => {
    mountAppRoot();
    document.body.append(element("div", attributes));
    expect(hasNativePlaneOverlay(document)).toBe(true);
  });

  it("ignores a tooltip, which follows the pointer and is not worth the plane", () => {
    mountAppRoot();
    document.body.append(element("div", { role: "tooltip" }));
    expect(hasNativePlaneOverlay(document)).toBe(false);
  });

  it("sees floating chrome inside the app root that opts in by marker", () => {
    const root = mountAppRoot();
    root.append(element("div", { "data-native-plane-overlay": "", role: "status" }));
    expect(hasNativePlaneOverlay(document)).toBe(true);
  });

  it("treats everything as floating when no app root is mounted", () => {
    document.body.append(element("div", { role: "menu" }));
    expect(hasNativePlaneOverlay(document)).toBe(true);
  });

  it("accepts an explicit root, so a caller need not depend on the id", () => {
    const root = mountAppRoot();
    root.append(element("div", { role: "menu" }));
    expect(hasNativePlaneOverlay(document, root)).toBe(false);
    expect(hasNativePlaneOverlay(document, null)).toBe(true);
  });
});

describe("planeVisibility", () => {
  it("holds the window while the pane is visible and nothing floats", () => {
    expect(planeVisibility({ visible: true, overlayActive: false })).toBe(true);
  });

  it("yields the moment an overlay wants the tier", () => {
    // Synchronous by design: an earlier pass waited for a screenshot here, so
    // every overlay opened behind the page and jumped forward when it landed.
    expect(planeVisibility({ visible: true, overlayActive: true })).toBe(false);
  });

  it("stays down when the pane itself is not visible", () => {
    expect(planeVisibility({ visible: false, overlayActive: false })).toBe(false);
    expect(planeVisibility({ visible: false, overlayActive: true })).toBe(false);
  });
});

describe("shouldRefreshPlanePixels", () => {
  const live = { visible: true, overlayActive: false, captureInFlight: false };

  it("takes the first photograph it is ever offered", () => {
    expect(shouldRefreshPlanePixels({ ...live, sinceLastMs: null })).toBe(true);
  });

  it("refuses while the plane is detached, because it would photograph nothing", () => {
    expect(shouldRefreshPlanePixels({ ...live, overlayActive: true, sinceLastMs: null })).toBe(
      false,
    );
  });

  it("refuses when the pane is not visible", () => {
    expect(shouldRefreshPlanePixels({ ...live, visible: false, sinceLastMs: null })).toBe(false);
  });

  it("refuses while one is already in flight", () => {
    expect(shouldRefreshPlanePixels({ ...live, captureInFlight: true, sinceLastMs: null })).toBe(
      false,
    );
  });

  it("throttles a drag or a held key down to one photograph per interval", () => {
    expect(
      shouldRefreshPlanePixels({ ...live, sinceLastMs: PLANE_REFRESH_MIN_INTERVAL_MS - 1 }),
    ).toBe(false);
    expect(shouldRefreshPlanePixels({ ...live, sinceLastMs: PLANE_REFRESH_MIN_INTERVAL_MS })).toBe(
      true,
    );
  });

  it("keeps the interval short enough that the pixels are never visibly stale", () => {
    expect(PLANE_REFRESH_MIN_INTERVAL_MS).toBeGreaterThan(0);
    expect(PLANE_REFRESH_MIN_INTERVAL_MS).toBeLessThanOrEqual(500);
  });
});
