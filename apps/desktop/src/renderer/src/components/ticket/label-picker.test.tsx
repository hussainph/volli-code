/**
 * A render smoke test, not a behavioral one: these run under `renderToStaticMarkup`
 * with no DOM, and zustand serves its INITIAL state to a server render — so the
 * project's stored vocabulary is out of reach here and only what arrives as
 * props can be asserted. What the picker offers is settled in
 * `label-picker-model.test.ts`; what is left to check is that the surface
 * renders at all, and that a label already on the ticket is a row in it.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { LabelPickerContent } from "./label-picker";

const noop = (_next: string[]): void => {};

function render(value: readonly string[]): string {
  return renderToStaticMarkup(
    <LabelPickerContent projectId="project-1" value={value} onChange={noop} />,
  );
}

describe("LabelPickerContent", () => {
  it("gives a label the ticket already carries a row of its own", () => {
    // Selected names come from props, so they are pickable (and un-pickable)
    // even before the project has a label row for them — the composer's case.
    expect(render(["bug"])).toContain("bug");
  });

  it("says so when there is nothing to pick", () => {
    expect(render([])).toContain("No labels");
  });
});
