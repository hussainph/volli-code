// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  APP_ROOT_ID,
  hasNativePlaneOverlay,
  hasVisibleNativePlane,
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

/** jsdom has no layout; supply the same viewport boxes Chromium measures. */
function setBox(node: Element, x = 100, y = 100, width = 200, height = 100): void {
  const rect = new DOMRect(x, y, width, height);
  Object.defineProperty(node, "getBoundingClientRect", { configurable: true, value: () => rect });
  Object.defineProperty(node, "getClientRects", { configurable: true, value: () => [rect] });
}

function scene(): { root: HTMLElement; anchor: HTMLElement } {
  const root = mountAppRoot();
  const anchor = element("div", { "data-browser-plane": "tab-1" });
  root.append(anchor);
  setBox(anchor);
  return { root, anchor };
}

function surface(attributes: Record<string, string>, parent: Element = document.body): HTMLElement {
  const node = element("div", attributes);
  parent.append(node);
  setBox(node);
  return node;
}

// Each shipped family has its real outer shape represented here, including
// role-less peeks and Streamdown's role=button link-safety prompt.
const surfaces: [string, Record<string, string>][] = [
  ["confirmation", { role: "alertdialog" }],
  ["dialog / session and subagent peek / image lightbox", { role: "dialog" }],
  ["command palette scrim", { class: "fixed", style: "position: fixed" }],
  ["dropdown / context menu", { role: "menu" }],
  ["select", { role: "listbox" }],
  ["tooltip", { role: "tooltip" }],
  [
    "popover / hover card wrapper",
    { "data-radix-popper-content-wrapper": "", style: "position: fixed" },
  ],
  [
    "sidebar session / ticket hover peek",
    { "data-session-peek-card": "", style: "position: fixed" },
  ],
  ["toast", { "data-sonner-toast": "" }],
  [
    "link safety",
    {
      "data-streamdown": "link-safety-modal",
      role: "button",
      class: "fixed",
      style: "position: fixed",
    },
  ],
  ["table fullscreen", { "data-streamdown": "table-fullscreen", role: "dialog" }],
  ["mermaid fullscreen", { "data-streamdown": "mermaid-fullscreen", role: "dialog" }],
  ["drag preview", { style: "position: fixed; pointer-events: none" }],
  ["new role-less portal", { style: "position: absolute" }],
];

describe("hasNativePlaneOverlay", () => {
  it("is quiet with no floating surfaces or only permanent app lists", () => {
    const { root, anchor } = scene();
    surface({ role: "listbox" }, root);
    surface({ role: "menu" }, root);
    surface({ style: "position: absolute" }, root);
    expect(hasNativePlaneOverlay(document, anchor)).toBe(false);
  });

  it.each(surfaces)("freezes only for an intersecting %s", (_label, attributes) => {
    const { anchor } = scene();
    const overlay = surface(attributes);
    expect(hasNativePlaneOverlay(document, anchor)).toBe(true);
    setBox(overlay, 400, 300);
    expect(hasNativePlaneOverlay(document, anchor)).toBe(false);
  });

  it("sees fixed and opted-in chrome inside the root, not its layout containers", () => {
    const { root, anchor } = scene();
    root.style.position = "fixed";
    setBox(root, 0, 0, 900, 700);
    const pixels = surface({ style: "position: absolute" }, anchor);
    expect(hasNativePlaneOverlay(document, anchor)).toBe(false);
    pixels.remove();
    const fixed = surface({ class: "fixed", style: "position: fixed" }, root);
    expect(hasNativePlaneOverlay(document, anchor)).toBe(true);
    fixed.remove();
    surface({ "data-native-plane-overlay": "" }, root);
    expect(hasNativePlaneOverlay(document, anchor)).toBe(true);
  });

  it.each([
    ["Sonner toast", { "data-sonner-toast": "", style: "position: absolute" }],
    ["host connection island", { "data-native-plane-overlay": "true", role: "status" }],
    [
      "composer picker overlay",
      { "data-native-plane-overlay": "true", style: "position: absolute" },
    ],
    ["split drop zone", { "data-native-plane-overlay": "true" }],
    ["floating navigation sidebar", { "data-native-plane-overlay": "true" }],
    ["armed-run countdown", { "data-native-plane-overlay": "true" }],
  ] satisfies [string, Record<string, string>][])(
    "measures an in-root %s, not the whole window",
    (_name, attributes) => {
      const { root, anchor } = scene();
      const overlay = surface(attributes, root);
      expect(hasNativePlaneOverlay(document, anchor)).toBe(true);
      setBox(overlay, 500, 500);
      expect(hasNativePlaneOverlay(document, anchor)).toBe(false);
    },
  );

  it("does not confuse an unpositioned portal container with its small content", () => {
    const { anchor } = scene();
    const portal = surface({});
    const toast = surface({ "data-sonner-toast": "" }, portal);
    setBox(toast, 500, 500);
    expect(hasNativePlaneOverlay(document, anchor)).toBe(false);
  });

  it("works without an app root", () => {
    const { root, anchor } = scene();
    root.removeAttribute("id");
    surface({ role: "menu" });
    expect(hasNativePlaneOverlay(document, anchor)).toBe(true);
  });

  it.each(["display: none", "visibility: hidden", "visibility: collapse"])(
    "ignores %s",
    (style) => {
      const { anchor } = scene();
      surface({ role: "dialog", style });
      expect(hasNativePlaneOverlay(document, anchor)).toBe(false);
    },
  );

  it("ignores undisplayed ancestors, zero area and edge-only contact", () => {
    const { anchor } = scene();
    const overlay = surface({ role: "dialog" });
    Object.defineProperty(overlay, "getClientRects", { configurable: true, value: () => [] });
    expect(hasNativePlaneOverlay(document, anchor)).toBe(false);
    for (const [x, y, w, h] of [
      [100, 100, 0, 10],
      [100, 100, 10, 0],
      [300, 100, 10, 10],
      [90, 100, 10, 10],
      [100, 200, 10, 10],
      [100, 90, 10, 10],
    ]) {
      setBox(overlay, x, y, w, h);
      expect(hasNativePlaneOverlay(document, anchor)).toBe(false);
    }
  });

  it("starts capturing during a transparent entry animation", () => {
    const { anchor } = scene();
    surface({ role: "dialog", style: "opacity: 0" });
    expect(hasNativePlaneOverlay(document, anchor)).toBe(true);
  });

  it("only affects the overlapping pane in a split", () => {
    const { root, anchor } = scene();
    const second = surface({ "data-browser-plane": "tab-2" }, root);
    setBox(second, 500, 100);
    surface({ role: "tooltip" });
    expect(hasNativePlaneOverlay(document, anchor)).toBe(true);
    expect(hasNativePlaneOverlay(document, second)).toBe(false);
  });

  it("clips planes to the viewport and ignores hidden or collapsed planes", () => {
    const { anchor } = scene();
    const overlay = surface({ role: "dialog" });
    for (const [x, y, w, h] of [
      [100, 100, 0, 100],
      [100, 100, 100, 0],
      [2000, 100, 100, 100],
      [100, 2000, 100, 100],
    ]) {
      setBox(anchor, x, y, w, h);
      expect(hasNativePlaneOverlay(document, anchor)).toBe(false);
    }
    setBox(anchor, -100, -100, 200, 200);
    setBox(overlay, -100, -100, 50, 50);
    expect(hasNativePlaneOverlay(document, anchor)).toBe(false);
    setBox(overlay, 0, 0, 50, 50);
    expect(hasNativePlaneOverlay(document, anchor)).toBe(true);
    anchor.style.visibility = "hidden";
    expect(hasNativePlaneOverlay(document, anchor)).toBe(false);
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

/*
 * jsdom runs no layout, so `offsetParent` is always null and `clientWidth`
 * always 0 — the three reads this predicate makes are exactly the three jsdom
 * cannot answer. Stub them per element, which keeps each case naming the one
 * real condition it stands for.
 */
function plane(box: { onScreen: boolean; width: number; height: number }): HTMLElement {
  const node = document.createElement("div");
  node.setAttribute("data-browser-plane", "tab-1");
  Object.defineProperty(node, "offsetParent", {
    value: box.onScreen ? document.body : null,
  });
  Object.defineProperty(node, "clientWidth", { value: box.width });
  Object.defineProperty(node, "clientHeight", { value: box.height });
  document.body.append(node);
  return node;
}

describe("hasVisibleNativePlane", () => {
  it("is quiet when no Browser Tab is mounted", () => {
    mountAppRoot();
    expect(hasVisibleNativePlane(document)).toBe(false);
  });

  it("reports a plane that is on screen with a box to fill", () => {
    plane({ onScreen: true, width: 800, height: 600 });
    expect(hasVisibleNativePlane(document)).toBe(true);
  });

  it("ignores a pane that is in the tree but not displayed", () => {
    // A background split, or a Browser Tab behind another tab: the anchor still
    // exists, and there is no native view over it to detach.
    plane({ onScreen: false, width: 800, height: 600 });
    expect(hasVisibleNativePlane(document)).toBe(false);
  });

  it("ignores a displayed pane collapsed to nothing", () => {
    plane({ onScreen: true, width: 0, height: 600 });
    plane({ onScreen: true, width: 800, height: 0 });
    expect(hasVisibleNativePlane(document)).toBe(false);
  });

  it("reports the visible one out of several panes", () => {
    plane({ onScreen: false, width: 800, height: 600 });
    plane({ onScreen: true, width: 800, height: 600 });
    expect(hasVisibleNativePlane(document)).toBe(true);
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
