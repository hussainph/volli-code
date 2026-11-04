import { describe, expect, it } from "vite-plus/test";
import { cn } from "@renderer/lib/utils";
import {
  MENU_LABEL,
  MENU_LABEL_CMDK,
  COMMAND_RESULT_ROW,
  MENU_ROW,
  MENU_ROW_STATE_CMDK,
  MENU_SEPARATOR,
  MENU_SHORTCUT,
  COMMAND_SEARCH_FIELD,
  MENU_SURFACE,
  COMMAND_FOOTER,
} from "./menu-classes";

describe("destination-result row composition", () => {
  it("inherits the shared row type, cursor, insets and selection mechanics", () => {
    const tokens = COMMAND_RESULT_ROW.split(" ");
    for (const token of ["text-ui", "cursor-default", "select-none", "gap-2", "px-2", "py-1"])
      expect(tokens).toContain(token);
    for (const token of MENU_ROW_STATE_CMDK.split(" ").filter(
      (stateClass) => !stateClass.includes(":bg-"),
    ))
      expect(tokens).toContain(token);
    expect(tokens).toContain("data-[selected=true]:bg-control-secondary");
    expect(tokens).toContain("data-[selected=true]:ring-border-strong");
    expect(tokens).toContain("data-[selected=true]:ring-inset");
  });

  it("lets the palette take a stacked density without two conflicting insets", () => {
    const tokens = cn(COMMAND_RESULT_ROW, "py-2").split(" ");
    expect(tokens).toContain("py-2");
    expect(tokens).not.toContain("py-1");
    expect(tokens).toContain("rounded-menu-item");
    expect(tokens).not.toContain("rounded-lg");
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

describe("overlay hierarchy", () => {
  it("names menu and composer provider groups with sentence-case heading type", () => {
    expect(MENU_LABEL).toContain("text-ui");
    expect(MENU_LABEL_CMDK).toContain("[&_[cmdk-group-heading]]:text-ui");
    for (const recipe of [MENU_LABEL, MENU_LABEL_CMDK]) {
      expect(recipe).not.toContain("uppercase");
      expect(recipe).not.toContain("tracking-");
      expect(recipe).not.toContain("text-label");
    }
  });
  it("centers dividers and gives hints an intentional non-shrinking keycap", () => {
    expect(MENU_SEPARATOR).toContain("w-4/5");
    expect(MENU_SEPARATOR).toContain("mx-auto");
    expect(MENU_SHORTCUT).toContain("rounded-keycap");
    expect(MENU_SURFACE).toContain("rounded-menu");
    expect(MENU_SHORTCUT).toContain("border-border");
    expect(MENU_SHORTCUT).toContain("shrink-0");
    expect(MENU_SHORTCUT).toContain("font-normal");
    expect(COMMAND_FOOTER).toContain("before:w-4/5");
    expect(COMMAND_FOOTER).not.toContain("border-t ");
    expect(MENU_ROW).toContain("font-medium");
  });
  it("separates the search field without a bottom divider", () => {
    expect(COMMAND_SEARCH_FIELD).toContain("rounded-control");
    expect(COMMAND_SEARCH_FIELD).toContain("min-w-0");
    expect(COMMAND_SEARCH_FIELD).not.toContain("border-b ");
  });
});
