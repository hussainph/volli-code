/**
 * What a Session's row says it IS — the harness, `Shell`, `Terminal`, `Chat`,
 * or a helper another Session started.
 *
 * A presentation label, and here rather than in `@volli/shared` for that
 * reason: CONTEXT.md's Session Semantic Facts are identity, lifecycle, control
 * and historical meaning, and explicitly not "presentation labels, icons,
 * grouping, and layout". Every Volli client naming the same Session must reach
 * the same words, so the rule is written once in the Session Presentation
 * Contract and each client renders it.
 */
import {
  effectiveHarnessId,
  harnessLabel,
  shortSessionId,
  type SessionListingIdentity,
} from "@volli/shared";

/**
 * Truthful, compact source metadata: the sidebar's session rows carry it in
 * their hover `title` (their meta line now prints the ticket's status, which is
 * what a long band is scanned by), the rail's history search matches on it, and
 * a closed terminal's saved record names itself with it. Only agent launches
 * expose a harness. Bare shells and pre-metadata sessions never inherit the
 * default Claude label; split placement remains visible without becoming the
 * title.
 *
 * The harness named is the one RUNNING, not the one the session launched with:
 * a pane whose agent was quit and replaced reads as what is in it now. A shell
 * launch that later ran an agent still reads as "Shell" — `launchKind` is a
 * fact about the pane's origin and no announce changes it.
 *
 * A chat row has none of that — no PTY and no launch — so its source is simply
 * `Chat`. Whether its executor is attached remains a functional grouping fact,
 * not source metadata to display.
 */
// Takes the identity half, not a whole row: naming a Session's source has
// nothing to do with what it spent, and demanding a usage summary would make
// every caller holding a bare record invent one.
export function sessionSourceLabel(row: SessionListingIdentity): string {
  // A helper another Session started is named as one, with the parent it
  // answers to (VC-9); every other structured Session is a chat, whichever of
  // the two root Roles it holds.
  if (row.kind === "chat") {
    const record = row.record;
    if (record.role !== "subagent") return "Chat";
    return record.parentSessionId === null
      ? "Subagent"
      : `Subagent · of ${shortSessionId(record.parentSessionId)}`;
  }
  const record = row.record;
  const source =
    record.launchKind === "agent"
      ? harnessLabel(effectiveHarnessId(record))
      : record.launchKind === "shell"
        ? "Shell"
        : "Terminal";
  return record.placement === "split" ? `${source} · Split` : source;
}
