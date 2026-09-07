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

    expect(html).toContain(`Authority: Observe — policy record · pack ${BUILTIN_RULE_PACK_HASH}`);
    expect(html).toContain('data-testid="session-authority-chip"');
    expect(html).toContain('data-authority="observe"');
    expect(html).toContain("whitespace-normal");
    expect(html).not.toContain("truncate");
  });

  it("says an enforcing attachment blocks rules", () => {
    const html = render(pinned("enforce"));

    expect(html).toContain("Enforce — blocks rules");
    expect(html).toContain('data-authority="enforce"');
  });

  it("names the runtime defaults when the attachment saved no Snapshot", () => {
    const html = render({ attachmentId: "attachment-1", snapshot: null });

    expect(html).toContain("Authority: no policy snapshot — runtime defaults");
    expect(html).toContain('data-authority="no-snapshot"');
    expect(html).not.toContain("pack");
  });

  it("names the fact as Authority in the same visible sentence", () => {
    const html = render(pinned("enforce"));

    expect(html).toContain(
      `<span class="min-w-0">Authority: Enforce — blocks rules · pack ${BUILTIN_RULE_PACK_HASH}</span>`,
    );
    expect(html).not.toContain("sr-only");
  });

  it("draws nothing at all while no attachment is live", () => {
    expect(render(null)).toBe("");
  });
});
