import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { AppearanceSettings } from "./appearance-settings";

describe("Settings → Appearance", () => {
  it("holds the App theme slot open for the canvas editor rather than leaving it blank", () => {
    // The seed picker stood here and is gone with the system behind it. An
    // empty section would read as a broken pane, so the slot says what is
    // coming — and the testid is what the editor's own test will take over.
    const html = renderToStaticMarkup(<AppearanceSettings />);

    expect(html).toContain("App theme");
    expect(html).toContain('data-testid="appearance-canvas-placeholder"');
    expect(html).toContain("canvas editor lands next");
  });

  it("hosts an Editor section beside the Terminal theme picker", () => {
    const html = renderToStaticMarkup(<AppearanceSettings />);

    expect(html).toContain("Editor");
    expect(html).toContain("Terminal");
    // Section order: App theme → Editor → Terminal (picker beside Terminal).
    expect(html.indexOf("Editor")).toBeGreaterThan(html.indexOf("App theme"));
    expect(html.indexOf("Terminal")).toBeGreaterThan(html.indexOf("Editor"));
  });

  it("shows the shipped editor default when none is pinned, labeled as the default", () => {
    // Decision 6: the canvas does not drive Monaco, so an unset id resolves to
    // one flat default rather than something mapped off the app.
    const html = renderToStaticMarkup(<AppearanceSettings />);

    expect(html).toContain('aria-label="Editor theme"');
    expect(html).toContain("One Dark Pro");
    expect(html).toContain("Default");
    // Reset only appears when an explicit id is pinned (covered in the model).
    expect(html).not.toContain("Reset editor theme to the default");
  });
});
