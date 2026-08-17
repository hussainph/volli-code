/** The longest generated Session title before it is cut at a word boundary. */
export const SESSION_TITLE_MAX_LENGTH = 48;

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
    if (collapsed.length <= SESSION_TITLE_MAX_LENGTH) return collapsed;
    const cut = collapsed.slice(0, SESSION_TITLE_MAX_LENGTH);
    const wordBoundary = cut.lastIndexOf(" ");
    return `${wordBoundary === -1 ? cut : cut.slice(0, wordBoundary)}…`;
  }
  return null;
}

const STAGE_AND_TICKET =
  /^(?:please\s+)?(validate|verify|implement|review|plan|test|fix|investigate|design|document|research|triage)\b[\s:,-]*(?:the\s+)?(?:ticket\s+)?([a-z][a-z0-9]*-\d+)\b/i;

/**
 * A title for a CLI kickoff. Explicit stage-and-ticket requests become the
 * compact orchestration shape (for example `Validate VC-52`); the stock
 * kickoff falls back to the started ticket rather than naming the instruction.
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
