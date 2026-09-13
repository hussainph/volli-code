import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { InstructionsTextarea } from "./automation-editor";

describe("the shared automation prompt surface", () => {
  it("keeps the writing sheet and control tray together, including in Run once", () => {
    const html = renderToStaticMarkup(
      <InstructionsTextarea value="Review the changes" onValueChange={() => {}} />,
    );
    expect(html).toContain("prompt-surface");
    expect(html).toContain("prompt-toolbar");
    expect(html).toContain('aria-label="Instructions"');
    expect(html).toContain('aria-label="Expand instructions editor"');
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
