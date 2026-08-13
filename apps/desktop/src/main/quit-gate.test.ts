import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  planUnsavedQuit,
  quitAlreadyRefused,
  quitConfirmDetail,
  recordUnsavedDocuments,
  refuseQuit,
  unsavedDocumentNames,
} from "./quit-gate";

describe("recordUnsavedDocuments", () => {
  beforeEach(() => {
    recordUnsavedDocuments({ names: [] });
  });

  it("remembers the latest report and forgets the one before it", () => {
    recordUnsavedDocuments({ names: ["train.py", "model.py"] });
    expect(unsavedDocumentNames()).toEqual(["train.py", "model.py"]);

    recordUnsavedDocuments({ names: ["model.py"] });
    expect(unsavedDocumentNames()).toEqual(["model.py"]);

    recordUnsavedDocuments({ names: [] });
    expect(unsavedDocumentNames()).toEqual([]);
  });

  it("ignores a malformed report rather than trusting it as 'nothing unsaved'", () => {
    recordUnsavedDocuments({ names: ["train.py"] });
    recordUnsavedDocuments({ names: [42, null] } as unknown as { names: string[] });
    expect(unsavedDocumentNames()).toEqual(["train.py"]);

    recordUnsavedDocuments(undefined as unknown as { names: string[] });
    expect(unsavedDocumentNames()).toEqual(["train.py"]);
  });
});

describe("planUnsavedQuit", () => {
  it("lets a quit through when nothing is unsaved", () => {
    expect(planUnsavedQuit({ names: [], skipConfirm: false })).toBe("quit");
  });

  it("asks before a quit that would destroy a draft", () => {
    expect(planUnsavedQuit({ names: ["train.py"], skipConfirm: false })).toBe("confirm");
  });

  /**
   * The e2e smokes cannot answer a native modal, and they quit apps that were
   * deliberately left dirty. Same seam as the terminal gate's.
   */
  it("skips the confirm under the automation escape hatch", () => {
    expect(planUnsavedQuit({ names: ["train.py"], skipConfirm: true })).toBe("quit");
  });
});

describe("quitConfirmDetail", () => {
  it("names the single unsaved file", () => {
    expect(quitConfirmDetail(["train.py"])).toBe(
      "train.py has unsaved changes. Quitting will discard them.",
    );
  });

  it("counts and lists a handful", () => {
    expect(quitConfirmDetail(["train.py", "model.py"])).toBe(
      "2 files have unsaved changes (train.py, model.py). Quitting will discard them.",
    );
  });

  /** A 30-tab workbench must not produce a dialog taller than the screen. */
  it("truncates a long list", () => {
    const names = ["a.py", "b.py", "c.py", "d.py", "e.py", "f.py"];
    expect(quitConfirmDetail(names)).toBe(
      "6 files have unsaved changes (a.py, b.py, c.py, d.py, and 2 more). Quitting will discard them.",
    );
  });
});

describe("refuseQuit", () => {
  it("cancels the event and marks it refused for every listener behind it", () => {
    const event = { preventDefault: vi.fn() };
    refuseQuit(event);

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    // Read by each remaining listener, so it must survive being asked twice.
    expect(quitAlreadyRefused(event)).toBe(true);
    expect(quitAlreadyRefused(event)).toBe(true);
  });

  it("reports no refusal when no gate objected", () => {
    expect(quitAlreadyRefused({ preventDefault: vi.fn() })).toBe(false);
  });

  /**
   * The refusal belongs to one quit attempt. Scoping it to the event is what
   * makes that true without anyone having to remember to clear a flag — a flag
   * left set would swallow the next quit the user actually meant.
   */
  it("does not carry a refusal over to the next quit attempt", () => {
    refuseQuit({ preventDefault: vi.fn() });

    expect(quitAlreadyRefused({ preventDefault: vi.fn() })).toBe(false);
  });
});
