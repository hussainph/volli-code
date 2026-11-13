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
    for (const token of [
      "text-ui",
      "cursor-default",
      "select-none",
      "gap-2",
      "pr-2",
      "pl-2",
      "py-1",
    ])
      expect(tokens).toContain(token);
    for (const token of MENU_ROW_STATE_CMDK.split(" ").filter(
      (stateClass) => !stateClass.includes(":bg-"),
    ))
      expect(tokens).toContain(token);
    expect(tokens).toContain("data-[selected=true]:bg-(--accent-selected)");
    expect(tokens).toContain("data-[selected=true]:text-primary-text");
    expect(tokens).not.toContain("data-[selected=true]:bg-control-secondary");
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
  it("sets group headers apart from rows: smaller rung, secondary ink, sentence case", () => {
    // VC-1212: a header on the row's own rung in body ink read as one more row.
    expect(MENU_LABEL.split(" ")).toEqual(
      expect.arrayContaining(["text-label", "text-muted-foreground", "tracking-normal"]),
    );
    expect(MENU_LABEL.split(" ")).not.toContain("text-ui");
    expect(MENU_LABEL.split(" ")).not.toContain("text-foreground");
    expect(MENU_ROW).toContain("text-ui");
    // The cmdk spelling is the same recipe, reached through its heading selector.
    for (const token of MENU_LABEL.split(" ").filter((part) => !/^p[lrxy]?-/.test(part))) {
      expect(MENU_LABEL_CMDK).toContain(`[&_[cmdk-group-heading]]:${token}`);
    }
    for (const recipe of [MENU_LABEL, MENU_LABEL_CMDK]) {
      expect(recipe).not.toContain("uppercase");
      expect(recipe).not.toContain("tracking-wide");
    }
  });
  it("insets native dividers and shows unboxed, non-shrinking key equivalents", () => {
    expect(MENU_SEPARATOR).toContain("mx-2");
    expect(MENU_SEPARATOR).not.toContain("w-4/5");
    expect(MENU_SHORTCUT).not.toContain("rounded-keycap");
    expect(MENU_SURFACE).toContain("rounded-menu");
    expect(MENU_SHORTCUT).not.toContain("border-border");
    expect(MENU_SHORTCUT).toContain("shrink-0");
    expect(MENU_SHORTCUT).toContain("font-normal");
    expect(COMMAND_FOOTER).toContain("before:w-4/5");
    expect(COMMAND_FOOTER).not.toContain("border-t ");
    expect(MENU_ROW).toContain("font-medium");
  });
  it("separates the search field without a bottom divider", () => {
    expect(COMMAND_SEARCH_FIELD).toContain("rounded-full");
    expect(COMMAND_SEARCH_FIELD).toContain("min-w-0");
    expect(COMMAND_SEARCH_FIELD).not.toContain("border-b ");
  });
});
