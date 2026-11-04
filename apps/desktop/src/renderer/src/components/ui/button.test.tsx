import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { Button, buttonVariants } from "./button";

type Variant = "default" | "destructive" | "outline" | "secondary" | "ghost" | "selected" | "link";
const classes = (variant: Variant) => new Set(buttonVariants({ variant }).split(/\s+/));
const shadows = (variant: Variant) =>
  [...classes(variant)].filter((value) => /^(?:[\w-]+:)*shadow-/.test(value));

describe("control contrast recipe", () => {
  it("keeps the solved primary pair opaque at rest and hover", () => {
    const recipe = classes("default");
    expect(recipe.has("bg-primary")).toBe(true);
    expect(recipe.has("text-primary-foreground")).toBe(true);
    expect(recipe.has("hover:bg-primary-hover")).toBe(true);
    expect(recipe.has("active:bg-primary-press")).toBe(true);
    expect([...recipe].some((value) => /(?:hover:)?bg-primary\//.test(value))).toBe(false);
    expect(renderToStaticMarkup(<Button>New ticket</Button>)).toContain("text-primary-foreground");
  });

  it.each(["default", "destructive", "outline", "secondary", "ghost", "selected", "link"] as const)(
    "draws %s flat: no bevel, no inset catch, no drop shadow",
    (variant) => {
      expect(shadows(variant)).toEqual([]);
      expect([...classes(variant)].some((value) => value.startsWith("control-"))).toBe(false);
    },
  );

  it.each([
    ["default", "bg-primary", "hover:bg-primary-hover", "active:bg-primary-press"],
    [
      "destructive",
      "bg-control-destructive",
      "hover:bg-control-destructive-hover",
      "active:bg-control-destructive-press",
    ],
    ["outline", "bg-glass-1", "hover:bg-glass-2", "active:bg-glass-3"],
    ["secondary", "bg-glass-2", "hover:bg-glass-3", "active:bg-glass-4"],
  ] as const)(
    "steps the %s fill on hover and a step further on press",
    (variant, rest, hover, press) => {
      const recipe = classes(variant);
      expect([rest, hover, press].map((value) => recipe.has(value))).toEqual([true, true, true]);
    },
  );

  it.each(["outline", "secondary", "selected"] as const)(
    "edges %s glass with the shared hairline",
    (variant) => {
      expect(classes(variant).has("border-glass-edge")).toBe(true);
    },
  );

  it("draws ghost bare at rest and glass under the pointer", () => {
    const recipe = classes("ghost");
    expect([...recipe].some((value) => /^bg-|^border/.test(value))).toBe(false);
    expect(recipe.has("hover:bg-glass-2")).toBe(true);
    expect(recipe.has("active:bg-glass-3")).toBe(true);
  });

  it("draws the selected segment as the strongest glass step, answering no press", () => {
    const recipe = classes("selected");
    expect(recipe.has("bg-glass-4")).toBe(true);
    expect(recipe.has("text-foreground")).toBe(true);
    expect([...recipe].some((value) => /^(?:hover|active):/.test(value))).toBe(false);
  });

  it("uses the deep destructive action pair, not pale destructive reading ink", () => {
    const recipe = classes("destructive");
    expect(recipe.has("bg-control-destructive")).toBe(true);
    expect(recipe.has("text-control-destructive-foreground")).toBe(true);
    expect(recipe.has("bg-destructive")).toBe(false);
  });

  it.each(["xs", "sm", "default", "lg"] as const)(
    "lets %s labels wrap and grow within their available measure",
    (size) => {
      const recipe = new Set(buttonVariants({ size }).split(/\s+/));
      expect(recipe.has("whitespace-normal")).toBe(true);
      expect(recipe.has("max-w-full")).toBe(true);
      expect(recipe.has("h-auto")).toBe(true);
      expect(recipe.has(`min-h-control-${size}`)).toBe(true);
    },
  );

  it.each(["default", "destructive", "outline", "secondary", "ghost", "link"] as const)(
    "uses an opaque separated focus indicator for %s",
    (variant) => {
      const recipe = classes(variant);
      expect(recipe.has("focus-visible:ring-2")).toBe(true);
      expect(recipe.has("focus-visible:ring-ring")).toBe(true);
      expect(recipe.has("focus-visible:ring-offset-2")).toBe(true);
      expect([...recipe].some((value) => /^focus-visible:ring-.*\//.test(value))).toBe(false);
    },
  );
});
