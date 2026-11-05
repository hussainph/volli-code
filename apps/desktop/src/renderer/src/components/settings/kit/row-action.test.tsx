import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { FolderOpenIcon } from "@renderer/components/ui/icon";

import { TooltipProvider } from "@renderer/components/ui/tooltip";
import { RowAction } from "./row-action";

describe("RowAction", () => {
  it("uses the full icon control rung without shrinking its glyph", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <RowAction
          label="Reveal project in Finder"
          hint="Reveal"
          icon={FolderOpenIcon}
          onAct={vi.fn()}
        />
      </TooltipProvider>,
    );
    expect(html).toContain('data-size="icon"');
    expect(html).toContain('aria-label="Reveal project in Finder"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain('data-size="icon-xs"');
  });
});
