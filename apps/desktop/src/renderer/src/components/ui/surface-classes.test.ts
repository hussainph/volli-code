import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { COMMAND_OVERLAY_FRAME, MENU_SURFACE } from "./menu-classes";
import {
  CARD_SURFACE,
  FLOAT_SURFACE,
  MODAL_SURFACE,
  PANE_SURFACE,
  WELL_SURFACE,
} from "./surface-classes";

const tokens = (classes: string) => classes.split(/\s+/).filter(Boolean);
const css = readFileSync(resolve(import.meta.dirname, "../../globals.css"), "utf8");
/** Declarations only: the comments discuss rims and shadows by name. */
const declarations = css.replace(/\/\*[\s\S]*?\*\//g, "");

describe("the surface ladder", () => {
  it("gives each role its own radius variable", () => {
    expect(tokens(CARD_SURFACE)).toContain("rounded-card");
    expect(tokens(MODAL_SURFACE)).toContain("rounded-dialog");
    expect(tokens(FLOAT_SURFACE)).toContain("rounded-popover");
    expect(tokens(MENU_SURFACE)).toContain("rounded-menu");
    expect(tokens(MENU_SURFACE)).not.toContain("rounded-popover");
    expect(tokens(WELL_SURFACE)).toContain("rounded-well");
  });

  /** A role variable's declared value, comments stripped. */
  const role = (name: string) =>
    new RegExp(`--radius-${name}:\\s*([^;]+);`).exec(declarations)?.[1]?.trim();

  it("holds the owner's radius spec, one variable per role", () => {
    // Controls: 10px at every size, never pills (`--radius` is 12, minus 2).
    expect(declarations).toMatch(/--radius:\s*0\.75rem/);
    expect(role("control")).toBe("calc(var(--radius) - 2px)");
    for (const control of ["button-xs", "button-sm", "button", "button-lg", "input"])
      expect([control, role(control)]).toEqual([control, "var(--radius-control)"]);
    // Capsules: compact chrome only.
    expect(role("pill")).toBe("9999px");
    for (const capsule of ["chip", "segmented", "send"])
      expect([capsule, role(capsule)]).toEqual([capsule, "var(--radius-pill)"]);
    // Floats: tighter than the work under them.
    expect(role("menu")).toBe("10px");
    expect(role("popover")).toBe("12px");
    expect(role("tooltip")).toBe("6px");
    expect(role("dialog")).toBe("14px");
    // The flow, on the v0.3.0-canary.5 values the owner calls good.
    expect(role("panel")).toBe("20px");
    expect(role("card")).toBe("12px");
    expect(role("row")).toBe("var(--nested-radius, 10px)");
  });

  it("derives every inner corner from its container, never a literal", () => {
    expect(role("menu-item")).toBe("calc(var(--radius-menu) - 4px)");
    expect(role("popover-item")).toBe("calc(var(--radius-popover) - 4px)");
    expect(role("dialog-item")).toBe("calc(var(--radius-dialog) - 4px)");
    // Rows and wells read the radius their container publishes.
    expect(role("well")).toBe("var(--nested-radius, var(--radius-control))");
    for (const [surface, inner] of [
      ["surface-float", "popover-item"],
      ["surface-menu", "menu-item"],
      ["surface-modal", "dialog-item"],
    ])
      expect(declarations).toMatch(
        new RegExp(`\\.${surface}\\s*\\{\\s*--nested-radius:\\s*var\\(--radius-${inner}\\);`),
      );
    // A menu is a float with tighter rows: its rule must come after the float's.
    expect(declarations.indexOf(".surface-menu {")).toBeGreaterThan(
      declarations.indexOf(".surface-float {"),
    );
  });

  it("keeps the flow flat and gives floats and modals the one shadow", () => {
    for (const flow of [PANE_SURFACE, CARD_SURFACE, WELL_SURFACE])
      expect(tokens(flow).some((token) => token.startsWith("shadow-"))).toBe(false);
    for (const lifted of [FLOAT_SURFACE, MODAL_SURFACE]) {
      expect(tokens(lifted)).toContain("shadow-overlay");
      expect(tokens(lifted)).toContain("material-floating");
    }
  });

  it("builds menus and the palettes from the float and modal roles", () => {
    for (const token of tokens(FLOAT_SURFACE).filter((t) => !t.startsWith("rounded-")))
      expect(tokens(MENU_SURFACE)).toContain(token);
    for (const token of tokens(MODAL_SURFACE))
      expect(tokens(COMMAND_OVERLAY_FRAME)).toContain(token);
  });

  it("paints no inset rim and no flow shadow in the stylesheet", () => {
    expect(declarations).not.toMatch(/box-shadow:\s*inset/);
    // No rule paints a flow shadow, and `shadow-card` is not a utility. The
    // float shadow is registered; `shadow-raised` is held only for the chat
    // composer stack, which the activity-row work owns (docs/DESIGN.md).
    expect(declarations).not.toMatch(/box-shadow:\s*var\(--shadow-(raised|card)\)/);
    expect(declarations).not.toMatch(/--shadow-card:\s*var\(/);
    expect(declarations).toMatch(/--shadow-overlay:\s*var\(--shadow-overlay\)/);
  });

  it("keeps the float material's two open values in one place", () => {
    expect(declarations).toMatch(/--float-tint:\s*90%/);
    expect(declarations).toMatch(/--float-backdrop:\s*blur\(20px\) saturate\(1\.5\)/);
    // No float reads a literal: every blur in the sheet goes through the variable.
    expect(declarations).not.toMatch(/[;{]\s*backdrop-filter:\s*blur\(/);
  });
});
