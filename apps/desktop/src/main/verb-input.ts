/**
 * Reading one verb call's arguments, for every host-side verb handler.
 *
 * These lived in `agent-tool-door.ts` until the MCP family (VC-380) became the
 * second handler module that needed them. The obvious move — export them from
 * the door — would have made the dependency circular for real, because the door
 * imports the handlers. So they live one level down, where both can reach them
 * and neither owns them.
 *
 * Everything here returns a REFUSAL rather than throwing. A model that supplied
 * the wrong argument needs a sentence naming the field it got wrong; an
 * exception would reach it as a tool failure with nothing to act on.
 */

/** One field read attempt: the value, or the words the model gets back. */
export type VerbInputRead<T> = { ok: true; value: T } | { ok: false; text: string };

/**
 * One required string field, trimmed, or a refusal naming the field.
 *
 * Separate from {@link optionalVerbText} rather than a flag on it: a required
 * field that is absent and one that is blank are the same mistake to the model,
 * and both have to be told in a sentence rather than by a schema error.
 */
export function requiredVerbText(
  input: Readonly<Record<string, unknown>>,
  field: string,
  hint: string,
): VerbInputRead<string> {
  const raw = input[field];
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { ok: false, text: `\`${field}\` is required: ${hint}` };
  }
  return { ok: true, value: raw.trim() };
}

/**
 * One optional string field, or a refusal when it was given as something else.
 *
 * A field nobody supplied is `undefined` and fine. A field supplied as a number,
 * or as a string of spaces, is a mistake worth naming — silently treating it as
 * absent would carry out a different call from the one that was asked for.
 */
export function optionalVerbText(
  input: Readonly<Record<string, unknown>>,
  field: string,
): VerbInputRead<string | undefined> {
  const raw = input[field];
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { ok: false, text: `\`${field}\` must be a non-empty string when given.` };
  }
  return { ok: true, value: raw };
}
