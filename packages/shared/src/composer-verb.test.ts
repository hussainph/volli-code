import { describe, expect, it } from "vite-plus/test";

import {
  COMPACT_VERB,
  COMPOSER_VERBS,
  findComposerVerb,
  isComposerVerbName,
  visiblePromptTemplates,
} from "./composer-verb";
import type { PromptTemplate } from "./prompt-template";

function template(overrides: Partial<PromptTemplate> = {}): PromptTemplate {
  return { name: "review", description: "Review a file", content: "Review $1.", ...overrides };
}

describe("the verbs there are", () => {
  it("names compaction and nothing else", () => {
    expect(COMPOSER_VERBS).toEqual([COMPACT_VERB]);
    expect(isComposerVerbName("compact")).toBe(true);
    expect(isComposerVerbName("review")).toBe(false);
  });
});

describe("findComposerVerb", () => {
  it("claims a draft that is the verb, with no instructions", () => {
    expect(findComposerVerb("/compact")).toEqual({ verb: COMPACT_VERB, instructions: null });
  });

  it("ignores the whitespace a pick leaves behind", () => {
    // The picker stages `/compact ` with a trailing space and the caret after
    // it, so this is the exact string a press most often sees.
    expect(findComposerVerb("/compact ")).toEqual({ verb: COMPACT_VERB, instructions: null });
    expect(findComposerVerb("\n  /compact\n")).toEqual({ verb: COMPACT_VERB, instructions: null });
  });

  it("hands everything after the name to the summarizer, unparsed", () => {
    expect(findComposerVerb("/compact keep the marker work")).toEqual({
      verb: COMPACT_VERB,
      instructions: "keep the marker work",
    });
    // Quotes are Pi's template-argument grammar and mean nothing here: these
    // words go to a model, not into a `$1`.
    expect(findComposerVerb(`/compact "keep this" and that`)).toEqual({
      verb: COMPACT_VERB,
      instructions: `"keep this" and that`,
    });
  });

  it("reads instructions to the end of the text, not the end of the line", () => {
    // A summarizer reads paragraphs. A template invocation stops at its line
    // because the rest of the draft is still a message; a verb has no message
    // left over, so there is nothing for a second line to be.
    expect(findComposerVerb("/compact keep the API work\nand the migration notes")).toEqual({
      verb: COMPACT_VERB,
      instructions: "keep the API work\nand the migration notes",
    });
  });

  it("refuses a verb that does not own the whole draft", () => {
    // Prose that mentions the verb is prose. Claiming it would silently drop
    // every word around the one that was recognised.
    expect(findComposerVerb("please /compact and carry on")).toBeNull();
    expect(findComposerVerb("see src/compact.ts")).toBeNull();
  });

  it("refuses a name that only starts with a verb's", () => {
    expect(findComposerVerb("/compacted")).toBeNull();
    expect(findComposerVerb("/compact-all")).toBeNull();
  });

  it("refuses a name that does not end at a boundary", () => {
    // `findCommandInvocations`' rule, for its reason: a name run into a
    // character it cannot contain never was that name. Punctuation after the
    // verb is a sentence about it.
    expect(findComposerVerb("/compact.")).toBeNull();
    expect(findComposerVerb("/compact?")).toBeNull();
  });

  it("refuses everything that is not a verb", () => {
    expect(findComposerVerb("/review src/a.ts")).toBeNull();
    expect(findComposerVerb("/")).toBeNull();
    expect(findComposerVerb("")).toBeNull();
  });
});

describe("visiblePromptTemplates", () => {
  it("drops a template whose name a verb has taken", () => {
    const own = template({ name: "compact", description: "my own compaction prompt" });
    const other = template();

    // The verb wins the name outright — see the module header. The cost is
    // visible (the picker shows the verb where this row was) where the reverse
    // would be silent (a `/compact` that sends a prompt instead of compacting).
    expect(visiblePromptTemplates([own, other])).toEqual([other]);
  });

  it("leaves an ordinary list alone", () => {
    const templates = [template(), template({ name: "plan" })];
    expect(visiblePromptTemplates(templates)).toEqual(templates);
  });
});
