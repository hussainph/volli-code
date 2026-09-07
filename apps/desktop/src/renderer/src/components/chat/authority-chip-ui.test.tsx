/**
 * The Session's Authority chip, drawn.
 *
 * Static markup, like every other pane test here: what is asserted is the text
 * a person reads without hovering, opening or expanding anything — which is the
 * whole point of the chip. A fact that needed a popover to reach would repeat
 * the mistake VC-285 exists to undo.
 */
import { BUILTIN_RULE_PACK_HASH, BUILTIN_RULE_PACK_ID } from "@volli/shared";
import type { RendererSessionAuthority } from "@volli/shared";
import { authorityChip } from "@volli/session-presentation";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { AuthorityChip } from "./authority-chip-ui";

function render(authority: RendererSessionAuthority | null): string {
  return renderToStaticMarkup(<AuthorityChip chip={authorityChip(authority)} />);
}

function pinned(enforcement: "observe" | "enforce"): RendererSessionAuthority {
  return {
    attachmentId: "attachment-1",
    snapshot: {
      enforcement,
      rulePackId: BUILTIN_RULE_PACK_ID,
      rulePackHash: BUILTIN_RULE_PACK_HASH,
    },
  };
}

describe("AuthorityChip", () => {
  it("shows the saved outcome and the pack version, unopened", () => {
    const html = render(pinned("observe"));

    expect(html).toContain("Observe — policy record");
    expect(html).toContain(`pack ${BUILTIN_RULE_PACK_HASH}`);
    expect(html).toContain('data-testid="session-authority-chip"');
    expect(html).toContain('data-authority="observe"');
  });

  it("says an enforcing attachment blocks rules", () => {
    const html = render(pinned("enforce"));

    expect(html).toContain("Enforce — blocks rules");
    expect(html).toContain('data-authority="enforce"');
  });

  it("names the runtime defaults when the attachment saved no Snapshot", () => {
    const html = render({ attachmentId: "attachment-1", snapshot: null });

    expect(html).toContain("No policy snapshot — runtime defaults");
    expect(html).toContain('data-authority="none"');
    expect(html).not.toContain("pack");
  });

  it("names the fact for a screen reader as Authority, which the glyph says visually", () => {
    expect(render(pinned("enforce"))).toContain(
      `Authority: Enforce — blocks rules · pack ${BUILTIN_RULE_PACK_HASH}`,
    );
  });

  it("draws nothing at all while no attachment is live", () => {
    expect(render(null)).toBe("");
  });
});
