import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_THEME, type ThemeDefinition } from "@volli/shared";

import { ThemePicker } from "./theme-picker";

const MINE: ThemeDefinition = { ...DEFAULT_THEME, name: "Sunset", slug: "sunset", seed: "#ff8a3d" };

const noop = (): void => {};

describe("ThemePicker rows", () => {
  it("shows no ⋯ affordance at all until a host supplies a handler", () => {
    const html = renderToStaticMarkup(<ThemePicker themes={[MINE]} />);

    expect(html).toContain("Sunset");
    expect(html).not.toContain("More actions");
  });

  it("shows the ⋯ affordance on every row once actions exist", () => {
    const html = renderToStaticMarkup(<ThemePicker themes={[MINE]} onDuplicate={noop} />);

    expect(html).toContain("More actions for Sunset");
    expect(html).toContain("More actions for Ember");
  });

  it("lists the user's own themes after the shipped catalog", () => {
    const html = renderToStaticMarkup(<ThemePicker themes={[MINE]} />);

    expect(html.indexOf("Ember")).toBeLessThan(html.indexOf("Sunset"));
  });
});
