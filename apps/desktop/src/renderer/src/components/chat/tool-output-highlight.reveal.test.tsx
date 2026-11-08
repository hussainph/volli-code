// @vitest-environment jsdom
/**
 * A code block revealed from `<Activity mode="hidden">` does not re-render
 * (VC-1080). Activity re-runs every effect on reveal, so the highlight effect
 * asks the cache again and gets the very tokens it already holds; adopting
 * them as a fresh state object re-rendered every code block of a transcript
 * that had not changed.
 */
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const cached = vi.hoisted(() => ({
  tokens: [[{ content: "const", color: "#000", offset: 0 }]],
}));

vi.mock("@streamdown/code", () => ({
  code: {
    getSupportedLanguages: () => ["typescript"],
    getThemes: () => ["github-light", "github-dark"],
    highlight: () => cached,
  },
}));

const { useHighlightedLines } = await import("./tool-output-highlight");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Renders of the token consumer; it is memoised on the tokens it is handed. */
let paints = 0;
const Lines = React.memo(function Lines({ tokens }: { tokens: unknown }) {
  paints += 1;
  return <pre>{tokens === null ? "plain" : "coloured"}</pre>;
});

let blockRenders = 0;
function Block() {
  blockRenders += 1;
  const tokens = useHighlightedLines("const", "typescript");
  return <Lines tokens={tokens} />;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  paints = 0;
  blockRenders = 0;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const draw = (mode: "visible" | "hidden") =>
  act(() =>
    root.render(
      <React.Activity mode={mode}>
        <Block />
      </React.Activity>,
    ),
  );

describe("useHighlightedLines on reveal", () => {
  it("keeps the tokens it holds when the cache answers with the same ones", () => {
    draw("visible");
    expect(container.textContent).toBe("coloured");
    const settled = paints;
    const rendered = blockRenders;
    draw("hidden");
    draw("visible");
    expect(container.textContent).toBe("coloured");
    expect(paints).toBe(settled);
    // One render per `root.render` (the hidden one at offscreen priority, then
    // the reveal), and none of the block's own: re-adopting the same tokens
    // as a new state object would add a third.
    expect(blockRenders - rendered).toBe(2);
  });
});
