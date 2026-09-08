import { describe, expect, it } from "vite-plus/test";
import { BUILTIN_RULE_PACK_HASH, BUILTIN_RULE_PACK_ID } from "@volli/shared";
import type { RendererSessionAuthority } from "@volli/shared";

import { authorityChip } from "./authority";

function summary(
  enforcement: "observe" | "enforce",
  attachmentId = "attachment-1",
): RendererSessionAuthority {
  return {
    attachmentId,
    snapshot: {
      enforcement,
      rulePackId: BUILTIN_RULE_PACK_ID,
      rulePackHash: BUILTIN_RULE_PACK_HASH,
    },
  };
}

describe("authorityChip", () => {
  /*
   * The chip says the OUTCOME, not the posture's name alone. "Observe" on its
   * own is the word the audit found unreadable in Configure, and a chip that
   * repeated it would move the same puzzle to a second surface.
   */
  it("reads an observed attachment as a policy record with the pack it pinned", () => {
    const chip = authorityChip(summary("observe"));

    expect(chip).toEqual({
      state: "observe",
      label: `Observe — policy record · pack ${BUILTIN_RULE_PACK_HASH}`,
      summary: `Authority: Observe — policy record · pack ${BUILTIN_RULE_PACK_HASH}`,
    });
  });

  it("reads an enforcing attachment as blocking rules, with the same pack version", () => {
    const chip = authorityChip(summary("enforce"));

    expect(chip?.state).toBe("enforce");
    expect(chip?.label).toBe(`Enforce — blocks rules · pack ${BUILTIN_RULE_PACK_HASH}`);
    expect(chip?.summary).toBe(
      `Authority: Enforce — blocks rules · pack ${BUILTIN_RULE_PACK_HASH}`,
    );
  });

  /*
   * `rulePackHash` is the version, because there is no saved policy version
   * field to read. Give the id a tempting display value so this test proves the
   * formatter selects the hash rather than merely receiving no competing word.
   */
  it("versions the chip by the saved pack hash, not by the pack id", () => {
    const chip = authorityChip({
      attachmentId: "attachment-1",
      snapshot: { enforcement: "enforce", rulePackId: "auto", rulePackHash: "0badc0de" },
    });

    expect(chip?.label).toContain("pack 0badc0de");
    expect(chip?.label).not.toContain("auto");
  });

  /*
   * `null` covers BOTH `enforcement: "off"` and every attachment written before
   * VC-44 — deliberately indistinguishable in durable history. So the chip says
   * what is true of both and never infers today's project setting, which it
   * cannot see and must not appear to.
   */
  it("calls a missing Snapshot the runtime defaults rather than guessing a policy", () => {
    const chip = authorityChip({ attachmentId: "attachment-1", snapshot: null });

    expect(chip).toEqual({
      state: "no-snapshot",
      label: "No policy snapshot — runtime defaults",
      summary: "Authority: no policy snapshot — runtime defaults",
    });
    expect(chip?.label).not.toContain("Observe");
    expect(chip?.label).not.toContain("Off");
  });

  /** Nothing attached is nothing to say: the chip is absent, not empty. */
  it("has no chip while no attachment is live", () => {
    expect(authorityChip(null)).toBeNull();
  });
});
