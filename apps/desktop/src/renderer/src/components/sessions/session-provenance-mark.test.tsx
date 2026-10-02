// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import type { SessionProvenance } from "@volli/shared";

import { SessionProvenanceMark } from "./session-provenance-mark";

function draw(provenance: SessionProvenance): string {
  return renderToStaticMarkup(<SessionProvenanceMark provenance={provenance} />);
}

describe("compact Session provenance", () => {
  it.each(["BE Code Review", "A very long automation name ".repeat(20), null])(
    "draws only a fixed-size bolt for %s, keeping the origin accessible",
    (automationName) => {
      const markup = draw({ kind: "automation", automationRunId: null, automationName });
      expect(markup).toContain(
        `aria-label="${automationName === null ? "Started by an Automation" : `Started by the Automation ${automationName}`}"`,
      );
      expect(markup).toContain("inline-flex size-3 shrink-0 items-center text-primary");
      expect(markup).toContain('aria-hidden="true"');
      expect(markup).toContain("size-3 shrink-0");
      // Phosphor's bold path is the only visible content. No glyph title or
      // extra name span can consume the Session title's width.
      const content = new DOMParser().parseFromString(markup, "text/html").body;
      expect(content.textContent).toBe("");
      expect(content.querySelectorAll("span")).toHaveLength(1);
      expect(content.querySelectorAll("svg")).toHaveLength(1);
      expect(content.querySelector("svg path")).not.toBeNull();
    },
  );

  it.each<SessionProvenance>([
    { kind: "user" },
    { kind: "session", parentSessionId: "parent", parentTitle: "Orchestrator" },
  ])("draws nothing for $kind provenance", (provenance) => {
    expect(draw(provenance)).toBe("");
  });
});
