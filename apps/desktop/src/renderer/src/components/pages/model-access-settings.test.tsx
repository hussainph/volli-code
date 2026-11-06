import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { ModelAccessSettings, PURPOSE_ROWS } from "./model-access-settings";
import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { ModelAccessProvider } from "@renderer/lib/model-access-client";

/**
 * The provider needs a client only for the pane's load effect, which
 * `renderToStaticMarkup` never runs — the rows and their subtitles render from
 * initial state. The fake exists so the context is non-null.
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
    codeModePolicy: vi.fn(),
    setCodeModePolicy: vi.fn(),
    pickerView: vi.fn(),
    setPickerView: vi.fn(),
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

// Still mounted by hosts/host-model-sheet; app Settings uses the new models pane.
describe("ModelAccessSettings (remote-host sheet)", () => {
  it("draws each default-model row as its label and control, with no purpose line", () => {
    const html = renderPane();
    const utilityRow = html.slice(
      html.indexOf('data-testid="default-model-utility"'),
      html.indexOf('data-testid="default-model-ticket"'),
    );

    expect(utilityRow).toContain('data-slot="pref-row-label"');
    expect(utilityRow).not.toContain("Chat names and summaries.");
    expect(utilityRow).not.toContain('aria-label="About');
    expect([...utilityRow.matchAll(/<p\b/g)]).toHaveLength(0);
  });

  it("indents the kind-of-work rows under Ticket Sessions and nothing else", () => {
    const html = renderPane();
    const before = html.slice(0, html.indexOf('data-testid="default-models-under-ticket"'));
    const under = html.slice(html.indexOf('data-testid="default-models-under-ticket"'));

    expect(before).toContain("Board chats");
    expect(before).toContain("Utility");
    expect(before).toContain("Ticket Sessions");
    expect(before).not.toContain('data-testid="default-model-fast"');
    expect(under).toContain('data-testid="default-model-fast"');
    expect(under).toContain('data-testid="default-model-deep"');
    expect(under).toContain('data-testid="default-model-visual"');
    expect(under).not.toContain('data-testid="default-model-ticket"');
  });

  it("carries no hint or description on any tier row", () => {
    for (const row of PURPOSE_ROWS) {
      expect(row).not.toHaveProperty("hint");
      expect(row).not.toHaveProperty("description");
    }
  });
});
