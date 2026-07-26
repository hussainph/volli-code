import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { listEditorThemes } from "@renderer/editor/editor-theme-catalog";

import { AppearanceSettings } from "./appearance-settings";

describe("Settings → Appearance", () => {
  it("hosts the theme picker with its row actions wired, and a way into the editor", () => {
    const html = renderToStaticMarkup(<AppearanceSettings />);

    expect(html).toContain("App theme");
    expect(html).toContain("Customize");
    // The ⋯ affordance only renders once a host supplies handlers, so its
    // presence here IS the assertion that this host supplies them.
    expect(html).toContain("More actions for Ember");
  });

  it("hosts an Editor section beside the Terminal theme picker", () => {
    const html = renderToStaticMarkup(<AppearanceSettings />);

    expect(html).toContain("Editor");
    expect(html).toContain("Terminal");
    // Section order: App theme → Editor → Terminal (picker beside Terminal).
    expect(html.indexOf("Editor")).toBeGreaterThan(html.indexOf("App theme"));
    expect(html.indexOf("Terminal")).toBeGreaterThan(html.indexOf("Editor"));
  });

  it("shows the derived editor theme when none is pinned, labeled as matching the app", () => {
    // Default store: editorThemeId null + Ember → One Dark Pro (catalog).
    const html = renderToStaticMarkup(<AppearanceSettings />);

    expect(html).toContain('aria-label="Editor theme"');
    expect(html).toContain("One Dark Pro");
    expect(html).toContain("Matches app theme");
    // Reset only appears when an explicit id is pinned (covered in the model).
    expect(html).not.toContain("Reset editor theme to match app theme");
    // Catalog is what the picker lists once opened (~22 dark themes).
    expect(listEditorThemes().length).toBeGreaterThanOrEqual(20);
  });
});
