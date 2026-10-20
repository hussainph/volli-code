/**
 * The brand a command-intent conflict carries (HP § Commands; VC-564 A2).
 *
 * Lives here, in the package every ledger already depends on, so an intent
 * ledger (the Session engine's, an area's) brands its error without
 * depending on a protocol package, and every router recognizes the brand
 * rather than a ledger's own classes. A well-known symbol, so the brand
 * matches across module instances.
 */
export const COMMAND_INTENT_CONFLICT: unique symbol = Symbol.for("@volli/command-intent-conflict");

/**
 * A command id already recorded, sent again with a different intent: the one
 * conflict a client causes, which every router answers `CONFLICT` /
 * `command-conflict`. A ledger implements it on the error it throws for that
 * case, and only that case; every other conflict is a fact about the ledger
 * and keeps its own answer.
 */
export interface CommandIntentConflict {
  readonly [COMMAND_INTENT_CONFLICT]: true;
}

/** Whether a thrown value is a {@link CommandIntentConflict}. */
export function isCommandIntentConflict(value: unknown): value is CommandIntentConflict {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Partial<CommandIntentConflict>)[COMMAND_INTENT_CONFLICT] === true
  );
}
