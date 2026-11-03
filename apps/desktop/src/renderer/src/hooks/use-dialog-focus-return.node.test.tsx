// @vitest-environment node
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { useDialogFocusReturn } from "./use-dialog-focus-return";

function Fixture({ open }: { open: boolean }) {
  useDialogFocusReturn(open);
  return <span>{open ? "open" : "closed"}</span>;
}

describe("dialog focus return without a DOM", () => {
  for (const open of [false, true]) {
    it(`renders with open=${open} without reading browser globals`, () => {
      expect(typeof document).toBe("undefined");
      expect(typeof HTMLElement).toBe("undefined");
      expect(renderToStaticMarkup(<Fixture open={open} />)).toBe(
        `<span>${open ? "open" : "closed"}</span>`,
      );
    });
  }
});
