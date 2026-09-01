import { describe, expect, it } from "vite-plus/test";

import {
  COMPACT_VERB,
  COMPOSER_VERBS,
  COMPOSER_VERB_TABLE,
  COPY_VERB,
  LOGIN_VERB,
  MODEL_VERB,
  RELOAD_VERB,
  SETTINGS_VERB,
  findComposerVerb,
  isComposerVerbName,
  offeredComposerVerbs,
  type ComposerVerbMoment,
} from "./composer-verb";

describe("the verbs there are", () => {
  it("names every built-in, once each", () => {
    expect(COMPOSER_VERBS).toEqual([
      COMPACT_VERB,
      COPY_VERB,
      MODEL_VERB,
      RELOAD_VERB,
      SETTINGS_VERB,
      LOGIN_VERB,
    ]);
    for (const verb of COMPOSER_VERBS) {
      expect(isComposerVerbName(verb.name)).toBe(true);
    }
    expect(isComposerVerbName("review")).toBe(false);
  });

  it("keeps the Map keys, derived rows and row names in exact correspondence", () => {
    const keys = [...COMPOSER_VERB_TABLE.keys()];
    expect(keys).toEqual(COMPOSER_VERBS.map((verb) => verb.name));
    expect(new Set(keys).size).toBe(keys.length);
    for (const verb of COMPOSER_VERBS) {
      expect(COMPOSER_VERB_TABLE.get(verb.name)).toMatchObject({
        description: verb.description,
        takesInstructions: verb.takesInstructions,
      });
      expect(Object.isFrozen(verb)).toBe(true);
    }
    expect(Object.isFrozen(COMPOSER_VERBS)).toBe(true);
  });

  it("records which verbs read free text and which refuse it", () => {
    // `/compact` hands its words to a summarizer; every other verb runs a
    // fixed operation with nothing for trailing words to mean. The press
    // reads this flag rather than each handler deciding again.
    expect(COMPACT_VERB.takesInstructions).toBe(true);
    for (const entry of COMPOSER_VERBS.filter((verb) => verb.name !== "compact")) {
      expect(entry.takesInstructions).toBe(false);
    }
  });
});

/** Everything available: the moment each test below spoils one fact of. */
const READY: ComposerVerbMoment = {
  working: false,
  hasReply: true,
  hasModels: true,
  hasProject: true,
};

describe("what each verb refuses, and why", () => {
  // The refusal string is the row's absence said out loud: the picker hides
  // the verb, and a reader who types it anyway gets THIS sentence. So each
  // cause is pinned to its own words — a verb that refused for the right
  // reason in the wrong words would be a control lying about the app's state,
  // which is the whole failure this rule exists to prevent.
  it("lets every verb through when the moment is ready", () => {
    for (const verb of COMPOSER_VERBS) {
      expect(verb.refusal(READY)).toBeNull();
    }
  });

  it("refuses the two a live turn owns, each for its own reason", () => {
    const working = { ...READY, working: true };
    expect(COMPACT_VERB.refusal(working)).toBe("Compaction can't run while a turn is live");
    expect(MODEL_VERB.refusal(working)).toBe("The model can't change mid-turn");
    // Mid-turn the newest reply is still arriving, and half a sentence under
    // "Copied last reply" is a copy that looked right and pasted wrong.
    expect(COPY_VERB.refusal(working)).toBe("Wait for the reply to finish");
  });

  it("refuses /copy with nothing said yet", () => {
    expect(COPY_VERB.refusal({ ...READY, hasReply: false })).toBe("No reply to copy yet");
  });

  it("refuses /model on an empty catalog, and does not blame the turn", () => {
    // The reachable one: a Session with no model access is exactly where
    // someone types `/model`. Naming a mid-turn cause here would send them
    // looking for a turn that is not running.
    expect(MODEL_VERB.refusal({ ...READY, hasModels: false })).toBe(
      "No models to choose from — try /login",
    );
  });

  it("refuses /reload with no project to read", () => {
    expect(RELOAD_VERB.refusal({ ...READY, hasProject: false })).toBe(
      "No project to read commands from",
    );
  });

  it("keeps the two doors open in every moment there is", () => {
    // App chrome, and deliberately unconditional: the Session with nothing
    // configured is the one that needs `/login` most.
    for (const moment of [
      READY,
      { working: true, hasReply: false, hasModels: false, hasProject: false },
    ]) {
      expect(SETTINGS_VERB.refusal(moment)).toBeNull();
      expect(LOGIN_VERB.refusal(moment)).toBeNull();
    }
  });
});

describe("offeredComposerVerbs", () => {
  it("offers everything when nothing refuses", () => {
    expect(offeredComposerVerbs(READY)).toEqual(COMPOSER_VERBS);
  });

  it("offers exactly the verbs whose refusal is null", () => {
    // Not a second rule that agrees with `refusal` — the same one, asked of
    // every verb. This is what makes "what the picker offers" and "what a
    // press performs" incapable of disagreeing.
    const moment = { working: true, hasReply: true, hasModels: true, hasProject: true };
    expect(offeredComposerVerbs(moment)).toEqual(
      COMPOSER_VERBS.filter((verb) => verb.refusal(moment) === null),
    );
  });

  it("holds back the verbs a live turn would refuse", () => {
    expect(offeredComposerVerbs({ ...READY, working: true })).toEqual([
      RELOAD_VERB,
      SETTINGS_VERB,
      LOGIN_VERB,
    ]);
  });

  it("holds back a verb with nothing to act on", () => {
    expect(offeredComposerVerbs({ ...READY, hasReply: false })).toEqual([
      COMPACT_VERB,
      MODEL_VERB,
      RELOAD_VERB,
      SETTINGS_VERB,
      LOGIN_VERB,
    ]);
  });

  it("leaves a Session with no project and no catalog its two doors", () => {
    // The emptiest moment there is, and the list is still honest rather than
    // empty: what remains is exactly what still works.
    expect(
      offeredComposerVerbs({
        working: false,
        hasReply: false,
        hasModels: false,
        hasProject: false,
      }),
    ).toEqual([COMPACT_VERB, SETTINGS_VERB, LOGIN_VERB]);
  });
});

describe("findComposerVerb", () => {
  it("claims a draft that is the verb, with no instructions", () => {
    expect(findComposerVerb("/compact")).toEqual({ verb: COMPACT_VERB, instructions: null });
  });

  it("claims every verb the same way, words and all", () => {
    // The grammar is the registry's, not compact's: whichever verb a draft
    // names, the whole draft is the invocation and the words after the name
    // travel unparsed. Whether they MEAN anything is `takesInstructions`, and
    // that is the press's question, not this one's.
    expect(findComposerVerb("/copy")).toEqual({ verb: COPY_VERB, instructions: null });
    expect(findComposerVerb("/model")).toEqual({ verb: MODEL_VERB, instructions: null });
    expect(findComposerVerb("/reload now please")).toEqual({
      verb: RELOAD_VERB,
      instructions: "now please",
    });
    expect(findComposerVerb("/settings\n")).toEqual({ verb: SETTINGS_VERB, instructions: null });
    expect(findComposerVerb("/login")).toEqual({ verb: LOGIN_VERB, instructions: null });
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
