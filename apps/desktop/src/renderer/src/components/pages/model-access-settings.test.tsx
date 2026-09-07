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

describe("ModelAccessSettings", () => {
  /**
   * The rows whose label names no job carry it as the `(i)` beside the label,
   * which is the one slot CLAUDE.md's copy rule leaves for it: the label is
   * the tier name, the hint is the job, and nothing becomes a paragraph under
   * a control. `PrefRow` draws the glyph, so what the markup shows is the
   * button that opens it.
   */
  it("carries the utility purpose as the row's (i), not as prose under it", () => {
    const html = renderPane();
    const utilityRow = html.slice(html.indexOf('data-testid="default-model-utility"'));

    expect(html).toContain('data-testid="default-model-utility"');
    expect(utilityRow).toContain('aria-label="About Utility"');
    expect(utilityRow).not.toContain('data-slot="pref-row-description"');
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

  it("gives Board and Ticket no hint — the label already names the job", () => {
    const rows = Object.fromEntries(PURPOSE_ROWS.map((row) => [row.purpose, row]));

    expect(rows.global?.hint).toBeUndefined();
    expect(rows.ticket?.hint).toBeUndefined();
    expect(rows.fast?.hint).toBe("Quick, low-cost tasks.");
    expect(rows.deep?.hint).toBe("Complex reasoning, planning, and review.");
    expect(rows.visual?.hint).toBe("Images, screenshots, and pages.");
    expect(rows.utility?.hint).toBe("Chat names and summaries.");
  });

  it("carries the job in the (i), never as prose under the control", () => {
    // CLAUDE.md's copy rule, which this ticket restated: the label is the tier
    // name and the `(i)` carries the one-line job. No row may take PrefRow's
    // `description`, which is reserved for trust boundaries.
    for (const row of PURPOSE_ROWS) {
      expect(row).not.toHaveProperty("description");
    }
  });

  it("holds every hint to the twelve-word budget", () => {
    // A hint that grows back into a paragraph is the rule this redesign
    // removed, re-broken. The inheritance is never in the hint: each unset
    // row names the row it follows in its own control.
    for (const row of PURPOSE_ROWS) {
      if (row.hint === undefined) continue;
      expect(row.hint.split(/\s+/).length).toBeLessThanOrEqual(12);
      expect(row.hint).not.toMatch(/default|same as/i);
    }
  });
});
