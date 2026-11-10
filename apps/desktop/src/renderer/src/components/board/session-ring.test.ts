import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vite-plus/test";

const css = readFileSync(resolve(import.meta.dirname, "../../globals.css"), "utf8");
const ring = css.slice(
  css.indexOf("@keyframes session-ring-sweep"),
  css.indexOf("/* Glass, tuned material ladder."),
);

function declarations(selector: string, source = ring): string {
  const start = source.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  return source.slice(start, source.indexOf("}", start) + 1);
}

describe("Session ring motion contract", () => {
  it("rotates the centred gradient layer through a complete turn, not the card or its mask", () => {
    expect(declarations("from")).toContain("translate(-50%, -50%) rotate(0turn)");
    expect(declarations("to")).toContain("translate(-50%, -50%) rotate(1turn)");
    const layer = declarations(".session-ring::before");
    expect(layer).toContain("transform: translate(-50%, -50%)");
    expect(layer).toContain("animation: session-ring-sweep 2.6s linear infinite");
    expect(layer).toContain("background: conic-gradient(");
    expect(declarations(".session-ring")).toContain("mask-composite: exclude");
    expect(declarations('.session-ring[data-activity="waiting"]::before')).toContain(
      "animation: none",
    );
  });

  it("gives both motion preferences complete, nonanimated outlines with distinct working/waiting shapes", () => {
    const app = ring.slice(ring.indexOf(':root[data-motion="off"]'));
    const os = app.slice(app.indexOf("@media (prefers-reduced-motion: reduce)"));
    for (const source of [app, os]) {
      expect(source).toContain("border: 1.5px solid var(--session-ring-color)");
      expect(source).toContain("border-style: dashed");
      expect(source).toContain("mask: none");
      expect(source).toContain("content: none");
      expect(source).toContain("animation: none");
      expect(source).not.toContain("conic-gradient");
    }
    expect(
      declarations(':root[data-motion="off"] .board-session-ring[data-activity="working"]', app),
    ).toContain("border-style: dashed");
    expect(declarations('.session-ring.board-session-ring[data-activity="working"]', os)).toContain(
      "border-style: dashed",
    );
  });

  it("does not mistake a persistent life sign for its containing pane's activation motion", () => {
    for (const origin of ["keyboard", "instant"]) {
      expect(css).toContain(`[data-motion-origin="${origin}"] *:not(.session-ring)::before`);
      expect(css).not.toContain(`[data-motion-origin="${origin}"] *::before`);
    }
  });

  it("keeps inactive rings unboxed and pauses hidden card/window timelines", () => {
    expect(declarations(".session-ring")).toContain("display: none");
    expect(css).toMatch(
      /\[data-board-ticket-slot\]\[data-viewport-hidden="true"\] \.session-ring::before,[\s\S]*?animation-play-state: paused !important/,
    );
    expect(css).toMatch(
      /:root\[data-document-hidden="true"\] \*::before,[\s\S]*?animation-play-state: paused !important/,
    );
  });
});
