/**
 * Model-generated Session titles: the model policy the titling call resolves
 * through, the strict prompt it sends, and the sanitizer that turns whatever
 * came back into a title the UI budget holds.
 *
 * The sanitizer is defensive by design, not trusting. A strict prompt reduces
 * how often the model answers with anything but a title, and still everything
 * here treats the reply as untrusted text: whatever shape the model actually
 * returned is cut down to one line, six words, and the Session-title length
 * budget — and a reply that is plainly prose rather than a title is refused
 * outright, because a mid-sentence fragment is a worse label than the
 * heuristic it would replace. The title is a label, not content.
 *
 * This lives in `@volli/shared` because it is domain policy, not plumbing:
 * main resolves the ladder and sends the prompt, and the renderer's tests
 * assert the label budget the sanitizer guarantees. A copy on either side
 * would drift the way the two `DEFAULT_KICKOFF_MESSAGE` copies are documented
 * never to.
 */
import type { ModelSelection } from "./agent-runtime";
import { truncateSessionTitle } from "./session-title";

/**
 * The three rungs a titling call resolves through, in order.
 *
 * Named here rather than written as a `??` chain at the call site because it
 * is the policy, and policy is what this package is for. The order is the
 * owner's, recorded on VC-81: the explicit cost-efficient choice first, then
 * the model the chat is already running under, then the Role's default.
 *
 * Why the Session's own model outranks the Role default: a Role default is an
 * ORCHESTRATION model — the expensive, reasoning-heavy tier a person picks for
 * doing the work — while the model a given chat runs under is the one they
 * already accepted the bill for on that conversation. Falling to the Role
 * default ahead of it would reach for the priciest thing in the profile to
 * write six words.
 *
 * None of this is a silent fallback: the chain is fixed, stated in Settings on
 * the Utility row, and every rung is a model the person configured themselves.
 * A profile that configured nothing anywhere resolves null and never calls.
 */
export interface AutoTitleModelLadder {
  /** Rung one: the explicit cost-efficient default (VC-53's `utility` purpose). */
  utility: ModelSelection | null;
  /** Rung two: the model this chat Session is already running under. */
  session: ModelSelection | null;
  /** Rung three: the Role's resolved default (`ticket ?? global`, or `global`). */
  roleDefault: ModelSelection | null;
}

/** The model one titling call runs on, or null when the profile configured none. */
export function resolveAutoTitleModel(ladder: AutoTitleModelLadder): ModelSelection | null {
  return ladder.utility ?? ladder.session ?? ladder.roleDefault;
}

/**
 * The longest first-user-message this sends a model to derive a title from.
 *
 * A title is six words; the opening paragraph decides them. Everything past
 * this is a pasted stack trace or a whole file the caller happened to lead
 * with, and billing input tokens for it buys nothing — the model has long
 * since read enough to name the conversation.
 */
export const AUTO_TITLE_MAX_SUBJECT_CHARS = 2000;

/** The first user message, cut to {@link AUTO_TITLE_MAX_SUBJECT_CHARS}. */
export function autoTitleSubject(message: string): string {
  return message.length <= AUTO_TITLE_MAX_SUBJECT_CHARS
    ? message
    : message.slice(0, AUTO_TITLE_MAX_SUBJECT_CHARS).trimEnd();
}

/** The system prompt the titling call runs under. Aggressive on purpose (VC-81). */
export const AUTO_TITLE_SYSTEM_PROMPT =
  "Return only a title for this conversation. Six words maximum. No quotes, no punctuation, no explanation.";

/** The word ceiling the prompt states and the sanitizer enforces. */
export const AUTO_TITLE_MAX_WORDS = 6;

/** One layer of surrounding quotes, in the three shapes a model reaches for. */
function isQuote(char: string | undefined): boolean {
  return char === '"' || char === "'" || char === "`";
}

/** Trailing sentence furniture a title never needs: `.`, `!`, `,`, `;`, `:`, `?`. */
const TRAILING_PUNCTUATION = /[.!;,?:]+$/;

/**
 * A `Title:` / `Title -` prefix — the one non-title shape the prompt's "return
 * only" instruction provokes anyway. Only stripped when a separator follows,
 * so a legitimate title that happens to begin with the word "Title" survives.
 */
const TITLE_PREFIX = /^title\b\s*[:—–-]\s*/i;

/**
 * A reply this many times over the word ceiling is not an over-long title, it
 * is prose. Cutting prose at six words yields a mid-clause fragment, which is
 * a worse label than the heuristic it would replace — so the caller keeps the
 * heuristic instead.
 */
const PROSE_WORD_FACTOR = 2;

/**
 * The shortest conversational lead-in worth cutting off a reply, in words.
 *
 * "Sure! Here is your title: Fix the parser" is the shape a chatty model
 * answers with, and the title is what follows the colon. But a colon after one
 * or two words is usually part of the title itself ("VC-81: model titles",
 * "Auth: login and signup"), so only a clause long enough to be a sentence is
 * treated as furniture.
 */
const LEAD_IN_MIN_WORDS = 3;

/**
 * Drops a conversational lead-in clause — everything up to and including the
 * first colon-terminated word — when the clause is long enough to be one.
 *
 * A reply that is nothing BUT the lead-in ("Here is the title:") slices to
 * empty on purpose: it contains no title, and empty is how this file says
 * "keep the heuristic".
 */
function withoutLeadIn(words: readonly string[]): readonly string[] {
  const colon = words.findIndex((word) => word.endsWith(":"));
  const leadInWords = colon + 1;
  if (colon === -1 || leadInWords < LEAD_IN_MIN_WORDS) return words;
  if (leadInWords > AUTO_TITLE_MAX_WORDS) return words;
  return words.slice(leadInWords);
}

/**
 * The model's reply, cut down to a title the label budget holds — or `null`
 * when nothing survives.
 *
 * Everything the prompt asked the model not to do is still corrected here:
 * quotes and trailing punctuation come off, an explanation line is dropped, a
 * conversational lead-in clause is cut, slightly over-long answers are trimmed
 * to {@link AUTO_TITLE_MAX_WORDS} words, and the whole string is truncated to
 * the same word-boundary budget the shipped heuristic uses, so a model title
 * never outgrows the tab it lands in.
 *
 * The one thing it will NOT do is salvage prose. A reply several times over
 * the ceiling did not answer the question, and its first six words are a
 * fragment; `null` sends the caller back to its heuristic, which at least
 * reads as a whole thought.
 */
export function sanitizeAutoTitle(raw: string): string | null {
  // `split` always returns at least one element, so the first line exists
  // even for an empty reply; `noUncheckedIndexedAccess` is off.
  const firstLine = raw.split(/\r?\n/, 1)[0];
  let title = firstLine.replace(/\s+/g, " ").trim();
  while (title.length >= 2 && isQuote(title[0]) && title[title.length - 1] === title[0]) {
    title = title.slice(1, -1).trim();
  }
  title = title.replace(TITLE_PREFIX, "").trim();
  const words = withoutLeadIn(title.length === 0 ? [] : title.split(" "));
  if (words.length > AUTO_TITLE_MAX_WORDS * PROSE_WORD_FACTOR) return null;
  const budgeted = words.slice(0, AUTO_TITLE_MAX_WORDS).join(" ").replace(TRAILING_PUNCTUATION, "");
  const cut = truncateSessionTitle(budgeted);
  return cut.length === 0 ? null : cut;
}
