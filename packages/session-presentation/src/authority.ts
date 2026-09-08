/**
 * What a running Session says about the policy it is governed by.
 *
 * ONE FACT, AND IT IS A DURABLE ONE. The chip reads the Snapshot saved against
 * the LIVE ATTACHMENT and nothing else — never the project's current setting,
 * which the renderer is not handed here and must not appear to be showing.
 * Policy is pinned when an attachment opens: a Configure edit made since then
 * reaches the next attachment, and a chip that re-derived itself from today's
 * setting would quietly claim a running Session had changed posture.
 *
 * THE WORDING IS THE POINT (VC-285/A03). "Observe" alone is the word the audit
 * found unreadable — it sits beside a decision-maker row and reads as active
 * protection while nothing is being refused. So each state is said as an
 * outcome:
 *
 *  - `observe` — the Snapshot was SAVED for this attachment and calls were
 *    allowed. "policy record", not "record only": what is recorded is the
 *    policy this attachment ran under, not a log of each call it made. The
 *    per-call observe record is VC-28's.
 *  - `enforce`  — the gate is installed and a rule violation is blocked.
 *  - no Snapshot — the honest fallback. `enforcement: "off"` saves none, and
 *    neither did any attachment written before VC-44; both mean the runtime's
 *    own defaults, and the two are indistinguishable in durable history by
 *    design. The chip says that rather than guessing which one it is.
 *
 * The version is `rulePackHash` because there is no saved policy version field
 * to read, and the Snapshot's `mode: "auto"` is internal vocabulary rather than
 * an outcome anyone can act on.
 */
import type { RendererSessionAuthority } from "@volli/shared";

/** Which of the three states a chip is in — for styling and for tests. */
export type AuthorityChipState = "observe" | "enforce" | "no-snapshot";

export interface AuthorityChipView {
  state: AuthorityChipState;
  /**
   * What the chip shows without being hovered, opened or expanded.
   *
   * The whole outcome, not a word standing for one. This ticket exists because
   * the meaning lived in a popover, and a chip that needed opening would be the
   * same mistake one surface over.
   */
  label: string;
  /** The same fact as one sentence, for the chip's accessible name. */
  summary: string;
}

/** The outcome each saved posture had, in the words a person can act on. */
const OUTCOME: Record<"observe" | "enforce", { name: string; outcome: string }> = {
  observe: { name: "Observe", outcome: "policy record" },
  enforce: { name: "Enforce", outcome: "blocks rules" },
};

/**
 * The chip for a live attachment, or `null` when there is nothing attached.
 *
 * `null` in and `null` out is the distinction the surface needs: no attachment
 * is nothing to say — a Session that has not attached is not running under any
 * policy yet — while an attachment holding no Snapshot is a positive fact about
 * a Session that IS running. Drawing the fallback for both would put "runtime
 * defaults" on a Session that has not started.
 */
export function authorityChip(
  authority: RendererSessionAuthority | null,
): AuthorityChipView | null {
  if (authority === null) return null;
  const { snapshot } = authority;
  if (snapshot === null) {
    return {
      state: "no-snapshot",
      label: "No policy snapshot — runtime defaults",
      summary: "Authority: no policy snapshot — runtime defaults",
    };
  }
  const { name, outcome } = OUTCOME[snapshot.enforcement];
  const label = `${name} — ${outcome} · pack ${snapshot.rulePackHash}`;
  return { state: snapshot.enforcement, label, summary: `Authority: ${label}` };
}
