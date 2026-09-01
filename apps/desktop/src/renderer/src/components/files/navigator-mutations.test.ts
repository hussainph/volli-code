import { describe, expect, it } from "vite-plus/test";

import {
  navigatorCreatePath,
  navigatorRenamePath,
  unsavedRenameRefusal,
  NO_NAVIGATOR_EDIT,
} from "./navigator-mutations";

describe("navigatorCreatePath", () => {
  it("joins what was typed onto the folder on screen", () => {
    expect(navigatorCreatePath("src/components", "row.tsx")).toEqual({
      ok: true,
      relPath: "src/components/row.tsx",
    });
    expect(navigatorCreatePath("", "README.md")).toEqual({ ok: true, relPath: "README.md" });
  });

  it("trims, so a stray space cannot become part of a filename", () => {
    expect(navigatorCreatePath("src", "  row.tsx  ")).toEqual({ ok: true, relPath: "src/row.tsx" });
  });

  it("allows a nested name — main makes the missing folders", () => {
    expect(navigatorCreatePath("src", "deep/nested/thing.ts")).toEqual({
      ok: true,
      relPath: "src/deep/nested/thing.ts",
    });
  });

  it("asks for a name rather than creating something unnamed", () => {
    expect(navigatorCreatePath("src", "   ")).toEqual({ ok: false, error: "Enter a name" });
  });

  it("refuses a backslash, which is a separator somewhere else and a literal here", () => {
    expect(navigatorCreatePath("src", "a\\b.ts")).toEqual({
      ok: false,
      error: "A name cannot contain a backslash",
    });
  });

  it.each([["../escape.ts"], ["/etc/passwd"], ["a//b.ts"], ["."], ["a/./b.ts"]])(
    "refuses the traversal-shaped name %j in the reader's words",
    (name) => {
      expect(navigatorCreatePath("src", name)).toEqual({
        ok: false,
        error: `"${name}" cannot be used as a name`,
      });
    },
  );
});

describe("navigatorRenamePath", () => {
  it("keeps the file in its own folder", () => {
    expect(navigatorRenamePath("src/components/row.tsx", "list-row.tsx")).toEqual({
      ok: true,
      relPath: "src/components/list-row.tsx",
    });
    expect(navigatorRenamePath("README.md", "GUIDE.md")).toEqual({
      ok: true,
      relPath: "GUIDE.md",
    });
  });

  it("refuses a separator rather than turning a rename into a move", () => {
    for (const name of ["other/row.tsx", "other\\row.tsx"]) {
      expect(navigatorRenamePath("src/row.tsx", name)).toEqual({
        ok: false,
        error: "A new name cannot contain a slash",
      });
    }
  });

  it("asks for a name when the field commits empty", () => {
    expect(navigatorRenamePath("src/row.tsx", " ")).toEqual({ ok: false, error: "Enter a name" });
  });

  it.each([[".."], ["."]])("refuses the dot segment %j", (name) => {
    expect(navigatorRenamePath("src/row.tsx", name)).toEqual({
      ok: false,
      error: `"${name}" cannot be used as a name`,
    });
  });

  it("refuses a dot segment at the repository root too (no parent to hide behind)", () => {
    expect(navigatorRenamePath("row.tsx", "..")).toEqual({
      ok: false,
      error: '".." cannot be used as a name',
    });
  });
});

describe("unsavedRenameRefusal", () => {
  it("names the file and the way out, not just the wall", () => {
    expect(unsavedRenameRefusal("src/components/row.tsx")).toBe(
      "Save row.tsx before renaming it — it has unsaved changes.",
    );
  });
});

describe("NO_NAVIGATOR_EDIT", () => {
  it("is the one shared 'nothing is being typed' value", () => {
    expect(NO_NAVIGATOR_EDIT).toEqual({ kind: "none" });
  });
});
