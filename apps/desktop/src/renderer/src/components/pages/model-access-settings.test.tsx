import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { ModelAccessSettings } from "./model-access-settings";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { ModelAccessProvider } from "@renderer/lib/model-access-client";

/**
 * The provider needs a client only for the pane's load effect, which
 * `renderToStaticMarkup` never runs — the rows and their hover helpers render
 * from initial state. The fake exists so the context is non-null.
 */
function renderPane(): string {
  const client = {
    inspect: vi.fn(),
    defaults: vi.fn(),
    setDefault: vi.fn(),
    hiddenModels: vi.fn(),
    setHiddenModels: vi.fn(),
    compactionPolicy: vi.fn(),
    setCompactionPolicy: vi.fn(),
    beginSignIn: vi.fn(),
    signOut: vi.fn(),
  };
  return renderToStaticMarkup(
    <ModelAccessProvider client={client}>
      <TooltipProvider>
        <ModelAccessSettings />
      </TooltipProvider>
    </ModelAccessProvider>,
  );
}

describe("ModelAccessSettings", () => {
  it("carries the utility purpose as a hover helper, not as prose", () => {
    const html = renderPane();

    // The helper is a tooltip trigger whose accessible name IS the purpose
    // copy (VC-81: users can understand what the utility slot is for), sitting
    // on the utility row only.
    expect(html).toContain("auto-titling new chats");
    expect(html).toContain('data-testid="default-model-utility"');
    const utilityStart = html.indexOf('data-testid="default-model-utility"');
    const utilityRow = html.slice(utilityStart);
    expect(utilityRow).toContain("auto-titling new chats");
    expect(utilityRow).toContain('data-slot="tooltip-trigger"');
  });

  it("leaves the other purpose rows without a helper", () => {
    const html = renderPane();

    const globalStart = html.indexOf('data-testid="default-model-global"');
    const globalRow = html.slice(
      globalStart,
      html.indexOf('data-testid="default-model-ticket"', globalStart),
    );
    expect(globalRow).not.toContain("auto-titling");
    expect(globalRow).not.toContain('data-slot="tooltip-trigger"');
  });
});
