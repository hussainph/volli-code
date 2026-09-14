import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { InstructionsTextarea } from "./automation-editor";

describe("the shared automation prompt surface", () => {
  it("wears the shared writing sheet, and draws no tray it has nothing to put in", () => {
    const html = renderToStaticMarkup(
      <InstructionsTextarea value="Review the changes" onValueChange={() => {}} />,
    );
    expect(html).toContain("prompt-surface");
    // The tinted tray separates writing from CONFIGURATION. This surface has
    // none — saving belongs to the editor around it — so a full-width tint
    // holding one 24px button would be a container with nothing in it.
    expect(html).not.toContain("prompt-toolbar");
    expect(html).toContain('aria-label="Instructions"');
    expect(html).not.toContain("Expand instructions editor");
    expect(html).toContain("Review the changes");
    expect(html).toContain("resize-none");
    expect(html).toContain("field-sizing-content");
  });

  it("lets long-form instructions raise the floor without restyling the shell", () => {
    const html = renderToStaticMarkup(
      <InstructionsTextarea value="" onValueChange={() => {}} className="min-h-48" />,
    );
    expect(html).toMatch(/<textarea[^>]*class="[^"]*min-h-48/);
    expect(html).not.toContain("min-h-32");
    expect(html.match(/prompt-surface/g)).toHaveLength(1);
  });
});
