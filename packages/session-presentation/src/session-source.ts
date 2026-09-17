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
  isSubagentSession,
  shortSessionId,
  type HarnessId,
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
 *
 * The Subagent arm is the one answer no listing currently asks for: since
 * VC-279 every Session listing drops those rows (`isListableSession`), so the
 * words below are what a surface WOULD be told, not what one is showing. It
 * stays because naming a Session's source and deciding which Sessions a list
 * draws are different questions, and this contract only answers the first —
 * every Volli client reaching the same words for the same Session is the whole
 * reason the rule is written here.
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
    if (!isSubagentSession(record)) return "Chat";
    return record.parentSessionId === null
      ? "Subagent"
      : `Subagent · of ${shortSessionId(record.parentSessionId)}`;
  }
  const record = row.record;
  // Through {@link sessionSourceHarness} rather than re-deriving the gate, so
  // the words and the id cannot drift: the agent arm IS "this row names a
  // harness", and one function decides that for both callers. A non-null
  // harness here is exactly `launchKind === "agent"`, which is what makes the
  // remaining two arms the shell/pre-metadata split they always were.
  const harness = sessionSourceHarness(row);
  const source =
    harness !== null ? harnessLabel(harness) : record.launchKind === "shell" ? "Shell" : "Terminal";
  return record.placement === "split" ? `${source} · Split` : source;
}

/**
 * WHICH CLI is running here, as an id rather than as words — or `null` for a
 * Session that runs none: a chat, a bare shell, a pane that predates launch
 * metadata.
 *
 * The harness half of {@link sessionSourceLabel}, and the half that DECIDES:
 * the label calls this rather than re-deriving the rule, so a surface that
 * draws Claude Code apart from Codex cannot reach a different verdict from the
 * words beside it. That is a property of the code here, not a convention two
 * functions are trusted to keep — the `launchKind` gate and the
 * {@link effectiveHarnessId} fallback exist once. A shell launch that later ran
 * an agent still names no harness here, exactly as it still reads "Shell"
 * above, and a pane whose agent was replaced names what is in it now.
 *
 * An id and not a label because the caller is drawing artwork. Words are a
 * client-neutral fact this contract owns; which glyph stands for `codex` is the
 * client's, and handing a label back would have every client parsing English to
 * pick one.
 */
export function sessionSourceHarness(row: SessionListingIdentity): HarnessId | null {
  if (row.kind === "chat") return null;
  return row.record.launchKind === "agent" ? effectiveHarnessId(row.record) : null;
}
