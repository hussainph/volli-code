import { describe, expect, it } from "vite-plus/test";
import { cn } from "@renderer/lib/utils";
import { COMMAND_RESULT_ROW, MENU_ROW, MENU_ROW_STATE_CMDK } from "./menu-classes";

describe("destination-result row composition", () => {
  it("inherits the shared row type, cursor, insets and selection mechanics", () => {
    const tokens = COMMAND_RESULT_ROW.split(" ");
    for (const token of ["text-ui", "cursor-default", "select-none", "gap-2", "px-2", "py-1"])
      expect(tokens).toContain(token);
    for (const token of MENU_ROW_STATE_CMDK.split(" ")) expect(tokens).toContain(token);
  });

  it("lets the palette take a stacked density without two conflicting insets", () => {
    const tokens = cn(COMMAND_RESULT_ROW, "py-2").split(" ");
    expect(tokens).toContain("py-2");
    expect(tokens).not.toContain("py-1");
    expect(tokens).toContain("rounded-lg");
    expect(tokens).not.toContain("rounded-row");
    expect(tokens).toContain("outline-none");
    expect(tokens).not.toContain("outline-hidden");
  });

  it("keeps the single-line quick-open row on the 28px control height", () => {
    const tokens = cn(COMMAND_RESULT_ROW, "h-7").split(" ");
    expect(tokens).toContain("h-7");
    expect(tokens).toContain("text-ui");
    expect(tokens).toContain("py-1");
  });

  it("does not impose descendant glyph ink on result identity marks", () => {
    expect(COMMAND_RESULT_ROW).not.toContain("[&_svg");
    // Ordinary menus still own their bare leading glyphs.
    expect(MENU_ROW).toContain("[&_svg:not([class*='text-'])]:text-muted-foreground");
    expect(MENU_ROW).toContain("select-none");
  });
});
