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

  it("carries no shadow pill — divergence is Configure's to say, not this page's", () => {
    // The "Project override" note was a status pill nothing here could act
    // on, and the owner called it off. The project's own Configure page says
    // the divergence once, with the revert beside it.
    const html = renderToStaticMarkup(<AppearanceSettings />);

    expect(html).not.toContain('data-testid="appearance-canvas-shadowed"');
    expect(html).not.toContain("Project override");
  });

  it("floats light/dark/auto on the canvas pad, in one App theme section", () => {
    // They are one subject to anyone changing how the app looks, so the separate
    // "Light & dark" section is gone and the mode rides the pad itself (the Arc
    // arrangement). What the old split protected still holds: the canvas does
    // not name a mode, so the editor takes the control as a slot this page
    // fills — see AppThemeSection.
    const html = renderToStaticMarkup(<AppearanceSettings />);

    expect(html).not.toContain("Light &amp; dark");
    expect(html).toContain('data-testid="appearance-mode"');
    expect(html).toContain("Auto");
    expect(html.indexOf('data-testid="appearance-mode"')).toBeGreaterThan(
      html.indexOf("App theme"),
    );
    // On the pad — between the two faders that flank it.
    expect(html.indexOf('data-testid="appearance-mode"')).toBeGreaterThan(
      html.indexOf('aria-label="Vibrancy"'),
    );
    expect(html.indexOf('data-testid="appearance-mode"')).toBeLessThan(
      html.indexOf('aria-label="Grain"'),
    );
  });

  it("carries no contrast instrumentation at all", () => {
    // The per-floor Lc readout was tuning instrumentation, and the standing
    // stranded-floor alert followed it out at the owner's call: a canvas is an
    // aesthetic choice, and a persistent warning about an outcome the user
    // chose is the surface arguing with them. Controls only.
    const html = renderToStaticMarkup(<AppearanceSettings />);

    expect(html).not.toContain('data-testid="canvas-contrast-readout"');
    expect(html).not.toContain('data-testid="canvas-contrast-stranded"');
    expect(html).not.toContain("Body copy");
  });

  it("hosts the App theme section above the Terminal one", () => {
    const html = renderToStaticMarkup(<AppearanceSettings />);

    expect(html).toContain("App theme");
    expect(html).toContain("Terminal");
    expect(html.indexOf("Terminal")).toBeGreaterThan(html.indexOf("App theme"));
  });

  it("offers no editor theme control — Mode already decides it", () => {
    // VC-123. The editor wears one light theme or one dark one, chosen by the
    // Mode segmented control in the App theme section above. A picker here
    // would be a second answer to a question this page already asks once.
    const html = renderToStaticMarkup(<AppearanceSettings />);

    expect(html).not.toContain('aria-label="Editor theme"');
    expect(html).not.toContain("Search editor themes");
    expect(html).not.toContain("Reset editor theme to the default");
    expect(html).toContain('aria-label="Appearance"');
  });
});
