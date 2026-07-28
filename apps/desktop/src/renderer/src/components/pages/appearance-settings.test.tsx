import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { AppearanceSettings } from "./appearance-settings";

describe("Settings → Appearance", () => {
  it("mounts the canvas editor in the App theme slot the placeholder held open", () => {
    const html = renderToStaticMarkup(<AppearanceSettings />);

    expect(html).toContain("App theme");
    expect(html).toContain('data-testid="canvas-pad"');
    // The pad is a minimap of the window, so it carries the window's aspect —
    // a pad of any other shape lies about where a pool will land.
    expect(html).toContain("aspect-ratio:16 / 10");
    expect(html).toContain('aria-label="Add a colour"');
    expect(html).toContain('aria-label="Vibrancy"');
    expect(html).toContain('aria-label="Grain"');
  });

  it("opens on the shipped canvas — one ember stop, at its stored anchor", () => {
    const html = renderToStaticMarkup(<AppearanceSettings />);

    expect(html).toContain('data-testid="canvas-stop-orb-0"');
    expect(html).toContain("#e8652a");
    // The only stop is the primary, so `−` has nothing it is allowed to take.
    expect(html).toContain('aria-label="Remove a colour"');
    expect(html).not.toContain('data-testid="canvas-stop-orb-1"');
  });

  it("gives light/dark/auto its own section, scoped separately from the canvas", () => {
    // The canvas does not name a mode — the per-mode dials exist so ONE canvas
    // renders in both — and the two are independently overridable per workspace.
    const html = renderToStaticMarkup(<AppearanceSettings />);

    expect(html).toContain("Light &amp; dark");
    expect(html).toContain('data-testid="appearance-mode"');
    expect(html).toContain("Auto");
    expect(html.indexOf("Light &amp; dark")).toBeGreaterThan(html.indexOf("App theme"));
  });

  it("shows what every contrast floor measured, whether or not one is short", () => {
    // The engine clamps an unreachable floor and says nothing, so this readout
    // is the only place in the app the number can be seen at all.
    const html = renderToStaticMarkup(<AppearanceSettings />);

    expect(html).toContain('data-testid="canvas-contrast-readout"');
    expect(html).toContain("Body copy");
    expect(html).toContain("Secondary copy");
    expect(html).toContain("Sidebar nav");
    // Nothing is stranded on the shipped canvas, so no alarm is raised over it.
    expect(html).not.toContain('data-testid="canvas-contrast-stranded"');
  });

  it("hosts an Editor section beside the Terminal theme picker", () => {
    const html = renderToStaticMarkup(<AppearanceSettings />);

    expect(html).toContain("Editor");
    expect(html).toContain("Terminal");
    // Section order: App theme → Light & dark → Editor → Terminal.
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
