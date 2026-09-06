// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  APP_ROOT_ID,
  hasNativePlaneOverlay,
  planeVisibility,
  shouldPaintPlanePixels,
  PLANE_CAPTURE_DEADLINE_MS,
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
    expect(planeVisibility({ visible: true, overlayActive: false, captureSettled: false })).toBe(
      true,
    );
  });

  it("KEEPS the tier while an overlay waits for its stand-in pixels", () => {
    // Yielding first is what showed a black rectangle: the page would be gone
    // with nothing yet painted to replace it.
    expect(planeVisibility({ visible: true, overlayActive: true, captureSettled: false })).toBe(
      true,
    );
  });

  it("yields once the pixels have settled", () => {
    expect(planeVisibility({ visible: true, overlayActive: true, captureSettled: true })).toBe(
      false,
    );
  });

  it("takes the tier back the instant the overlay goes, without waiting again", () => {
    expect(planeVisibility({ visible: true, overlayActive: false, captureSettled: true })).toBe(
      true,
    );
  });

  it("stays down when the pane itself is not visible", () => {
    expect(planeVisibility({ visible: false, overlayActive: false, captureSettled: false })).toBe(
      false,
    );
    expect(planeVisibility({ visible: false, overlayActive: true, captureSettled: true })).toBe(
      false,
    );
  });
});

describe("shouldPaintPlanePixels", () => {
  it("paints nothing before anything has ever been captured", () => {
    expect(shouldPaintPlanePixels({ visible: true, frameCount: 0 })).toBe(false);
  });

  it("KEEPS painting once it has frames, even with no overlay open", () => {
    // They sit under a live native view that covers them completely. Leaving
    // them there is what removes the flash as the plane comes back: no frame
    // exists in which neither the page nor its stand-in is on screen.
    expect(shouldPaintPlanePixels({ visible: true, frameCount: 1 })).toBe(true);
  });

  it("paints nothing for a pane that is not on screen", () => {
    expect(shouldPaintPlanePixels({ visible: false, frameCount: 2 })).toBe(false);
  });
});

describe("PLANE_CAPTURE_DEADLINE_MS", () => {
  it("leaves room for a measured capture but cannot hide a menu", () => {
    // JPEG encoding measured 11-17ms on the smoke fixture, so the deadline is
    // a backstop rather than the common path.
    expect(PLANE_CAPTURE_DEADLINE_MS).toBeGreaterThan(20);
    expect(PLANE_CAPTURE_DEADLINE_MS).toBeLessThanOrEqual(100);
  });
});
