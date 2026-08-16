/**
 * The one spelling of a delivered prompt resource.
 *
 * A {@link PromptResource} reaches a model down two different pipes — appended
 * to the system prompt at attach time (`@volli/agent-runtime`'s
 * `composeSystemPrompt`), or spliced into a message when a `/skill` reference
 * expands in the composer — and the delimiters have to read identically in
 * both, because the model is told to treat a RESOURCE section as supplied
 * material wherever it appears. Two spellings would be two vocabularies, and
 * the message-side one would drift the day the prompt-side one changed. So the
 * format lives here, in the package both pipes already depend on, and each
 * caller renders through this function rather than owning a copy.
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
