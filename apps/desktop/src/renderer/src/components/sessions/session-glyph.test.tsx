/**
 * What the mark SAYS, at each state a Session can be in.
 *
 * The badge is the one new state→glyph map in the app, so what is worth pinning
 * is the relations: which states share a badge, that every state gets one, that
 * a stateless row draws the logo alone, and that the accessible name is the
 * caller's words rather than a copy written here. The colours are the shipped
 * tone tokens (`text-positive`, `text-attention`, `text-destructive`,
 * `text-muted-foreground`) and are asserted as those tokens, never as hexes.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { parseHarnessId } from "@volli/shared";

import type { StatusDotState } from "@renderer/components/ui/status-dot";
import { providerMark } from "@renderer/components/models/model-identity";

import { HARNESS_VENDOR, harnessVendorId, SessionGlyph } from "./session-glyph";

function markup(
  props: Partial<Parameters<typeof SessionGlyph>[0]> & { state: StatusDotState | null },
): string {
  return renderToStaticMarkup(
    <SessionGlyph
      providerId="anthropic"
      providerLabel="Anthropic"
      kind="chat"
      name="Anthropic · Working"
      {...props}
    />,
  );
}

describe("the badge", () => {
  it("spins for every state that is working", () => {
    for (const state of ["working", "setup", "starting"] as const) {
      const html = markup({ state });
      expect(html, state).toContain("text-positive");
      expect(html, state).toContain("animate-spin");
    }
  });

  it("asks with the attention tone when a person is needed", () => {
    const html = markup({ state: "waiting" });
    expect(html).toContain("text-attention");
    expect(html).not.toContain("animate-spin");
  });

  it("warns for a turn that died and for a failure", () => {
    for (const state of ["interrupted", "error"] as const) {
      expect(markup({ state }), state).toContain("text-destructive");
    }
  });

  it("rests quietly for every state that is over or idle", () => {
    for (const state of ["idle", "ready", "parked", "exited", "stopped"] as const) {
      const html = markup({ state });
      expect(html, state).toContain("text-muted-foreground");
      expect(html, state).not.toContain("animate-spin");
    }
  });

  it("keeps the vendor colour at quiet opacity when there is no state to badge", () => {
    const html = markup({ state: null });
    expect(html).toContain("opacity-70");
    expect(html).not.toContain("grayscale");
    expect(html).toContain(`fill="${providerMark("anthropic")!.tint}"`);
    expect(html).toContain('data-session-glyph="none"');
    // Nothing on the corner: there is no state to badge.
    expect(html).not.toContain("animate-spin");
    expect(html).not.toContain("text-attention");
  });

  it("cuts the badge's disc out of the surface behind it", () => {
    expect(markup({ state: "working", surface: "sidebar" })).toContain("bg-sidebar");
    expect(markup({ state: "working", surface: "popover" })).toContain("bg-popover");
  });
});

describe("the box", () => {
  it("is a 24px tile in a card and a 20px slot in a one-line row", () => {
    const card = markup({ state: "idle", size: "card" });
    expect(card).toContain("size-6 rounded-md bg-muted/50");
    expect(card).not.toContain("shadow");
    const row = markup({ state: "idle", size: "row" });
    expect(row).toContain("size-5");
    expect(row).not.toContain("rounded-md");
  });
});

describe("the name and the logo", () => {
  it("says exactly what the caller composed, and nothing of its own", () => {
    const html = markup({ state: "waiting", name: "Anthropic · Waiting for you" });
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Anthropic · Waiting for you"');
    // The state word is the caller's; this file writes none.
    expect(html).not.toContain("Working");
  });

  it("falls back to the kind's glyph when there is no vendor to draw", () => {
    const chat = markup({ state: "idle", providerId: null, kind: "chat", name: "Chat" });
    const terminal = markup({
      state: null,
      providerId: null,
      kind: "terminal",
      name: "Terminal",
    });
    // The shared set's glyphs — no logo, no lettermark.
    expect(chat).toContain("<svg");
    expect(terminal).toContain("<svg");
    expect(chat).not.toBe(terminal);
  });

  it.each(["anthropic", "openai", "google", "openai-codex", "opencode-go", "cursor"])(
    "renders the published %s mark in every size and surface, never a generic Chat/Terminal mark",
    (providerId) => {
      const mark = providerMark(providerId)!;
      expect(mark).not.toBeNull();
      for (const size of ["row", "tab", "card"] as const) {
        for (const surface of ["sidebar", "popover"] as const) {
          const html = markup({ providerId, state: null, size, surface, kind: "terminal" });
          expect(html).toContain(`viewBox="${mark.viewBox}"`);
          expect(html).toContain(`fill="${mark.tint}"`);
          for (const path of mark.paths) expect(html).toContain(`d="${path}"`);
          expect(html.match(/<svg/g)).toHaveLength(1);
          expect(html).toContain('aria-label="Anthropic · Working"');
        }
      }
    },
  );

  it("uses a generic fallback only when the provider has no published mark", () => {
    const unknown = markup({ state: null, providerId: "radius", providerLabel: "Radius" });
    expect(providerMark("radius")).toBeNull();
    expect(unknown).toContain("<svg");
    expect(unknown).not.toContain(`fill="${providerMark("anthropic")!.tint}"`);
  });
});

describe("harnessVendorId", () => {
  it("draws a terminal companion with its harness's vendor (A3)", () => {
    expect(harnessVendorId("claude-code")).toBe("anthropic");
    expect(harnessVendorId("codex")).toBe("openai-codex");
    expect(harnessVendorId("opencode")).toBe("opencode-go");
    expect(harnessVendorId("cursor")).toBe("cursor");
  });

  it("has no vendor for a harness nobody publishes a mark for, or for no harness", () => {
    expect(harnessVendorId(null)).toBeNull();
    // A custom slug keeps the glyph its row already drew.
    expect(harnessVendorId(parseHarnessId("home-grown-cli"))).toBeNull();
    expect(Object.keys(HARNESS_VENDOR)).toEqual(["claude-code", "codex", "cursor", "opencode"]);
  });
});
