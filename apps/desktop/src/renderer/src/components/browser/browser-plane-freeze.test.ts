// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vite-plus/test";

import type { BrowserTabCaptureFrame } from "../../../../ipc/contract";
import {
  APP_ROOT_ID,
  hasNativePlaneOverlay,
  planeFreezeDecision,
  PLANE_FREEZE_CAPTURE_TIMEOUT_MS,
} from "./browser-plane-freeze";

const frame: BrowserTabCaptureFrame = {
  kind: "page",
  dataUrl: "data:image/png;base64,page",
  bounds: { x: 0, y: 0, width: 800, height: 600 },
};

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
    // A tooltip costs a capture plus a native detach/reattach, once per button
    // brushed. It loses to the Browser Tab instead.
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
    const menu = element("div", { role: "menu" });
    root.append(menu);
    expect(hasNativePlaneOverlay(document, root)).toBe(false);
    expect(hasNativePlaneOverlay(document, null)).toBe(true);
  });
});

describe("planeFreezeDecision", () => {
  it("hides the plane and paints nothing when the pane is not visible", () => {
    expect(
      planeFreezeDecision({ visible: false, overlayActive: true, outcome: { kind: "pending" } }),
    ).toEqual({ planeVisible: false, frames: [] });
  });

  it("keeps the plane live when no overlay wants the tier", () => {
    expect(planeFreezeDecision({ visible: true, overlayActive: false, outcome: null })).toEqual({
      planeVisible: true,
      frames: [],
    });
  });

  it("KEEPS PAINTING the frozen pixels while the plane comes back", () => {
    // The overlay has gone and the plane is live again, but the native view
    // reattaches an IPC round trip later. Dropping the pixels now is the flash.
    expect(
      planeFreezeDecision({
        visible: true,
        overlayActive: false,
        outcome: { kind: "frames", frames: [frame] },
      }),
    ).toEqual({ planeVisible: true, frames: [frame] });
  });

  it("has nothing to hold over when the capture never produced pixels", () => {
    expect(
      planeFreezeDecision({
        visible: true,
        overlayActive: false,
        outcome: { kind: "unavailable" },
      }),
    ).toEqual({ planeVisible: true, frames: [] });
  });

  it("KEEPS THE PLANE LIVE while pixels are still in flight", () => {
    // The ordering the fix exists for: detaching before a replacement is ready
    // is exactly what exposed the black rectangle.
    for (const outcome of [null, { kind: "pending" } as const]) {
      expect(planeFreezeDecision({ visible: true, overlayActive: true, outcome })).toEqual({
        planeVisible: true,
        frames: [],
      });
    }
  });

  it("detaches onto the captured frames once they arrive", () => {
    expect(
      planeFreezeDecision({
        visible: true,
        overlayActive: true,
        outcome: { kind: "frames", frames: [frame] },
      }),
    ).toEqual({ planeVisible: false, frames: [frame] });
  });

  it("still detaches onto the themed background when no pixels are coming", () => {
    // Refusal and timeout share this state: the overlay must become operable
    // either way, and a themed plane beats a black one.
    expect(
      planeFreezeDecision({
        visible: true,
        overlayActive: true,
        outcome: { kind: "unavailable" },
      }),
    ).toEqual({ planeVisible: false, frames: [] });
  });
});

describe("PLANE_FREEZE_CAPTURE_TIMEOUT_MS", () => {
  it("bounds the wait within a couple of frames", () => {
    expect(PLANE_FREEZE_CAPTURE_TIMEOUT_MS).toBeGreaterThan(0);
    expect(PLANE_FREEZE_CAPTURE_TIMEOUT_MS).toBeLessThanOrEqual(150);
  });
});
