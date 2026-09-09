// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { ListRow } from "./list-row";

describe("ListRow", () => {
  it("draws an activatable row as a button that carries the focus ring", () => {
    const html = renderToStaticMarkup(<ListRow primary="rail.tsx" onActivate={vi.fn()} />);

    expect(html).toContain("<button");
    expect(html).toContain("focus-visible:ring-2");
    expect(html).toContain("focus-visible:ring-ring/45");
  });

  it("draws an inert row as a div with no hover fill", () => {
    // A hover tint on a row nothing happens to is a lie the pointer tells —
    // this is the branch the primitive exists to spell once.
    const html = renderToStaticMarkup(<ListRow primary="Closed terminal" onActivate={null} />);

    expect(html).not.toContain("<button");
    expect(html).not.toContain("hover:bg-accent/50");
  });

  it("keeps the selected fill instead of the hover one", () => {
    const html = renderToStaticMarkup(<ListRow primary="rail.tsx" selected onActivate={vi.fn()} />);

    expect(html).toContain("bg-accent/70");
    expect(html).not.toContain("hover:bg-accent/50");
  });

  it("weights a two-line name over the line under it and leaves a one-line name alone", () => {
    const twoLine = renderToStaticMarkup(
      <ListRow
        density="two-line"
        primary="rail.tsx"
        secondary="src/components"
        onActivate={null}
      />,
    );
    const oneLine = renderToStaticMarkup(<ListRow primary="Chat" onActivate={null} />);

    expect(twoLine).toContain("font-medium");
    expect(twoLine).toContain("min-h-13");
    expect(twoLine).toContain("text-muted-foreground/70");
    expect(oneLine).not.toContain("font-medium");
  });

  it("typesets a string name but leaves a node one to its caller", () => {
    const string = renderToStaticMarkup(<ListRow primary="rail.tsx" onActivate={null} />);
    const node = renderToStaticMarkup(
      <ListRow primary={<input aria-label="Rename" />} onActivate={null} />,
    );

    expect(string).toContain("truncate");
    // A truncating wrapper would clip a rename field to its own content box.
    expect(node).toContain("<input");
    expect(node).not.toContain("truncate");
  });

  it("keeps actions outside the activation target", () => {
    const html = renderToStaticMarkup(
      <ListRow
        primary="rail.tsx"
        onActivate={vi.fn()}
        actions={<button type="button">Copy</button>}
      />,
    );

    // A button inside a button is not markup; the shell is what holds both.
    expect(html.indexOf("Copy")).toBeGreaterThan(html.indexOf("</button>"));
  });
});

describe("a ListRow a wrapper has merged its own listeners onto", () => {
  let container: HTMLElement | null = null;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
  });

  afterEach(() => {
    container?.remove();
    container = null;
    vi.unstubAllGlobals();
  });

  function clickRow(props: Partial<React.ComponentProps<typeof ListRow>>): void {
    const root = createRoot(container!);
    act(() => root.render(<ListRow primary="rail.tsx" onActivate={null} {...props} />));
    act(() => container?.querySelector("button")?.click());
    act(() => root.unmount());
  }

  it("still opens: a merged onClick runs BESIDE the activation, never instead of it", () => {
    // The bug this pins: `{...rest}` landed after `onClick={onActivate}`, so a
    // Radix trigger wrapping a row — Tooltip closes itself on click — replaced
    // the activation outright. The row went on ringing and highlighting and
    // opened nothing at all.
    const onActivate = vi.fn();
    const fromWrapper = vi.fn();

    clickRow({ onActivate, onClick: fromWrapper });

    expect(fromWrapper).toHaveBeenCalledTimes(1);
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it("lets that wrapper cancel the activation by preventing the default", () => {
    const onActivate = vi.fn();

    clickRow({
      onActivate,
      onClick: (event) => event.preventDefault(),
    });

    expect(onActivate).not.toHaveBeenCalled();
  });
});
