/** The longest generated Session title before it is cut at a word boundary. */
export const SESSION_TITLE_MAX_LENGTH = 48;

/**
 * Cuts `text` to the Session-title length budget on a word boundary, with an
 * ellipsis. The shared budget discipline for every generated title, heuristic
 * and model-sourced alike.
 */
export function truncateSessionTitle(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= SESSION_TITLE_MAX_LENGTH) return collapsed;
  const cut = collapsed.slice(0, SESSION_TITLE_MAX_LENGTH);
  const wordBoundary = cut.lastIndexOf(" ");
  return `${wordBoundary === -1 ? cut : cut.slice(0, wordBoundary)}…`;
}

/**
 * A compact Session title taken from the first visible line of a message.
 *
 * The heuristic is intentionally local and deterministic: naming a Session
 * must not spend a model call or silently choose a different configured model.
 */
export function autoTitleFromMessage(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const collapsed = line.replace(/\s+/g, " ").trim();
    if (collapsed.length === 0) continue;
    return truncateSessionTitle(collapsed);
  }
  return null;
}

/**
 * The opening turn a Ticket Session is started with when nobody dictated one.
 *
 * A fresh structured Session idles until its first message — the Runtime Brief
 * is prepended to the FIRST delivered message, not sent on attach — so this is
 * what makes the agent begin as the Session opens. It says nothing the Brief
 * does not already guarantee is above it, which is why the same sentence serves
 * both doors that start a Ticket Session without an instruction: the
 * `session_start` tool on the Agent Tool Surface and the composer's Create &
 * start. (The shell had a third door until VC-163 closed it.)
 *
 * Shared rather than declared at each door, and here rather than beside either
 * of them, because {@link autoTitleFromKickoff} is written AGAINST this
 * sentence: it recognises the stock kickoff and names the Session after the
 * ticket instead of after the instruction. Two copies of the string would let
 * one door drift and start titling its Sessions "Begin work on this ticket…".
 */
export const DEFAULT_KICKOFF_MESSAGE =
  "Begin work on this ticket. Your assignment is the Ticket Brief above.";

const STAGE_AND_TICKET =
  /^(?:please\s+)?(validate|verify|implement|review|plan|test|fix|investigate|design|document|research|triage)\b[\s:,-]*(?:the\s+)?(?:ticket\s+)?([a-z][a-z0-9]*-\d+)\b/i;

/**
 * A title for a kickoff turn. Explicit stage-and-ticket requests become the
 * compact orchestration shape (for example `Validate VC-52`); the stock kickoff
 * ({@link DEFAULT_KICKOFF_MESSAGE}) falls back to the started ticket rather than
 * naming the instruction.
 */
export function autoTitleFromKickoff(kickoff: string, ticketDisplayId: string): string {
  const firstLine = autoTitleFromMessage(kickoff);
  if (firstLine === null || /^Begin work on this ticket\b/i.test(firstLine)) {
    return `Work on ${ticketDisplayId}`;
  }
  const stage = firstLine.match(STAGE_AND_TICKET);
  if (stage?.[1] !== undefined && stage[2] !== undefined) {
    const stageName = `${stage[1][0]!.toUpperCase()}${stage[1].slice(1).toLowerCase()}`;
    return `${stageName} ${stage[2].toUpperCase()}`;
  }
  return firstLine;
}
