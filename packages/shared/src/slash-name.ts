/**
 * The lexical grammar shared by every composer `/name` boundary.
 *
 * Keep the character decision here rather than repeating a regex in the
 * picker, command expansion and verb parser. A generated or declared name is
 * useful only if every one of those readers consumes the same whole string.
 */

/** One character that may appear after `/`. */
export type SlashNameCharacter =
  | "a"
  | "b"
  | "c"
  | "d"
  | "e"
  | "f"
  | "g"
  | "h"
  | "i"
  | "j"
  | "k"
  | "l"
  | "m"
  | "n"
  | "o"
  | "p"
  | "q"
  | "r"
  | "s"
  | "t"
  | "u"
  | "v"
  | "w"
  | "x"
  | "y"
  | "z"
  | Uppercase<
      | "a"
      | "b"
      | "c"
      | "d"
      | "e"
      | "f"
      | "g"
      | "h"
      | "i"
      | "j"
      | "k"
      | "l"
      | "m"
      | "n"
      | "o"
      | "p"
      | "q"
      | "r"
      | "s"
      | "t"
      | "u"
      | "v"
      | "w"
      | "x"
      | "y"
      | "z"
    >
  | "0"
  | "1"
  | "2"
  | "3"
  | "4"
  | "5"
  | "6"
  | "7"
  | "8"
  | "9"
  | "_"
  | ":"
  | "-";

/** Whether every character in a non-empty string belongs to the `/name` grammar. */
export type IsSlashInvocationName<Name extends string> = Name extends ""
  ? false
  : Name extends `${SlashNameCharacter}${infer Rest}`
    ? Rest extends ""
      ? true
      : IsSlashInvocationName<Rest>
    : false;

/** A literal preserved when it is spellable, otherwise `never`. */
export type CheckedSlashInvocationName<Name extends string> =
  IsSlashInvocationName<Name> extends true ? Name : never;

const SLASH_NAME = /^[A-Za-z0-9_:-]+$/;
const SLASH_NAME_CHARACTER = /^[A-Za-z0-9_:-]$/;

/** Runtime counterpart to {@link CheckedSlashInvocationName}. */
export function isSlashInvocationName(value: string): boolean {
  return SLASH_NAME.test(value);
}

/** Whether this one character continues a `/name` token. */
export function isSlashNameCharacter(value: string): boolean {
  return SLASH_NAME_CHARACTER.test(value);
}
