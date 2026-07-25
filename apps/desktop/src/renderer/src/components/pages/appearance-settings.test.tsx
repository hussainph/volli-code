import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

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
});
