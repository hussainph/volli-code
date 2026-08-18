import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { AppearanceSettings, CanvasShadowedNote } from "./appearance-settings";

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

  it("pins the shadow pill to the ruled word — Project override, never Workspace", () => {
    // CONTEXT.md's VC-57 ruling: "project" is the one user-facing word for a
    // rail entry, and this pill is where "workspace" kept sneaking back in.
    // The note renders in the page only while a project override shadows the
    // global canvas — state a static render cannot install (it reads the
    // store's INITIAL state) — so the exported note is rendered directly.
    const html = renderToStaticMarkup(<CanvasShadowedNote />);

    expect(html).toContain('data-testid="appearance-canvas-shadowed"');
    expect(html).toContain("Project override");
    expect(html).not.toContain("Workspace");
  });

  it("puts light/dark/auto with the canvas, above it, in one App theme section", () => {
    // They are one subject to anyone changing how the app looks, so the separate
    // "Light & dark" section is gone. What the split protected still holds: the
    // canvas does not name a mode, so the control is a sibling of the editor
    // rather than a child — see AppThemeSection.
    const html = renderToStaticMarkup(<AppearanceSettings />);

    expect(html).not.toContain("Light &amp; dark");
    expect(html).toContain('data-testid="appearance-mode"');
    expect(html).toContain("Auto");
    expect(html.indexOf('data-testid="appearance-mode"')).toBeGreaterThan(
      html.indexOf("App theme"),
    );
    // Above the canvas it is seen in, not below it.
    expect(html.indexOf('data-testid="appearance-mode"')).toBeLessThan(
      html.indexOf('data-testid="canvas-grain-dial"'),
    );
  });

  it("carries no contrast instrumentation on the shipped canvas", () => {
    // The per-floor Lc readout was tuning instrumentation and came out. The
    // shipped canvas strands nothing, so the page shows controls and no
    // contrast surface at all — the alert is reserved for a canvas the user
    // authors into genuinely unreachable copy.
    const html = renderToStaticMarkup(<AppearanceSettings />);

    expect(html).not.toContain('data-testid="canvas-contrast-readout"');
    expect(html).not.toContain('data-testid="canvas-contrast-stranded"');
    expect(html).not.toContain("Body copy");
  });

  it("hosts an Editor section beside the Terminal theme picker", () => {
    const html = renderToStaticMarkup(<AppearanceSettings />);

    expect(html).toContain("Editor");
    expect(html).toContain("Terminal");
    // Section order: App theme (mode + canvas) → Editor → Terminal.
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
