/**
 * What a shared model name does with a name it cannot draw whole (VC-288).
 *
 * The pure half of this file's module is pinned in `model-identity.test.ts`;
 * this is the drawing, and it exists because the first answer here was a
 * `title` — the pointer's alone, on rows a keyboard walks. Every surface that
 * draws `ModelName` is a list row inside a Select or a cmdk list, where a
 * focus stop of its own would be a nested interactive control the composite
 * widget cannot survive, so the reveal is the row simply not truncating.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ModelName } from "./model-identity";

const MODEL = {
  providerId: "anthropic",
  modelId: "claude-opus-4-5-with-a-very-long-name",
  label: "Claude Opus 4.5 (very long name, as they get)",
};

function run(markup: string): string {
  // The name's own run is the second span: the first is the flex wrapper the
  // mark rides in.
  const spans = markup.split("<span").slice(1);
  return spans[1] ?? "";
}

/** The run's classes, as tokens — so a variant is not mistaken for the rule. */
function runClasses(markup: string): readonly string[] {
  return (/class="([^"]*)"/.exec(run(markup))?.[1] ?? "").split(" ");
}

describe("ModelName in a list row", () => {
  it("wraps the name rather than clipping it out of a keyboard's reach", () => {
    const markup = renderToStaticMarkup(<ModelName model={MODEL} models={[MODEL]} />);
    expect(runClasses(markup)).toContain("break-words");
    // Not `truncate`: an ellipsis in a row a keyboard can highlight but not
    // focus is a value with no way out of it at all. Unconditionally, that is
    // — the trigger-only variant below is a different rule.
    expect(runClasses(markup)).not.toContain("truncate");
  });

  it("keeps the whole run as the pointer's `title` as well", () => {
    const markup = renderToStaticMarkup(
      <ModelName model={MODEL} models={[MODEL]} providerLabel="Anthropic" alwaysProvider />,
    );
    expect(markup).toContain('title="Claude Opus 4.5 (very long name, as they get) · Anthropic"');
  });

  it("still clips to one line where Radix copies it into a closed trigger", () => {
    // A Select trigger is a fixed-height control drawing the selected ITEM's
    // own children, so the one place this must not wrap is the one place the
    // reveal is already there: the trigger is focusable and opens the list.
    const markup = renderToStaticMarkup(<ModelName model={MODEL} models={[MODEL]} />);
    expect(runClasses(markup)).toContain("in-data-[slot=select-trigger]:truncate");
  });
});
