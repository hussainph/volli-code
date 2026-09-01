/**
 * The one spelling of a delivered prompt resource.
 *
 * A {@link PromptResource} reaches a model down two different pipes — appended
 * to the system prompt at attach time (`@volli/agent-runtime`'s
 * `composeSystemPrompt`), or appended AFTER a user message's own text when a
 * `/skill` reference rides it (`appendPromptResources`, called where the
 * adapter composes the delivered prompt) — and the delimiters have to read
 * identically in both, because the model is told to treat a RESOURCE section
 * as supplied material wherever it appears. Two spellings would be two
 * vocabularies, and the message-side one would drift the day the prompt-side
 * one changed. So the format lives here, in the package both pipes already
 * depend on, and each caller renders through this function rather than owning
 * a copy.
 *
 * On the message pipe the block is adjacent to the user's words, never spliced
 * into them: the text the person typed ends, a blank line follows, and only
 * then does a RESOURCE section begin (VC-49). A block interleaved with user
 * prose read as if the person had pasted the whole skill themselves, which is
 * exactly the authorship confusion the delimiters exist to prevent.
 */
import type { PromptResource } from "./agent-runtime";

/** Render one resource as its delimited block: BEGIN line, body, END line. */
export function promptResourceBlock(resource: PromptResource): string {
  return [
    `--- BEGIN RESOURCE: ${resource.name} ---`,
    resource.text,
    `--- END RESOURCE: ${resource.name} ---`,
  ].join("\n");
}

/**
 * A defensive read of one {@link PromptResource}, for values that crossed a
 * serialization boundary — a persisted draft, a wire message part's `data`.
 * Anything but the exact `{ name, text }` pair of strings is not a resource.
 */
export function isPromptResource(value: unknown): value is PromptResource {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).name === "string" &&
    typeof (value as Record<string, unknown>).text === "string"
  );
}

/**
 * Recover resource blocks from already-persisted message text.
 *
 * New deliveries retain their typed resources separately; this reader is the
 * migration path for messages written before that identity existed. It accepts
 * only the exact lines {@link promptResourceBlock} emits and skips an
 * unterminated tail rather than manufacturing partial instructions.
 */
export function readPromptResourceBlocks(text: string): readonly PromptResource[] {
  const beginPrefix = "--- BEGIN RESOURCE: ";
  const lineSuffix = " ---";
  const resources: PromptResource[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const begin = text.indexOf(beginPrefix, cursor);
    if (begin === -1) break;
    if (begin > 0 && text[begin - 1] !== "\n") {
      cursor = begin + beginPrefix.length;
      continue;
    }
    const beginLineEnd = text.indexOf("\n", begin);
    if (beginLineEnd === -1) break;
    const beginLine = text.slice(begin, beginLineEnd);
    if (!beginLine.endsWith(lineSuffix)) {
      cursor = beginLineEnd + 1;
      continue;
    }
    const name = beginLine.slice(beginPrefix.length, -lineSuffix.length);
    if (name.length === 0) {
      cursor = beginLineEnd + 1;
      continue;
    }
    const endLine = `\n--- END RESOURCE: ${name} ---`;
    const end = text.indexOf(endLine, beginLineEnd);
    if (end === -1) break;
    resources.push({ name, text: text.slice(beginLineEnd + 1, end) });
    cursor = end + endLine.length;
  }

  return resources;
}

/**
 * The delivered form of a message that carries resources: the user's text
 * first and verbatim, then each resource as its own delimited block, each
 * boundary a blank line. This is the ONLY way a message-scoped resource may
 * join the text it rides with — after it, never inside it — so the user's
 * words stay recognizably theirs and the blocks stay recognizably supplied.
 */
export function appendPromptResources(text: string, resources: readonly PromptResource[]): string {
  if (resources.length === 0) return text;
  const blocks = resources.map(promptResourceBlock);
  return [...(text.length === 0 ? [] : [text]), ...blocks].join("\n\n");
}
