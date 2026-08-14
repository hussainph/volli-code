/**
 * The drift guard for `@volli/shared`'s prompt-template grammar.
 *
 * `packages/shared/src/prompt-template.ts` is a verbatim port of Pi's
 * `parseCommandArgs` / `substituteArgs` / `formatPromptTemplateInvocation`,
 * because the renderer — which is where `/command` expansion happens — cannot
 * import them: the package's `exports` map does not publish the deep path, and
 * the root barrel reaches `node:` builtins through `@earendil-works/pi-ai`.
 * That header explains the why; this file is the enforcement.
 *
 * This package CAN import Pi (it is the Agent Runtime's own dependency), so the
 * two implementations are run side by side over a corpus that covers every
 * placeholder form and every quoting edge. A Pi upgrade that changes the
 * grammar fails here rather than silently sending a differently-expanded prompt
 * months later.
 */
import {
  formatPromptTemplateInvocation as piFormatPromptTemplateInvocation,
  parseCommandArgs as piParseCommandArgs,
  substituteArgs as piSubstituteArgs,
} from "@earendil-works/pi-agent-core";
import { formatPromptTemplateInvocation, parseCommandArgs, substituteArgs } from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";

const ARGUMENT_STRINGS = [
  "",
  "   ",
  "one",
  "one two three",
  "one  two\tthree",
  `"two words"`,
  `'single quoted'`,
  `"it's here"`,
  `'say "hi"'`,
  `"never closed`,
  `src/app.ts "the tricky one" --flag`,
  `a""b`,
  `pre"mid"post`,
  "\ttabbed\t",
  "emoji 🎉 stays",
];

const CONTENTS = [
  "no placeholders at all",
  "Review $1.",
  "$1 and $2 and $3",
  "$ARGUMENTS",
  "$@",
  "${@:1}",
  "${@:2}",
  "${@:0}",
  "${@:2:1}",
  "${@:2:5}",
  "${@:10}",
  "Mixed $1 then ${@:2} then $ARGUMENTS",
  "Costs $5 and change",
  "A bare $ alone",
  "$10",
  "line one\n\n$@\nline three",
];

const ARG_LISTS = [[], ["a"], ["a", "b"], ["a", "b", "c", "d"], ["with space", "b"]];

describe("prompt-template grammar parity with pi-agent-core", () => {
  it.each(ARGUMENT_STRINGS)("parseCommandArgs agrees on %j", (argsString) => {
    expect(parseCommandArgs(argsString)).toEqual(piParseCommandArgs(argsString));
  });

  it("substituteArgs agrees on every content/argument pairing", () => {
    for (const content of CONTENTS) {
      for (const args of ARG_LISTS) {
        expect(substituteArgs(content, args)).toBe(piSubstituteArgs(content, [...args]));
      }
    }
  });

  it("formatPromptTemplateInvocation agrees, defaulted arguments included", () => {
    for (const content of CONTENTS) {
      const template = { name: "t", description: "", content };
      expect(formatPromptTemplateInvocation(template)).toBe(
        piFormatPromptTemplateInvocation(template),
      );
      expect(formatPromptTemplateInvocation(template, ["a", "b"])).toBe(
        piFormatPromptTemplateInvocation(template, ["a", "b"]),
      );
    }
  });

  it("agrees end to end: parse the argument string, then substitute it", () => {
    for (const content of CONTENTS) {
      for (const argsString of ARGUMENT_STRINGS) {
        expect(substituteArgs(content, parseCommandArgs(argsString))).toBe(
          piSubstituteArgs(content, piParseCommandArgs(argsString)),
        );
      }
    }
  });
});
