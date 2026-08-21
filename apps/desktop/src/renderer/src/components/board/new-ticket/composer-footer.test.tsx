import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { ComposerRun } from "./composer-run";

import { ComposerFooter } from "./composer-footer";

const run: ComposerRun = {
  models: [],
  selection: null,
  setSelection: () => {},
};

function render(overrides: { onAttachFiles?: (files: readonly File[]) => void } = {}): string {
  return renderToStaticMarkup(
    <ComposerFooter
      run={run}
      createMore={false}
      onCreateMoreChange={() => {}}
      onCreate={() => {}}
      onKickoff={() => {}}
      disabled={false}
      {...overrides}
    />,
  );
}

/**
 * VC-115: the footer carried two paperclips — this one, and a popover that
 * searched the project file index. The second is gone, so what these assert is
 * a COUNT, not just a presence: a returning project-file icon fails the first
 * test even though every other assertion still passes.
 */
describe("the composer footer's attach affordance", () => {
  it("offers exactly one paperclip, and it is the system file picker", () => {
    const html = render({ onAttachFiles: () => {} });

    expect(html.match(/aria-label="Attach files"/g)).toHaveLength(1);
    expect(html.match(/type="file"/g)).toHaveLength(1);
    expect(html).toContain("multiple");
  });

  it("no longer renders the project file-reference picker", () => {
    const html = render({ onAttachFiles: () => {} });

    expect(html).not.toContain("Attach file reference");
    expect(html).not.toContain("Search files…");
  });

  it("renders no attach control at all when the composer takes no files", () => {
    const html = render();

    expect(html).not.toContain('aria-label="Attach files"');
    expect(html).not.toContain('type="file"');
  });
});
