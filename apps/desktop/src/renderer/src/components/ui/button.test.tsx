import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { Button, buttonVariants } from "./button";

const classes = (variant: "default" | "destructive" | "outline" | "secondary" | "ghost" | "link") =>
  new Set(buttonVariants({ variant }).split(/\s+/));

describe("control contrast recipe", () => {
  it.each(["toolbar", "inspector"] as const)(
    "preserves %s caller selection and keyboard focus",
    (variant) => {
      const html = renderToStaticMarkup(
        <Button variant={variant} aria-pressed className="bg-(--accent-selected) text-primary-text">
          Wrap
        </Button>,
      );
      expect(html).toContain('aria-pressed="true"');
      expect(html).toContain("bg-(--accent-selected)");
      expect(html).toContain("aria-pressed:bg-(--accent-selected)");
      expect(html).toContain("focus-visible:ring-2");
      expect(html).toContain("hover:bg-accent");
    },
  );
  it("uses tonal accent ink and tint at rest and hover", () => {
    const recipe = classes("default");
    expect(recipe.has("bg-accent")).toBe(true);
    expect(recipe.has("text-primary-text")).toBe(true);
    expect(recipe.has("button-tonal")).toBe(true);
    expect([...recipe].some((value) => /(?:hover:)?bg-primary\//.test(value))).toBe(false);
    expect(renderToStaticMarkup(<Button>New ticket</Button>)).toContain("text-primary-text");
  });

  it.each(["ghost", "link"] as const)("keeps %s flat at rest, hover and press", (variant) => {
    expect([...classes(variant)].filter((value) => /^(?:[\w-]+:)*shadow-/.test(value))).toEqual([]);
    expect(classes(variant).has("control-material")).toBe(false);
  });

  it.each(["outline", "secondary", "destructive"] as const)(
    "shares the same material and press feedback for %s",
    (variant) => {
      const recipe = classes(variant);
      expect(recipe.has("control-material")).toBe(true);
      expect(recipe.has("shadow-control")).toBe(true);
      expect(recipe.has("hover:shadow-control-hover")).toBe(true);
      expect(recipe.has("active:shadow-control-pressed")).toBe(true);
    },
  );

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
