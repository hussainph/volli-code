// @vitest-environment jsdom
/** Inspector folds are immediate for every input and motion preference. */
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  RailFold,
  RailFoldBody,
  RailFoldCaret,
  RailFoldTrigger,
  RailFoldHeadingRow,
  RailSectionHeadingRow,
} from "./rail-panel-parts";

let container: HTMLElement;
let root: Root;

function Fold({
  initial = false,
  uncontrolled = false,
}: {
  initial?: boolean;
  uncontrolled?: boolean;
}) {
  const [open, setOpen] = useState(initial);
  return (
    <RailFold {...(uncontrolled ? { defaultOpen: initial } : { open, onOpenChange: setOpen })}>
      <RailFoldTrigger asChild>
        <button type="button" data-testid="trigger">
          Earlier <RailFoldCaret open={open} placement="eyebrow" />
        </button>
      </RailFoldTrigger>
      <RailFoldBody>
        <button type="button" data-testid="inside">
          Row
        </button>
      </RailFoldBody>
    </RailFold>
  );
}

function Controlled({ open }: { open: boolean }) {
  return (
    <RailFold open={open}>
      <RailFoldTrigger data-testid="trigger">Toggle</RailFoldTrigger>
      <RailFoldBody>
        <button data-testid="inside">Row</button>
      </RailFoldBody>
    </RailFold>
  );
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.documentElement.removeAttribute("data-motion");
  vi.unstubAllGlobals();
});
function body(): HTMLElement {
  return container.querySelector<HTMLElement>('[data-slot="rail-fold-body"]')!;
}
function trigger(): HTMLElement {
  return container.querySelector<HTMLElement>('[data-testid="trigger"]')!;
}
function press(detail: number): void {
  act(() => trigger().dispatchEvent(new MouseEvent("click", { bubbles: true, detail })));
}

describe("the rail's immediate fold", () => {
  it("wires trigger identity, restores open state without motion and unmounts closed content", () => {
    act(() => root.render(<Fold initial />));
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(trigger().getAttribute("aria-controls")).toBe(body().id);
    expect(body().hidden).toBe(false);
    expect(body().style.transition).toBe("");
    press(1);
    expect(body().hidden).toBe(true);
    expect(body().hasAttribute("inert")).toBe(true);
    expect(container.querySelector('[data-testid="inside"]')).toBeNull();
  });

  for (const detail of [0, 1]) {
    it(`opens, closes and reopens synchronously for click detail ${detail}`, () => {
      const measure = vi.spyOn(Element.prototype, "getBoundingClientRect");
      act(() => root.render(<Fold />));
      for (let i = 0; i < 3; i++) {
        press(detail);
        expect(trigger().getAttribute("aria-expanded")).toBe(i === 1 ? "false" : "true");
        expect(body().hidden).toBe(i === 1);
        expect(body().style.height).toBe("");
        expect(body().style.transition).toBe("");
        expect(trigger().querySelector("svg")?.getAttribute("class")).not.toContain("transition");
      }
      expect(measure).not.toHaveBeenCalled();
      measure.mockRestore();
    });
  }

  it("keeps controlled programmatic close focus return", () => {
    act(() => root.render(<Controlled open />));
    act(() => container.querySelector<HTMLElement>('[data-testid="inside"]')?.focus());
    act(() => root.render(<Controlled open={false} />));
    expect(document.activeElement).toBe(trigger());
  });

  it("keeps uncontrolled state and respects prevented trigger actions", () => {
    act(() => root.render(<Fold uncontrolled />));
    press(1);
    expect(body().hidden).toBe(false);
    act(() =>
      root.render(
        <RailFold>
          <RailFoldTrigger data-testid="trigger" onClick={(e) => e.preventDefault()}>
            Blocked
          </RailFoldTrigger>
          <RailFoldBody>Body</RailFoldBody>
        </RailFold>,
      ),
    );
    press(1);
    expect(body().hidden).toBe(true);
  });

  it("has no motion machinery to resume after Motion or OS preference changes", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    document.documentElement.dataset.motion = "off";
    act(() => root.render(<Fold />));
    press(1);
    document.documentElement.dataset.motion = "on";
    press(1);
    expect(body().hidden).toBe(true);
    expect(body().getAttribute("style")).toBeNull();
  });

  it("uses the same compact h3 band for plain and foldable inspector groups", () => {
    act(() =>
      root.render(
        <RailFold>
          <RailSectionHeadingRow label="Automations" />
          <RailFoldHeadingRow
            label="Sessions"
            open={false}
            foldable
            triggerLabel="Earlier sessions"
          />
          <RailFoldHeadingRow label="Files" open={false} foldable={false} triggerLabel="Unused" />
        </RailFold>,
      ),
    );
    expect([...container.querySelectorAll("h3")].map((node) => node.textContent)).toEqual([
      "Automations",
      "Sessions",
      "Files",
    ]);
    for (const heading of container.querySelectorAll("h3")) {
      expect(heading.className).toContain("text-ui");
      expect(heading.closest("div")?.className).toContain("min-h-7");
    }
    expect(container.querySelector("h2")).toBeNull();
  });
});
