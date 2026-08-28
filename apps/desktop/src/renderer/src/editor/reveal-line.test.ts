/**
 * The reveal seam (VC-193): a search result asking an editor that may not exist
 * yet to land on a line.
 *
 * The race is what these tests are about. A request is claimed exactly once,
 * whether the editor was already mounted or arrives later, and a request nobody
 * claims must never resurface as a mysterious jump in a file opened for another
 * reason.
 */
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  applyFileReveal,
  fileRevealKey,
  onFileReveal,
  requestFileReveal,
  takeFileReveal,
  type RevealableEditor,
} from "./reveal-line";

const target = { line: 42, column: 7, length: 6 };

function fakeEditor() {
  const editor = {
    revealLineInCenter: vi.fn<RevealableEditor["revealLineInCenter"]>(),
    setSelection: vi.fn<RevealableEditor["setSelection"]>(),
  };
  return editor satisfies RevealableEditor;
}

beforeEach(() => {
  // Module state: drain whatever a previous test left behind.
  takeFileReveal(fileRevealKey({ projectId: "p1", relPath: "a.ts" }));
});

describe("fileRevealKey", () => {
  it("separates the same path in two checkouts", () => {
    const home = fileRevealKey({ projectId: "p1", relPath: "src/app.ts" });
    const ticket = fileRevealKey({ projectId: "p1", ticketId: "t1", relPath: "src/app.ts" });

    expect(home).not.toBe(ticket);
    expect(home).toBe("p1:main:src/app.ts");
    expect(ticket).toBe("p1:t1:src/app.ts");
  });
});

describe("the pending request", () => {
  it("is claimed by the editor that mounts afterwards", () => {
    const key = fileRevealKey({ projectId: "p1", relPath: "a.ts" });
    requestFileReveal(key, target);

    expect(takeFileReveal(key)).toEqual(target);
    // Once only: a second mount of the same document is not a second click.
    expect(takeFileReveal(key)).toBeNull();
  });

  it("is not handed to a different document", () => {
    requestFileReveal(fileRevealKey({ projectId: "p1", relPath: "a.ts" }), target);

    expect(takeFileReveal(fileRevealKey({ projectId: "p1", relPath: "b.ts" }))).toBeNull();
  });

  it("reaches an editor that is already mounted, through its subscription", () => {
    const key = fileRevealKey({ projectId: "p1", relPath: "a.ts" });
    const seen: (typeof target | null)[] = [];
    const stop = onFileReveal(key, () => seen.push(takeFileReveal(key)));

    requestFileReveal(key, target);

    expect(seen).toEqual([target]);
    stop();
    // Unsubscribed: a torn-down editor hears nothing more, and the request is
    // left in the slot for whoever mounts next.
    requestFileReveal(key, target);
    expect(seen).toHaveLength(1);
    expect(takeFileReveal(key)).toEqual(target);
  });

  it("keeps only the newest request — a list being clicked down asks for the last one", () => {
    const key = fileRevealKey({ projectId: "p1", relPath: "a.ts" });
    requestFileReveal(key, target);
    requestFileReveal(key, { line: 9, column: 1, length: 3 });

    expect(takeFileReveal(key)).toEqual({ line: 9, column: 1, length: 3 });
  });

  it("drops an unclaimed request for one file when another is asked for", () => {
    const first = fileRevealKey({ projectId: "p1", relPath: "a.ts" });
    const second = fileRevealKey({ projectId: "p1", relPath: "b.ts" });
    requestFileReveal(first, target);
    requestFileReveal(second, target);

    expect(takeFileReveal(first)).toBeNull();
    expect(takeFileReveal(second)).toEqual(target);
  });

  it("stops notifying only the listener that unsubscribed", () => {
    const key = fileRevealKey({ projectId: "p1", relPath: "a.ts" });
    const kept = vi.fn();
    const stop = onFileReveal(key, vi.fn());
    onFileReveal(key, kept);
    stop();

    requestFileReveal(key, target);

    expect(kept).toHaveBeenCalledTimes(1);
    takeFileReveal(key);
  });
});

describe("applyFileReveal", () => {
  it("centres the line and selects the match without taking focus", () => {
    const editor = fakeEditor();

    applyFileReveal(editor, target);

    expect(editor.revealLineInCenter).toHaveBeenCalledWith(42);
    expect(editor.setSelection).toHaveBeenCalledWith({
      startLineNumber: 42,
      startColumn: 7,
      endLineNumber: 42,
      endColumn: 13,
    });
    // No focus() at all: stepping through results means clicking the next row,
    // and an editor that stole focus would make that a click back into the list.
    expect(Object.keys(editor)).toEqual(["revealLineInCenter", "setSelection"]);
  });
});
