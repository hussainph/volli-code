/**
 * Model-generated Session titles: the strict prompt the titling call sends and
 * the sanitizer that turns whatever came back into a title the UI budget holds.
 *
 * The sanitizer is defensive by design, not trusting. A strict prompt reduces
 * how often the model answers with anything but a title, and still everything
 * here treats the reply as untrusted text: whatever shape the model actually
 * returned is cut down to one line, six words, and the Session-title length
 * budget. The title is a label, not content — a model that ignored the prompt
 * costs itself the flourish, never the reader.
 *
 * The constants live in `@volli/shared` because two processes agree on them:
 * main sends the prompt, and the renderer's tests assert the label budget the
 * sanitizer guarantees. A copy on either side would drift the way the two
 * `DEFAULT_KICKOFF_MESSAGE` copies are documented never to.
 */
import { truncateSessionTitle } from "./session-title";

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
const TITLE_PREFIX = /^title\b\s*[:—-]\s*/i;

/**
 * The model's reply, cut down to a title the label budget holds — or `null`
 * when nothing survives.
 *
 * Everything the prompt asked the model not to do is still corrected here:
 * quotes and trailing punctuation come off, an explanation line is dropped,
 * over-long answers are cut to {@link AUTO_TITLE_MAX_WORDS} words, and the
 * whole string is truncated to the same word-boundary budget the shipped
 * heuristic uses, so a model title never outgrows the tab it lands in.
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
  const words = title.length === 0 ? [] : title.split(" ");
  const budgeted = words.slice(0, AUTO_TITLE_MAX_WORDS).join(" ").replace(TRAILING_PUNCTUATION, "");
  const cut = truncateSessionTitle(budgeted);
  return cut.length === 0 ? null : cut;
}
