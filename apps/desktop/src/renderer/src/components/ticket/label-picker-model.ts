/**
 * What a label picker offers, hoisted out of the React layer so the one rule
 * that matters lives in tested, plain TypeScript: a name the project already
 * uses is OFFERED, never retyped.
 *
 * Every surface that edits labels used to be a bare text field, so `bug`,
 * `Bug` and `bgu` were three labels the moment anyone mistyped one — and the
 * board's Label facet then filtered by a vocabulary nobody meant to author.
 * The picker answers that by putting the project's own names in front of the
 * field, and by refusing to offer "create" for a name that only differs in
 * case ({@link newLabelFromQuery}).
 *
 * {@link labelVocabulary} is the vocabulary source, and it is deliberately a
 * union of two: the project's first-class `labels` rows (which carry stored
 * colors) AND the names in use on its tickets. The rows alone would go stale
 * within a session — `labelsByProject` is seeded once at boot and main mints a
 * row for an unknown name behind `ticket-set-labels`, so a label typed five
 * minutes ago would be missing from the picker for exactly as long as the app
 * stays open, which is the window duplicates are born in.
 */
import { distinctLabels, type Label, type Ticket } from "@volli/shared";

/** One pickable row: a name the project knows, and whether this ticket carries it. */
export interface LabelPickerOption {
  name: string;
  selected: boolean;
}

/**
 * Every label name a project knows — its label rows plus every name in use on
 * its tickets — unique and sorted ascending, the same order the board's Label
 * facet lists (`distinctLabels`).
 */
export function labelVocabulary(labels: readonly Label[], tickets: readonly Ticket[]): string[] {
  const names = new Set(labels.map((label) => label.name));
  for (const name of distinctLabels(tickets)) names.add(name);
  return [...names].toSorted();
}

/**
 * The picker's rows for `query`: the vocabulary UNIONED with what is already
 * selected, filtered by a case-insensitive substring (it filters, it does not
 * rank). The union is not belt-and-braces — the composer edits a ticket that
 * does not exist yet, so a name just created in that popover belongs to no
 * project row and no ticket, and would otherwise vanish from the list the
 * instant it was added.
 */
export function labelPickerOptions(
  vocabulary: readonly string[],
  selected: readonly string[],
  query: string,
): LabelPickerOption[] {
  const term = query.trim().toLowerCase();
  return [...new Set([...vocabulary, ...selected])]
    .toSorted()
    .filter((name) => name.toLowerCase().includes(term))
    .map((name) => ({ name, selected: selected.includes(name) }));
}

/**
 * The new label `query` would create, or `null` when it would create nothing:
 * an empty field, or a name the project already has. The match is
 * case-insensitive, so typing `Bug` where `bug` exists offers the existing
 * label to tick rather than a second spelling of it — this is the whole point
 * of the picker, and the one place it is decided.
 */
export function newLabelFromQuery(
  vocabulary: readonly string[],
  selected: readonly string[],
  query: string,
): string | null {
  const trimmed = query.trim();
  if (trimmed === "") return null;
  const taken = [...vocabulary, ...selected].some(
    (name) => name.toLowerCase() === trimmed.toLowerCase(),
  );
  return taken ? null : trimmed;
}

/**
 * `selected` with `name` toggled — removed when present, appended when not.
 * Appended rather than inserted in sorted order: a ticket's `labels` array is
 * the order its chips are drawn in, and re-sorting it on every tick would
 * shuffle the chips under the cursor.
 */
export function withLabelToggled(selected: readonly string[], name: string): string[] {
  return selected.includes(name)
    ? selected.filter((existing) => existing !== name)
    : [...selected, name];
}
