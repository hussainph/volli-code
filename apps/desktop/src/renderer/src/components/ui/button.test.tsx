import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { Button, buttonVariants } from "./button";

const classes = (variant: "default" | "destructive" | "outline" | "secondary" | "ghost" | "link") =>
  new Set(buttonVariants({ variant }).split(/\s+/));

describe("control contrast recipe", () => {
  it("keeps the solved primary pair opaque at rest and hover", () => {
    const recipe = classes("default");
    expect(recipe.has("bg-primary")).toBe(true);
    expect(recipe.has("text-primary-foreground")).toBe(true);
    expect(recipe.has("hover:shadow-raised")).toBe(true);
    expect([...recipe].some((value) => /(?:hover:)?bg-primary\//.test(value))).toBe(false);
    expect(renderToStaticMarkup(<Button>New ticket</Button>)).toContain("text-primary-foreground");
  });

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
