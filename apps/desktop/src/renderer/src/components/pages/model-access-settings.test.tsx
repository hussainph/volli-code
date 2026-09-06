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
   * The kind-of-work rows carry their job as a subtitle under the label, not
   * an `(i)` hover hint: "Fast" names no billable job, and the tiers agents
   * delegate to must read at a glance. So the copy IS in the static markup —
   * a disclosure panel that mounts when opened is the shape this replaced.
   */
  it("carries the utility purpose as a subtitle, not a hint", () => {
    const html = renderPane();
    const utilityRow = html.slice(html.indexOf('data-testid="default-model-utility"'));

    expect(html).toContain('data-testid="default-model-utility"');
    expect(utilityRow).toContain("Chat names and summaries.");
    expect(utilityRow).not.toContain('aria-label="About Utility"');
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

  it("gives Board and Ticket no subtitle — the label already names the job", () => {
    const rows = Object.fromEntries(PURPOSE_ROWS.map((row) => [row.purpose, row]));

    expect(rows.global?.description).toBeUndefined();
    expect(rows.ticket?.description).toBeUndefined();
    expect(rows.fast?.description).toBe("Quick, low-cost tasks.");
    expect(rows.deep?.description).toBe("Complex reasoning, planning, and review.");
    expect(rows.visual?.description).toBe("Images, screenshots, and pages.");
    expect(rows.utility?.description).toBe("Chat names and summaries.");
  });

  it("holds every subtitle to the twelve-word budget", () => {
    // A subtitle that grows back into a paragraph is the rule this redesign
    // removed, re-broken. The inheritance is never in the subtitle: each unset
    // row names the row it follows in its own control.
    for (const row of PURPOSE_ROWS) {
      if (row.description === undefined) continue;
      expect(row.description.split(/\s+/).length).toBeLessThanOrEqual(12);
      expect(row.description).not.toMatch(/default|same as/i);
    }
  });
});
