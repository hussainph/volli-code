import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vite-plus/test";
import { onDocumentGone } from "./document-lifetime";

/** A window's `webContents`, as far as page lifetime goes. */
function contents() {
  return new EventEmitter();
}

describe("onDocumentGone (VC-831)", () => {
  it.each(["did-navigate", "render-process-gone", "destroyed"])(
    "fires once on %s and detaches all three hooks",
    (event) => {
      const page = contents();
      const listener = vi.fn();
      onDocumentGone(page, listener);
      page.emit(event);
      page.emit("did-navigate");
      page.emit("render-process-gone");
      page.emit("destroyed");
      expect(listener).toHaveBeenCalledOnce();
      for (const name of ["did-navigate", "render-process-gone", "destroyed"]) {
        expect(page.listenerCount(name)).toBe(0);
      }
    },
  );

  it("releases nothing on a navigation that has only started or stayed in the page", () => {
    const page = contents();
    const listener = vi.fn();
    onDocumentGone(page, listener);
    // A refused navigation still starts; a hash change is in-page and never
    // reaches `did-navigate` (Electron emits `did-navigate-in-page` for it).
    page.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    page.emit("did-navigate-in-page");
    expect(listener).not.toHaveBeenCalled();
  });

  it("stops listening when disposed", () => {
    const page = contents();
    const listener = vi.fn();
    const dispose = onDocumentGone(page, listener);
    dispose();
    dispose();
    page.emit("did-navigate");
    page.emit("destroyed");
    expect(listener).not.toHaveBeenCalled();
    expect(page.eventNames()).toEqual([]);
  });
});
