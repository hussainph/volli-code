import { describe, expect, it } from "vite-plus/test";

import { planCloseOthers, planTabClose, resolveTabClose } from "./close-guard";

describe("planTabClose", () => {
  it("closes a clean tab without confirmation", () => {
    expect(planTabClose({ dirty: false })).toBe("close");
  });

  it("confirms before closing a dirty tab", () => {
    expect(planTabClose({ dirty: true })).toBe("confirm");
  });
});

describe("resolveTabClose", () => {
  it("keeps the tab open when the user cancels", () => {
    expect(resolveTabClose({ choice: "cancel" })).toBe("keep-open");
  });

  it("closes the tab when the user discards the draft", () => {
    expect(resolveTabClose({ choice: "discard" })).toBe("close");
  });

  it("closes the tab when the save succeeded", () => {
    expect(resolveTabClose({ choice: "save", saved: true })).toBe("close");
  });

  it("aborts the close when the save FAILED — work is never closed over a failed write", () => {
    expect(resolveTabClose({ choice: "save", saved: false })).toBe("keep-open");
  });
});

describe("planCloseOthers", () => {
  const dirty = new Set(["b.ts"]);
  const isDirty = (relPath: string) => dirty.has(relPath);

  it("closes every other clean tab in one step", () => {
    const plan = planCloseOthers({ relPaths: ["a.ts", "c.ts"], keep: "keep.ts", isDirty });

    expect(plan).toEqual({ close: ["a.ts", "c.ts"], confirm: [] });
  });

  it("collects the dirty others for confirmation, in strip order", () => {
    const plan = planCloseOthers({
      relPaths: ["a.ts", "b.ts", "keep.ts", "c.ts"],
      keep: "keep.ts",
      isDirty,
    });

    expect(plan).toEqual({ close: ["a.ts", "c.ts"], confirm: ["b.ts"] });
  });

  it("never closes the kept tab, dirty or not", () => {
    const plan = planCloseOthers({ relPaths: ["b.ts"], keep: "b.ts", isDirty });

    expect(plan).toEqual({ close: [], confirm: [] });
  });
});
