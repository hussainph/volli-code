import {
  SESSION_ESCALATION_OPTIONS,
  SESSION_ESCALATION_STOP_ID,
  type SessionInteraction,
  type SessionInteractionOption,
  type SessionInteractionPrompt,
} from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";

import {
  askFieldOpen,
  canSubmitInteraction,
  indexOpenedInteractions,
  readInteractionResolutionMessage,
  describeInteractionResolution,
  emptyInteractionDraft,
  firstUnansweredPrompt,
  footInteraction,
  interactionAdvance,
  interactionAnswers,
  interactionCarousel,
  interactionForApproval,
  interactionQuestions,
  interactionRedirected,
  interactionResolution,
  interactionStep,
  interactionSubmitLabel,
  isAskUserInteraction,
  isPromptAnswered,
  needsOwnRefusal,
  optionPolarity,
  optionSubmitsOnSelect,
  promptDraft,
  promptFieldOpen,
  promptFieldRole,
  promptRequirement,
  promptResponseSuperseded,
  promptRowLayout,
  promptTextCarrier,
  redirectMessage,
  refusalResolution,
  refusalSubmission,
  interactionSubmission,
  selectOption,
  setPromptResponse,
} from "./interaction";

const PERMISSION_OPTIONS = [
  { id: "once", label: "Allow once", description: null },
  { id: "always", label: "Allow always", description: null },
  { id: "reject", label: "Reject", description: null },
];

function permission(overrides: Partial<SessionInteraction> = {}): SessionInteraction {
  return {
    id: "permission:p1",
    attachmentId: "attach-1",
    kind: "permission",
    title: "rm -rf node_modules",
    detail: "bash",
    options: PERMISSION_OPTIONS,
    multiple: false,
    prompts: [
      {
        id: "prompt:0",
        label: "rm -rf node_modules",
        detail: "bash",
        options: PERMISSION_OPTIONS,
        multiple: false,
        custom: false,
      },
    ],
    native: { id: "perm-1", detail: null },
    ...overrides,
  };
}

function prompt(overrides: Partial<SessionInteractionPrompt> = {}): SessionInteractionPrompt {
  return {
    id: "prompt:0",
    label: "Which branch?",
    detail: null,
    options: [
      { id: "question:0:bWFpbg", label: "main", description: null },
      { id: "question:0:ZGV2", label: "dev", description: null },
    ],
    multiple: false,
    custom: false,
    ...overrides,
  };
}

function question(prompts: readonly SessionInteractionPrompt[]): SessionInteraction {
  return {
    id: "question:q1",
    attachmentId: "attach-1",
    kind: "question",
    title: "Before I continue",
    detail: null,
    options: prompts.flatMap((entry) => entry.options),
    multiple: true,
    prompts,
    native: { id: "q-1", detail: null },
  };
}

/**
 * The escalation's two options, read off the offer rather than restated.
 *
 * `stop` is found by its own exported id and the continuation is simply the
 * other one, so a rename in `@volli/shared` travels here instead of leaving a
 * fixture that keeps passing against a pair nothing offers any more.
 */
function escalationOptions(): {
  keepWorking: SessionInteractionOption;
  stopTurn: SessionInteractionOption;
} {
  const stopTurn = SESSION_ESCALATION_OPTIONS.find(
    (option) => option.id === SESSION_ESCALATION_STOP_ID,
  );
  const keepWorking = SESSION_ESCALATION_OPTIONS.find(
    (option) => option.id !== SESSION_ESCALATION_STOP_ID,
  );
  if (!stopTurn || !keepWorking) throw new Error("the escalation offer is not a pair");
  return { keepWorking, stopTurn };
}

/**
 * What the sandbox raises when the block stands whatever the answer: one
 * question, the offer's own two options, no free-text answer to give.
 */
function escalation(overrides: Partial<SessionInteraction> = {}): SessionInteraction {
  return {
    id: "question:e1",
    attachmentId: "attach-1",
    kind: "question",
    title: "Write outside the worktree",
    detail: "write",
    options: SESSION_ESCALATION_OPTIONS,
    multiple: false,
    prompts: [
      {
        id: "prompt:0",
        label: "Write outside the worktree",
        detail: "write",
        options: SESSION_ESCALATION_OPTIONS,
        multiple: false,
        custom: false,
      },
    ],
    native: { id: "esc-1", detail: null },
    ...overrides,
  };
}

describe("optionPolarity", () => {
  it("reads a standing grant apart from a one-time yes", () => {
    expect(optionPolarity({ id: "once" })).toBe("allow");
    expect(optionPolarity({ id: "always" })).toBe("standing");
    expect(optionPolarity({ id: "reject" })).toBe("reject");
  });

  it("reads an escalation's pair as the two sides of its card", () => {
    // Not a permission — the call is refused either way — but the card still
    // has a permitting side and a refusing one, and every layout rule below
    // asks only that narrower question. Read as ordinary answers, both fell
    // through to `answer` and the card came apart: the box stood open, a
    // second refusal appeared beside the two real options, and the button
    // spoke for neither of them.
    const { keepWorking, stopTurn } = escalationOptions();
    expect(optionPolarity(keepWorking)).toBe("allow");
    expect(optionPolarity(stopTurn)).toBe("reject");
  });

  it("matches declared ids case-insensitively", () => {
    expect(optionPolarity({ id: "Once" })).toBe("allow");
    expect(optionPolarity({ id: "REJECT" })).toBe("reject");
    expect(optionPolarity({ id: "Continue" })).toBe("allow");
    expect(optionPolarity({ id: "STOP" })).toBe("reject");
  });

  it("treats an id it does not recognize as an ordinary answer", () => {
    // Never as consent, and never as a refusal: the polarity vocabulary is
    // matched against declared ids, so an unknown one states nothing at all.
    expect(optionPolarity({ id: "question:0:bWFpbg" })).toBe("answer");
  });
});

describe("draft", () => {
  it("preselects nothing", () => {
    // A default choice on a blocking permission means one stray Enter grants it.
    const interaction = permission();
    expect(promptDraft(emptyInteractionDraft(interaction), "prompt:0")).toEqual({
      optionIds: [],
      response: "",
    });
    expect(canSubmitInteraction(interaction, emptyInteractionDraft(interaction))).toBe(false);
  });

  it("reads a prompt nothing was written for as empty rather than missing", () => {
    expect(promptDraft({}, "prompt:7")).toEqual({ optionIds: [], response: "" });
  });

  it("replaces the choice on a single-answer prompt", () => {
    const single = prompt();
    let draft = selectOption({}, single, "question:0:bWFpbg");
    draft = selectOption(draft, single, "question:0:ZGV2");
    expect(promptDraft(draft, "prompt:0").optionIds).toEqual(["question:0:ZGV2"]);
  });

  it("never un-chooses a radio", () => {
    // Clicking the selected option again must not leave the card unanswerable.
    const single = prompt();
    let draft = selectOption({}, single, "question:0:bWFpbg");
    draft = selectOption(draft, single, "question:0:bWFpbg");
    expect(promptDraft(draft, "prompt:0").optionIds).toEqual(["question:0:bWFpbg"]);
  });

  it("accumulates and drops options on a multiple prompt", () => {
    const many = prompt({ multiple: true });
    let draft = selectOption({}, many, "question:0:bWFpbg");
    draft = selectOption(draft, many, "question:0:ZGV2");
    expect(promptDraft(draft, "prompt:0").optionIds).toEqual([
      "question:0:bWFpbg",
      "question:0:ZGV2",
    ]);
    draft = selectOption(draft, many, "question:0:bWFpbg");
    expect(promptDraft(draft, "prompt:0").optionIds).toEqual(["question:0:ZGV2"]);
  });

  it("keeps the text a prompt already carries when its choice changes", () => {
    const single = prompt();
    let draft = setPromptResponse({}, "prompt:0", "use the release branch");
    draft = selectOption(draft, single, "question:0:ZGV2");
    expect(promptDraft(draft, "prompt:0").response).toBe("use the release branch");
  });
});

describe("the field's role", () => {
  it("is a note beside a declared verdict", () => {
    const [permissionPrompt] = permission().prompts ?? [];
    if (!permissionPrompt) throw new Error("fixture has no prompt");
    expect(promptFieldRole(permissionPrompt, selectOption({}, permissionPrompt, "once"))).toBe(
      "note",
    );
    expect(promptFieldRole(permissionPrompt, {})).toBe("note");
  });

  it("becomes the redirection beside a refusal", () => {
    const [permissionPrompt] = permission().prompts ?? [];
    if (!permissionPrompt) throw new Error("fixture has no prompt");
    expect(promptFieldRole(permissionPrompt, selectOption({}, permissionPrompt, "reject"))).toBe(
      "redirection",
    );
  });

  it("is the answer itself where the harness accepts one", () => {
    const custom = prompt({ custom: true });
    expect(promptFieldRole(custom, {})).toBe("answer");
    expect(promptFieldRole(custom, selectOption({}, custom, "question:0:bWFpbg"))).toBe("answer");
  });

  it("is the redirection wherever nothing on the wire takes the words", () => {
    // The whole point of offering it unconditionally: a question declaring
    // neither `custom` nor a refusal had no way to redirect at all, so the only
    // move left was picking something already decided to be wrong.
    const plain = prompt({ custom: false });
    expect(promptFieldRole(plain, {})).toBe("redirection");
    expect(promptFieldRole(plain, selectOption({}, plain, "question:0:bWFpbg"))).toBe(
      "redirection",
    );
  });

  it("stands the box open wherever the words are a way of answering", () => {
    // `custom` makes them the answer; a question nothing else can carry them
    // for has no other escape.
    expect(promptFieldOpen(prompt({ custom: true }), {})).toBe(true);
    expect(promptFieldOpen(prompt({ custom: false }), {})).toBe(true);
  });

  it("keeps it behind a control on a permission until the refusal is chosen", () => {
    // Three declared verdicts are the whole of the ordinary case, so an open
    // box is the tallest thing on the card in the one interaction nobody types
    // into. Refusing is the answer whose words matter.
    const [permissionPrompt] = permission().prompts ?? [];
    if (!permissionPrompt) throw new Error("fixture has no prompt");
    expect(promptFieldOpen(permissionPrompt, {})).toBe(false);
    expect(promptFieldOpen(permissionPrompt, selectOption({}, permissionPrompt, "once"))).toBe(
      false,
    );
    expect(promptFieldOpen(permissionPrompt, selectOption({}, permissionPrompt, "reject"))).toBe(
      true,
    );
  });
});

describe("what the primary control says", () => {
  it("names the act it is waiting for while there is nothing to send", () => {
    // A single question has no counter to say what is left, so a control
    // reading the same word before and after its gate said nothing at all.
    const interaction = permission();
    expect(interactionSubmitLabel(interaction, emptyInteractionDraft(interaction))).toBe("Choose");
    const many = question([prompt({ id: "prompt:0" }), prompt({ id: "prompt:1" })]);
    expect(interactionSubmitLabel(many, emptyInteractionDraft(many))).toBe("Submit");
  });

  it("names the verdict once one is chosen", () => {
    const interaction = permission();
    const [only] = interactionQuestions(interaction);
    if (!only) throw new Error("no prompt projected");
    expect(interactionSubmitLabel(interaction, selectOption({}, only.prompt, "always"))).toBe(
      "Allow always",
    );
    expect(interactionSubmitLabel(interaction, selectOption({}, only.prompt, "reject"))).toBe(
      "Reject",
    );
  });

  it("keeps the neutral word where the label is an answer rather than a verdict", () => {
    // A question's option ids are the harness's own encoded values, so its
    // labels state no verdict the button could speak for.
    const asked = question([prompt()]);
    expect(interactionSubmitLabel(asked, selectOption({}, prompt(), "question:0:bWFpbg"))).toBe(
      "Submit",
    );
  });

  it("says send where the words refuse the ask and travel after it", () => {
    const asked = question([prompt()]);
    expect(
      interactionSubmitLabel(asked, setPromptResponse({}, "prompt:0", "neither — rebase first")),
    ).toBe("Send");
  });

  it("waits to be answered rather than chosen when the only question has no options", () => {
    const freeform = question([prompt({ custom: true, options: [] })]);
    expect(interactionSubmitLabel(freeform, {})).toBe("Answer");
  });

  it("keeps the neutral word for a multi-question submission with nothing else to name", () => {
    const first = prompt({ id: "prompt:0" });
    const second = prompt({ id: "prompt:1" });
    const interaction = question([first, second]);
    const draft = selectOption(
      selectOption({}, first, "question:0:bWFpbg"),
      second,
      "question:0:bWFpbg",
    );
    expect(interactionSubmitLabel(interaction, draft)).toBe("Submit");
  });

  it("keeps the neutral word once more than one option is chosen on a multi-select prompt", () => {
    // `chosen` names a single declared verdict; two picks are an answer, not one.
    const multi = prompt({ multiple: true });
    const interaction = question([multi]);
    const draft = selectOption(
      selectOption({}, multi, "question:0:bWFpbg"),
      multi,
      "question:0:ZGV2",
    );
    expect(interactionSubmitLabel(interaction, draft)).toBe("Submit");
  });
});

describe("none of these work", () => {
  it("reads a declared refusal before custom, so a permission keeps its note", () => {
    // A prompt carrying both is still a permission, and
    // `POST /permission/{id}/reply` has no free-text answer slot — it takes a
    // verdict and a `message`. Read as `answer`, the words were promised a place
    // in an answer array the endpoint never sends.
    const [permissionPrompt] = permission().prompts ?? [];
    if (!permissionPrompt) throw new Error("fixture has no prompt");
    const both = { ...permissionPrompt, custom: true };
    expect(promptTextCarrier(both)).toBe("note");
    expect(promptFieldRole(both, {})).toBe("note");
    expect(promptFieldRole(both, selectOption({}, both, "reject"))).toBe("redirection");
    // And the box still waits behind its own control until the refusal that
    // makes the words matter is chosen.
    expect(promptFieldOpen(both, {})).toBe(false);
  });

  it("carries the words the way the harness accepts them, and no other way", () => {
    const [permissionPrompt] = permission().prompts ?? [];
    if (!permissionPrompt) throw new Error("fixture has no prompt");
    // `custom` is the only shape whose free text is a real answer on the wire.
    expect(promptTextCarrier(prompt({ custom: true }))).toBe("answer");
    // A permission's reply carries a `message` beside the verdict.
    expect(promptTextCarrier(permissionPrompt)).toBe("note");
    // Everything else: `answers` is selected labels only, so words there would
    // claim a choice OpenCode never offered.
    expect(promptTextCarrier(prompt({ custom: false }))).toBe("message");
  });

  it("refuses and redirects where nothing else can carry the words", () => {
    const plain = prompt();
    const interaction = question([plain]);
    // The selection the words contradict goes with the refusal rather than
    // beside it — the refusal is still exactly the empty resolution.
    const draft = setPromptResponse(
      selectOption({}, plain, "question:0:bWFpbg"),
      "prompt:0",
      "  read the lockfile first  ",
    );
    expect(interactionSubmission(interaction, draft)).toEqual({
      resolution: {
        optionIds: [],
        response: null,
        answers: [{ promptId: "prompt:0", optionIds: [], response: null }],
      },
      message: "read the lockfile first",
    });
    expect(interactionRedirected(interaction, draft)).toBe(true);
  });

  it("keeps a native answer on the resolution, with nothing to send after it", () => {
    const custom = prompt({ custom: true });
    const interaction = question([custom]);
    const draft = setPromptResponse({}, "prompt:0", "the release branch");
    expect(redirectMessage(interaction, draft)).toBeNull();
    expect(interactionSubmission(interaction, draft)).toEqual({
      resolution: {
        optionIds: [],
        response: "the release branch",
        answers: [{ promptId: "prompt:0", optionIds: [], response: "the release branch" }],
      },
      message: null,
    });
  });

  it("rides a permission's own reply rather than a following message", () => {
    const interaction = permission();
    const [only] = interaction.prompts ?? [];
    if (!only) throw new Error("fixture has no prompt");
    const draft = setPromptResponse(
      selectOption({}, only, "reject"),
      "prompt:0",
      "read it instead",
    );
    expect(interactionSubmission(interaction, draft)).toEqual({
      resolution: {
        optionIds: ["reject"],
        response: "read it instead",
        answers: [{ promptId: "prompt:0", optionIds: ["reject"], response: "read it instead" }],
      },
      message: null,
    });
  });

  it("gathers a redirection typed on any question of a multi-question request", () => {
    const first = prompt({ id: "prompt:0" });
    const second = prompt({ id: "prompt:1", custom: true });
    const interaction = question([first, second]);
    let draft = setPromptResponse({}, "prompt:0", "neither, look at the CI log");
    draft = setPromptResponse(draft, "prompt:1", "and update the docs");
    // Only the question whose words no reply can carry becomes the message; the
    // one declaring `custom` keeps its own answer, and is dropped by the refusal
    // like every other selection.
    expect(redirectMessage(interaction, draft)).toBe("neither, look at the CI log");
    // Dropped, and shown as dropped: the box it was typed into is not what the
    // redirection is made of.
    expect(promptResponseSuperseded(interaction, second, draft)).toBe(true);
    expect(promptResponseSuperseded(interaction, first, draft)).toBe(false);
  });

  it("supersedes every question on the card, not only the one typed into", () => {
    // The refusal is one empty resolution for the whole request — OpenCode takes
    // one `answers` array per request, so there is no partial one to send.
    // Asked per prompt, this dimmed the question in view alone, so answers to
    // the other two stood ticked and live while submit threw them away.
    const first = prompt({ id: "prompt:0" });
    const second = prompt({ id: "prompt:1" });
    const third = prompt({ id: "prompt:2" });
    const interaction = question([first, second, third]);
    let draft = selectOption(emptyInteractionDraft(interaction), first, "question:0:bWFpbg");
    draft = selectOption(draft, third, "question:0:ZGV2");
    expect(interactionRedirected(interaction, draft)).toBe(false);

    draft = setPromptResponse(draft, "prompt:1", "neither — check the CI log");
    for (const asked of [first, second, third]) {
      expect(interactionRedirected(interaction, draft)).toBe(true);
      // The box the words are in stays live wherever nothing else can carry
      // them; clearing it is how a reader takes the card back.
      expect(promptResponseSuperseded(interaction, asked, draft)).toBe(false);
    }
    expect(interactionSubmission(interaction, draft)).toEqual({
      resolution: refusalResolution(interaction),
      message: "neither — check the CI log",
    });
  });

  it("says nothing when there is nothing to send", () => {
    const interaction = question([prompt()]);
    expect(interactionSubmission(interaction, {})).toBeNull();
    expect(redirectMessage(interaction, setPromptResponse({}, "prompt:0", "   "))).toBeNull();
  });

  it("lets an explicit refusal carry the same words", () => {
    const interaction = question([prompt()]);
    const draft = setPromptResponse({}, "prompt:0", "ask me again after the tests");
    expect(refusalSubmission(interaction, draft)).toEqual({
      resolution: refusalResolution(interaction),
      message: "ask me again after the tests",
    });
    expect(refusalSubmission(interaction, {}).message).toBeNull();
  });
});

describe("refusal", () => {
  it("stays a declared option on a permission", () => {
    // `reject` is an id we mint, so selecting it is unambiguous and it belongs
    // in the list with the other two.
    expect(needsOwnRefusal(permission())).toBe(false);
  });

  it("becomes the card's own control on a question", () => {
    // A question's option ids are the harness's encoded values, so none of them
    // can mean "no" — including one whose label is literally "reject".
    const rejectish = prompt({
      options: [{ id: "question:0:cmVqZWN0", label: "reject", description: null }],
    });
    expect(needsOwnRefusal(question([rejectish]))).toBe(true);
  });

  it("selects nothing and says nothing, whatever was typed first", () => {
    // What no harness value can impersonate. A selection the reader made and
    // then abandoned must not travel alongside the refusal.
    const interaction = question([prompt({ custom: true })]);
    expect(refusalResolution(interaction)).toEqual({
      optionIds: [],
      response: null,
      answers: [{ promptId: "prompt:0", optionIds: [], response: null }],
    });
  });

  it("reads back as a refusal rather than an empty answer", () => {
    const interaction = question([prompt()]);
    expect(
      describeInteractionResolution(interaction, refusalResolution(interaction)),
    ).toMatchObject({ verdict: "rejected", lead: "You rejected", trailer: null });
  });
});

describe("an escalation the sandbox raised", () => {
  // The block stands whatever is answered, so the pair is "keep working" and
  // "stop the turn" rather than a verdict on the call. Every rule here reads
  // that pair through `optionPolarity`, which is why recognizing the two ids is
  // not cosmetic: unrecognized, this card discarded the click it was given.

  it("keeps its words beside the verdict rather than in a following message", () => {
    const [only] = escalation().prompts ?? [];
    if (!only) throw new Error("fixture has no prompt");
    // `note`, because a declared refusal makes this the shape whose reply
    // carries a message beside the decision. As `message` the words were the
    // whole submission and the decision went with the refusal.
    expect(promptTextCarrier(only)).toBe("note");
  });

  it("keeps the box behind a control until the turn is being stopped", () => {
    const [only] = escalation().prompts ?? [];
    if (!only) throw new Error("fixture has no prompt");
    const { keepWorking, stopTurn } = escalationOptions();
    expect(promptFieldOpen(only, {})).toBe(false);
    expect(promptFieldOpen(only, selectOption({}, only, keepWorking.id))).toBe(false);
    expect(promptFieldOpen(only, selectOption({}, only, stopTurn.id))).toBe(true);
  });

  it("declares the refusal it needs, so the card mints none of its own", () => {
    // Two real options plus a third the card invented is three exits from a
    // question that has two.
    expect(needsOwnRefusal(escalation())).toBe(false);
  });

  it("names whichever side was chosen on the button", () => {
    const interaction = escalation();
    const [only] = interaction.prompts ?? [];
    if (!only) throw new Error("fixture has no prompt");
    const { keepWorking, stopTurn } = escalationOptions();
    expect(interactionSubmitLabel(interaction, selectOption({}, only, keepWorking.id))).toBe(
      "Keep working",
    );
    expect(interactionSubmitLabel(interaction, selectOption({}, only, stopTurn.id))).toBe(
      "Stop the turn",
    );
  });

  it("sends either side of the offer on the click that chose it", () => {
    // One question, one choice, nothing typed: the click is the whole decision,
    // on the refusing side as much as the permitting one. What guards the two
    // is their ink and the box that stands open beside them, never a second
    // press asked for one of them and not the other.
    const interaction = escalation();
    const [only] = interaction.prompts ?? [];
    if (!only) throw new Error("fixture has no prompt");
    const { keepWorking, stopTurn } = escalationOptions();
    const draft = emptyInteractionDraft(interaction);
    expect(optionSubmitsOnSelect(interaction, only, keepWorking, draft)).toBe(true);
    expect(optionSubmitsOnSelect(interaction, only, stopTurn, draft)).toBe(true);
  });

  it("submits the choice the reader made, not an empty refusal beside their words", () => {
    // The regression this whole block guards. With both ids reading as
    // `answer`, the box stood open, its text became a redirection, and a
    // redirection outranks selections — so clicking "Keep working" and typing
    // anything at all sent the empty resolution and threw the click away.
    const interaction = escalation();
    const [only] = interaction.prompts ?? [];
    if (!only) throw new Error("fixture has no prompt");
    const { keepWorking } = escalationOptions();
    const draft = setPromptResponse(
      selectOption(emptyInteractionDraft(interaction), only, keepWorking.id),
      "prompt:0",
      "  leave that file alone and carry on  ",
    );
    expect(interactionSubmission(interaction, draft)).toEqual({
      resolution: {
        optionIds: [keepWorking.id],
        response: "leave that file alone and carry on",
        answers: [
          {
            promptId: "prompt:0",
            optionIds: [keepWorking.id],
            response: "leave that file alone and carry on",
          },
        ],
      },
      message: null,
    });
    expect(interactionRedirected(interaction, draft)).toBe(false);
    expect(interactionSubmission(interaction, draft)?.resolution).not.toEqual(
      refusalResolution(interaction),
    );
  });
});

describe("an interaction that declares no questions", () => {
  // Reachable, not theoretical: the adapter falls back to reading the questions
  // off the event, which yields none when its map missed after a binding restart
  // and the payload carried no `questions` array. `prompts: []` is stored
  // verbatim — absent and empty are deliberately distinct — so every predicate
  // here meets the empty list on a record read back from SQLite.

  it("has nothing to submit rather than everything answered", () => {
    // `every` says yes to the empty list, so the button went live on a card with
    // no questions on it and sent the empty resolution — which is the shape a
    // refusal is defined by, said by nobody.
    const nothing = question([]);
    expect(canSubmitInteraction(nothing, {})).toBe(false);
    expect(canSubmitInteraction(nothing, setPromptResponse({}, "prompt:0", "main"))).toBe(false);
    expect(interactionSubmission(nothing, {})).toBeNull();
  });

  it("keeps the refusal that is its only exit", () => {
    // Nothing declared a refusal, so the card mints one — and on a card that can
    // submit nothing, that control is the whole way out.
    expect(needsOwnRefusal(question([]))).toBe(true);
    expect(refusalResolution(question([]))).toEqual({
      optionIds: [],
      response: null,
      answers: [],
    });
  });

  it("reads a decision it cannot itemize as answered, never as refused", () => {
    // The bug this whole block exists for: `answers.every` is vacuously true on
    // the empty array, so a permission the reader allowed printed "You rejected".
    const opaque = permission({ prompts: [] });
    expect(
      describeInteractionResolution(opaque, { optionIds: ["once"], response: null, answers: [] }),
    ).toEqual({
      verdict: "allowed",
      lead: "You allowed",
      subject: "rm -rf node_modules",
      trailer: "once",
    });
    // Words with no selection are still an answer, whatever we can name of it.
    expect(
      describeInteractionResolution(question([]), {
        optionIds: [],
        response: "the release branch",
        answers: [],
      }),
    ).toMatchObject({ verdict: "answered", lead: "You answered", trailer: null });
  });

  it("still reads a refusal of one as a refusal", () => {
    // Nothing selected and nothing said anywhere — the reading no harness value
    // can impersonate, and the only decision such a card can send.
    const nothing = question([]);
    expect(describeInteractionResolution(nothing, refusalResolution(nothing))).toMatchObject({
      verdict: "rejected",
      lead: "You rejected",
      trailer: null,
    });
  });
});

describe("submit", () => {
  it("stays inert until every prompt has been given something", () => {
    const first = prompt({ id: "prompt:0" });
    const second = prompt({ id: "prompt:1", label: "Which remote?" });
    const interaction = question([first, second]);
    const draft = selectOption(emptyInteractionDraft(interaction), first, "question:0:bWFpbg");
    expect(canSubmitInteraction(interaction, draft)).toBe(false);
    expect(canSubmitInteraction(interaction, selectOption(draft, second, "question:0:ZGV2"))).toBe(
      true,
    );
  });

  it("accepts free text alone only where the prompt declares custom", () => {
    const custom = prompt({ custom: true });
    const draft = setPromptResponse({}, "prompt:0", "  the release branch  ");
    expect(isPromptAnswered(custom, draft)).toBe(true);
    expect(isPromptAnswered(prompt({ custom: false }), draft)).toBe(false);
  });

  it("does not count whitespace as an answer", () => {
    expect(
      isPromptAnswered(prompt({ custom: true }), setPromptResponse({}, "prompt:0", "   ")),
    ).toBe(false);
  });

  it("sends every declared verdict on the click that chose it", () => {
    // The commonest gesture in the app; a radio plus a generic confirm doubles
    // it on every turn and the confirm adds nothing. One click for `once` and
    // two for the option beside it taught the gesture and then withheld it.
    const interaction = permission();
    const [only] = interactionQuestions(interaction);
    if (!only) throw new Error("no prompt projected");
    const draft = emptyInteractionDraft(interaction);
    for (const option of PERMISSION_OPTIONS) {
      expect(optionSubmitsOnSelect(interaction, only.prompt, option, draft)).toBe(true);
    }
  });

  it("never sends an opaque answer on the click", () => {
    // A question's option ids are the harness's own encoded values and state no
    // verdict at all: they are answers to assemble, not decisions to give.
    const asked = question([prompt()]);
    const [opaque] = prompt().options;
    if (!opaque) throw new Error("no option declared");
    expect(optionSubmitsOnSelect(asked, prompt(), opaque, emptyInteractionDraft(asked))).toBe(
      false,
    );
  });

  it("puts a verdict back on the card's own control once words are typed", () => {
    // The one thing that kept a refusal waiting: sending on the click must
    // never take the box away from under someone who had already used it.
    const interaction = permission();
    const [only] = interactionQuestions(interaction);
    if (!only) throw new Error("no prompt projected");
    const reject = { id: "reject", label: "Reject", description: null };
    expect(
      optionSubmitsOnSelect(
        interaction,
        only.prompt,
        reject,
        setPromptResponse({}, "prompt:0", "read the lockfile instead"),
      ),
    ).toBe(false);
  });

  it("waits for Submit once the click is not the whole answer", () => {
    // More than one question, a list still being built, free text that is part
    // of the answer, or words already typed beside it.
    const once = { id: "once", label: "Allow once", description: null };
    const single = permission();
    const [only] = interactionQuestions(single);
    if (!only) throw new Error("no prompt projected");
    const many = permission({
      prompts: [only.prompt, { ...only.prompt, id: "prompt:1", label: "And the next one?" }],
    });
    expect(optionSubmitsOnSelect(many, only.prompt, once, emptyInteractionDraft(many))).toBe(false);
    expect(optionSubmitsOnSelect(single, { ...only.prompt, multiple: true }, once, {})).toBe(false);
    expect(optionSubmitsOnSelect(single, { ...only.prompt, custom: true }, once, {})).toBe(false);
    expect(
      optionSubmitsOnSelect(
        single,
        only.prompt,
        once,
        setPromptResponse({}, "prompt:0", "only if you skip the tests"),
      ),
    ).toBe(false);
  });

  it("answers a stored interaction that predates prompts", () => {
    // `readInteractionPrompts` is total, so a record written before the field
    // existed is one prompt built from its flat options — nothing here branches
    // on their absence.
    const legacy = permission({ prompts: undefined });
    const [only] = interactionQuestions(legacy);
    if (!only) throw new Error("no prompt projected");
    expect(only.prompt.id).toBe("prompt:0");
    expect(canSubmitInteraction(legacy, selectOption({}, only.prompt, "once"))).toBe(true);
  });
});

describe("resolution", () => {
  it("stamps one answer per prompt and flattens the union in prompt order", () => {
    const first = prompt({ id: "prompt:0" });
    const second = prompt({ id: "prompt:1", multiple: true });
    const interaction = question([first, second]);
    let draft = selectOption(emptyInteractionDraft(interaction), first, "question:0:bWFpbg");
    draft = selectOption(draft, second, "question:0:ZGV2");
    draft = selectOption(draft, second, "question:0:bWFpbg");

    expect(interactionAnswers(interaction, draft)).toEqual([
      { promptId: "prompt:0", optionIds: ["question:0:bWFpbg"], response: null },
      {
        promptId: "prompt:1",
        optionIds: ["question:0:ZGV2", "question:0:bWFpbg"],
        response: null,
      },
    ]);
    expect(interactionResolution(interaction, draft).optionIds).toEqual([
      "question:0:bWFpbg",
      "question:0:ZGV2",
      "question:0:bWFpbg",
    ]);
  });

  it("carries the text the reader typed, trimmed, and never invents one", () => {
    const interaction = permission();
    const [only] = interaction.prompts ?? [];
    if (!only) throw new Error("fixture has no prompt");
    const rejected = setPromptResponse(
      selectOption(emptyInteractionDraft(interaction), only, "reject"),
      "prompt:0",
      "  read it instead  ",
    );
    expect(interactionResolution(interaction, rejected)).toEqual({
      optionIds: ["reject"],
      response: "read it instead",
      answers: [{ promptId: "prompt:0", optionIds: ["reject"], response: "read it instead" }],
    });
    expect(
      interactionResolution(
        interaction,
        selectOption(emptyInteractionDraft(interaction), only, "once"),
      ).response,
    ).toBeNull();
  });
});

describe("receipt", () => {
  it("says which grant a permission left behind", () => {
    const interaction = permission();
    expect(
      describeInteractionResolution(interaction, { optionIds: ["once"], response: null }),
    ).toEqual({
      verdict: "allowed",
      lead: "You allowed",
      subject: "rm -rf node_modules",
      trailer: "once",
    });
    expect(
      describeInteractionResolution(interaction, { optionIds: ["always"], response: null }).trailer,
    ).toBe("always");
    expect(
      describeInteractionResolution(interaction, { optionIds: ["reject"], response: null }),
    ).toMatchObject({ verdict: "rejected", lead: "You rejected", trailer: null });
  });

  it("quotes the harness's own labels back for a question", () => {
    const interaction = question([prompt()]);
    expect(
      describeInteractionResolution(interaction, {
        optionIds: ["question:0:bWFpbg"],
        response: null,
      }),
    ).toEqual({
      verdict: "answered",
      lead: "You answered",
      subject: "Before I continue",
      trailer: "main",
    });
  });

  it("reads a flat resolution stored before answers existed", () => {
    const legacy = permission({ prompts: undefined });
    expect(
      describeInteractionResolution(legacy, { optionIds: ["once"], response: null }).verdict,
    ).toBe("allowed");
  });

  it("keeps every question's answer, not just the first one's", () => {
    // Each answer's ids are read against its *own* question's options. Filtering
    // one flat union against one prompt's list kept `main` and dropped `origin`,
    // so a two-question request read back as half of what was answered.
    const branch = prompt({ id: "prompt:0" });
    const remote = prompt({
      id: "prompt:1",
      label: "Which remote?",
      options: [
        { id: "question:1:b3JpZ2lu", label: "origin", description: null },
        { id: "question:1:dXBzdHJlYW0", label: "upstream", description: null },
      ],
    });
    const interaction = question([branch, remote]);
    const draft = selectOption(
      selectOption(emptyInteractionDraft(interaction), branch, "question:0:bWFpbg"),
      remote,
      "question:1:b3JpZ2lu",
    );
    expect(
      describeInteractionResolution(interaction, interactionResolution(interaction, draft)),
    ).toEqual({
      verdict: "answered",
      lead: "You answered",
      subject: "Before I continue",
      trailer: "main, origin",
    });
  });

  it("drops an id no question declared rather than naming it wrongly", () => {
    // The flat union is the fallback for records stored before `answers`, and it
    // must not turn one question's id into another question's label.
    const interaction = question([prompt()]);
    expect(
      describeInteractionResolution(interaction, {
        optionIds: ["question:9:Z29uZQ"],
        response: null,
        answers: [{ promptId: "prompt:0", optionIds: ["question:9:Z29uZQ"], response: "kept" }],
      }).trailer,
    ).toBeNull();
  });

  it("reads an answer against the interaction's flat options once its own prompt is gone", () => {
    // An answer naming a prompt id the interaction no longer declares — a record
    // outlived a prompt list that shrank. The interaction's own options are what
    // is left to name the choice from.
    const interaction = question([prompt({ id: "prompt:0" })]);
    expect(
      describeInteractionResolution(interaction, {
        optionIds: ["question:0:bWFpbg"],
        response: null,
        answers: [{ promptId: "prompt:9", optionIds: ["question:0:bWFpbg"], response: null }],
      }).trailer,
    ).toBe("main");
  });

  it("names nothing when a flat option id with no answers to read matches no declared option", () => {
    const opaque = permission({ prompts: [] });
    expect(
      describeInteractionResolution(opaque, {
        optionIds: ["not-a-declared-option"],
        response: null,
        answers: [],
      }).trailer,
    ).toBeNull();
  });

  it("reads a kept-working escalation as its own verdict, not a grant", () => {
    const interaction = escalation();
    const [only] = interaction.prompts ?? [];
    if (!only) throw new Error("fixture has no prompt");
    const { keepWorking } = escalationOptions();
    const draft = selectOption(emptyInteractionDraft(interaction), only, keepWorking.id);
    expect(
      describeInteractionResolution(interaction, interactionResolution(interaction, draft)),
    ).toEqual({
      verdict: "continued",
      lead: "You kept working past",
      subject: "Write outside the worktree",
      trailer: null,
    });
  });

  it("reads a stopped escalation as its own verdict, not a refusal", () => {
    const interaction = escalation();
    const [only] = interaction.prompts ?? [];
    if (!only) throw new Error("fixture has no prompt");
    const { stopTurn } = escalationOptions();
    const draft = selectOption(emptyInteractionDraft(interaction), only, stopTurn.id);
    expect(
      describeInteractionResolution(interaction, interactionResolution(interaction, draft)),
    ).toEqual({
      verdict: "stopped",
      lead: "You stopped the turn at",
      subject: "Write outside the worktree",
      trailer: null,
    });
  });

  it("keeps a typed note off the trailer when the turn stops", () => {
    // The note rides on the resolution's `response`, the same field a
    // permission reply carries its message in. `receiptTrailer` short-circuits
    // on the verdict before it ever looks at labels, so the note must not leak
    // into a trailer the lead already says in full.
    const interaction = escalation();
    const [only] = interaction.prompts ?? [];
    if (!only) throw new Error("fixture has no prompt");
    const { stopTurn } = escalationOptions();
    const draft = setPromptResponse(
      selectOption(emptyInteractionDraft(interaction), only, stopTurn.id),
      "prompt:0",
      "leave that file, I will finish it by hand",
    );
    expect(
      describeInteractionResolution(interaction, interactionResolution(interaction, draft)),
    ).toEqual({
      verdict: "stopped",
      lead: "You stopped the turn at",
      subject: "Write outside the worktree",
      trailer: null,
    });
  });

  it("never reads a kept-working escalation as an allow — the regression this verdict fixes", () => {
    // `continue` sits in ALLOW_OPTION_IDS so the card still draws with a
    // permitting side, but reading that polarity as the verdict printed "You
    // allowed <title> once" for a block that stands whichever option is
    // chosen. A refactor that reorders the verdict chain and lets polarity
    // answer this again should fail here, with a message that names exactly
    // what came back instead of surfacing later as a wrong transcript line.
    const interaction = escalation();
    const [only] = interaction.prompts ?? [];
    if (!only) throw new Error("fixture has no prompt");
    const { keepWorking } = escalationOptions();
    const draft = selectOption(emptyInteractionDraft(interaction), only, keepWorking.id);
    const receipt = describeInteractionResolution(
      interaction,
      interactionResolution(interaction, draft),
    );
    expect(receipt.verdict).not.toBe("allowed");
    expect(receipt.trailer).not.toBe("once");
  });

  it("still reads an out-of-band refusal on an escalation as rejected", () => {
    // `declined` is read off the resolution before the escalation id is, so a
    // reader who selected and said nothing still lands on the refusal this
    // card mints — the escalation check must not treat the absence of
    // `continue`/`stop` as a quieter answer of its own.
    const interaction = escalation();
    expect(
      describeInteractionResolution(interaction, refusalResolution(interaction)),
    ).toMatchObject({ verdict: "rejected", lead: "You rejected", trailer: null });
  });

  it("reads the escalation ids case-insensitively, the same as every other option id", () => {
    const { keepWorking, stopTurn } = escalationOptions();
    const casedContinue = { ...keepWorking, id: keepWorking.id.toUpperCase() };
    const casedStop = {
      ...stopTurn,
      id: stopTurn.id.charAt(0).toUpperCase() + stopTurn.id.slice(1),
    };
    const [basePrompt] = escalation().prompts ?? [];
    if (!basePrompt) throw new Error("fixture has no prompt");
    const casedPrompt = { ...basePrompt, options: [casedContinue, casedStop] };
    const interaction = escalation({
      options: [casedContinue, casedStop],
      prompts: [casedPrompt],
    });
    expect(
      describeInteractionResolution(interaction, { optionIds: [casedContinue.id], response: null })
        .verdict,
    ).toBe("continued");
    expect(
      describeInteractionResolution(interaction, { optionIds: [casedStop.id], response: null })
        .verdict,
    ).toBe("stopped");
  });
});

describe("interactionQuestions", () => {
  it("drops the label the headline already says", () => {
    expect(interactionQuestions(permission())[0]?.label).toBeNull();
  });

  it("keeps every label once there is more than one question", () => {
    const interaction = question([
      prompt({ id: "prompt:0" }),
      prompt({ id: "prompt:1", label: "Which remote?" }),
    ]);
    expect(interactionQuestions(interaction).map((entry) => entry.label)).toEqual([
      "Which branch?",
      "Which remote?",
    ]);
  });
});

describe("one question at a time", () => {
  it("grows no chrome for a request that asked one thing", () => {
    expect(interactionCarousel(permission(), {}, 0)).toBeNull();
    expect(interactionCarousel(permission({ prompts: undefined }), {}, 0)).toBeNull();
  });

  it("reports the position and which way it can move", () => {
    const interaction = question([
      prompt({ id: "prompt:0" }),
      prompt({ id: "prompt:1" }),
      prompt({ id: "prompt:2" }),
    ]);
    expect(interactionCarousel(interaction, {}, 0)).toMatchObject({
      index: 0,
      count: 3,
      hasPrevious: false,
      hasNext: true,
    });
    expect(interactionCarousel(interaction, {}, 2)).toMatchObject({
      index: 2,
      hasPrevious: true,
      hasNext: false,
    });
  });

  it("clamps a step that would land off the end", () => {
    const interaction = question([prompt({ id: "prompt:0" }), prompt({ id: "prompt:1" })]);
    expect(interactionCarousel(interaction, {}, 9)?.index).toBe(1);
    expect(interactionCarousel(interaction, {}, -3)?.index).toBe(0);
  });

  it("says which questions already have something to send", () => {
    // Free movement is the point: answering the last one first must read back
    // as answered, and Submit still waits for the other.
    const first = prompt({ id: "prompt:0" });
    const second = prompt({ id: "prompt:1" });
    const interaction = question([first, second]);
    const draft = selectOption({}, second, "question:0:bWFpbg");
    expect(interactionCarousel(interaction, draft, 0)?.answered).toEqual([false, true]);
    expect(canSubmitInteraction(interaction, draft)).toBe(false);
  });
});

describe("which card a request wants", () => {
  it("sends a permission to the verdict card", () => {
    expect(isAskUserInteraction(permission())).toBe(false);
  });

  it("keeps a sandbox escalation on the verdict card, question though it is", () => {
    // The one case `kind` gets wrong: stored as a question, but what it offers
    // is a declared yes and no, which is the permission's shape.
    const raised = escalation();
    expect(raised.kind).toBe("question");
    expect(isAskUserInteraction(raised)).toBe(false);
  });

  it("takes a question whose ids are the harness's own", () => {
    expect(isAskUserInteraction(question([prompt()]))).toBe(true);
  });
});

describe("the box beside an ask-user question's options", () => {
  it("opens where the harness declared it takes free text", () => {
    expect(askFieldOpen(prompt({ custom: true }))).toBe(true);
  });

  it("stays shut where the model asked for one of the listed answers", () => {
    // The reply has no slot for words a prompt without `custom` was not
    // declared to take, so an "Other" row would collect and then drop them.
    expect(askFieldOpen(prompt({ custom: false }))).toBe(false);
  });

  it("opens anyway where there is nothing else to answer with", () => {
    expect(askFieldOpen(prompt({ options: [], custom: false }))).toBe(true);
  });
});

describe("how an option row is set", () => {
  it("trails a short description after the title", () => {
    expect(promptRowLayout(prompt())).toBe("inline");
    expect(
      promptRowLayout(
        prompt({
          options: [{ id: "question:0:bWFpbg", label: "main", description: "ships on the tag" }],
        }),
      ),
    ).toBe("inline");
  });

  it("stacks the list as soon as one description would wrap", () => {
    // The whole list, not the row: one stacked row beside three inline ones
    // reads as the important one rather than as the long one.
    expect(
      promptRowLayout(
        prompt({
          options: [
            { id: "question:0:bWFpbg", label: "main", description: "ships on the tag" },
            {
              id: "question:0:cmVsZWFzZQ",
              label: "release",
              description:
                "Cuts a patch today, which means the migration has to be reversible before it lands rather than after.",
            },
          ],
        }),
      ),
    ).toBe("stacked");
  });
});

describe("what a question is waiting for", () => {
  it("names the act the control beside it names", () => {
    expect(promptRequirement(prompt())).toBe("Choose an option");
    expect(promptRequirement(prompt({ options: [] }))).toBe("Write an answer");
  });

  it("finds the question that owes an answer, and says so when none does", () => {
    const first = prompt({ id: "prompt:0" });
    const second = prompt({ id: "prompt:1" });
    const interaction = question([first, second]);
    expect(firstUnansweredPrompt(interaction, {})).toBe(0);
    const half = selectOption({}, first, "question:0:bWFpbg");
    expect(firstUnansweredPrompt(interaction, half)).toBe(1);
    const whole = selectOption(half, second, "question:0:bWFpbg");
    expect(firstUnansweredPrompt(interaction, whole)).toBe(-1);
  });
});

describe("the stepped question flow", () => {
  const walk = () =>
    question([
      prompt({ id: "prompt:0" }),
      prompt({ id: "prompt:1", label: "Which remote?" }),
      prompt({ id: "prompt:2", label: "What else?", multiple: true }),
    ]);

  it("has no step on a request that declares no questions", () => {
    expect(interactionStep(question([]), {}, 0)).toBeNull();
  });

  it("clamps a stale index rather than stepping off the end", () => {
    expect(interactionStep(walk(), {}, 9)?.index).toBe(2);
    expect(interactionStep(walk(), {}, -4)?.index).toBe(0);
  });

  it("reports the position, the ends of the walk, and what is answered", () => {
    const draft = selectOption({}, prompt({ id: "prompt:1" }), "question:0:bWFpbg");
    expect(interactionStep(walk(), draft, 1)).toMatchObject({
      index: 1,
      count: 3,
      heading: "Which remote?",
      first: false,
      last: false,
      answered: [false, true, false],
    });
  });

  it("takes the request's own title where the question has no separate one", () => {
    expect(interactionStep(permission(), {}, 0)?.heading).toBe("rm -rf node_modules");
  });

  it("offers a skip while there is somewhere to skip to", () => {
    // Movement, not an answer: nothing durable records a skip, so the last
    // question has nothing to step to and Submit still waits for it.
    expect(interactionStep(walk(), {}, 0)?.skippable).toBe(true);
    expect(interactionStep(walk(), {}, 2)?.skippable).toBe(false);
    expect(interactionStep(question([prompt()]), {}, 0)?.skippable).toBe(false);
  });

  it("leaves a single choice to the click that makes it", () => {
    expect(interactionStep(walk(), {}, 0)?.advanceLabel).toBeNull();
  });

  it("gives several answers a control to move on with", () => {
    expect(interactionStep(walk(), {}, 2)?.advanceLabel).not.toBeNull();
    const middle = question([
      prompt({ id: "prompt:0", multiple: true }),
      prompt({ id: "prompt:1" }),
    ]);
    expect(interactionStep(middle, {}, 0)?.advanceLabel).toBe("Next");
  });

  it("gives written words a deliberate commit even beside a single choice", () => {
    const draft = setPromptResponse({}, "prompt:0", "the release branch, actually");
    expect(interactionStep(walk(), draft, 0)?.advanceLabel).toBe("Send");
    const written = question([
      prompt({ id: "prompt:0", custom: true }),
      prompt({ id: "prompt:1" }),
    ]);
    expect(
      interactionStep(written, setPromptResponse({}, "prompt:0", "neither"), 0)?.advanceLabel,
    ).toBe("Next");
  });

  it("names the act rather than the step at the end of the walk", () => {
    // The card's own submit vocabulary, not a second one: several questions
    // have a counter to say what is left, so the control stays neutral; one
    // question has nothing else that could, so it names what it waits for.
    expect(interactionStep(walk(), {}, 2)?.advanceLabel).toBe("Submit");
    expect(interactionStep(question([prompt()]), {}, 0)?.advanceLabel).toBe("Choose");
    expect(
      interactionStep(question([prompt({ options: [], custom: true })]), {}, 0)?.advanceLabel,
    ).toBe("Answer");
  });
});

describe("one press of the control that moves the flow on", () => {
  const walk = () =>
    question([
      prompt({ id: "prompt:0" }),
      prompt({ id: "prompt:1", label: "Which remote?" }),
      prompt({ id: "prompt:2", label: "What else?", multiple: true }),
    ]);
  const answerAll = () => {
    let draft: Record<string, { optionIds: readonly string[]; response: string }> = {};
    for (const id of ["prompt:0", "prompt:1", "prompt:2"])
      draft = selectOption(draft, prompt({ id }), "question:0:bWFpbg");
    return draft;
  };

  it("has nothing to press on a request that declares no questions", () => {
    expect(interactionAdvance(question([]), {}, 0)).toBeNull();
  });

  it("blocks on the question in view and names what it owes", () => {
    expect(interactionAdvance(walk(), {}, 1)).toEqual({
      kind: "blocked",
      at: 1,
      requirement: "Choose an option",
    });
  });

  it("steps forward once the question in view has something", () => {
    const draft = selectOption({}, prompt({ id: "prompt:0" }), "question:0:bWFpbg");
    expect(interactionAdvance(walk(), draft, 0)).toEqual({ kind: "step", at: 1 });
  });

  it("sends the whole walk from its last question", () => {
    const sent = interactionAdvance(walk(), answerAll(), 2);
    expect(sent?.kind).toBe("send");
    // Every question's answer in one resolution: the walk is a way of asking,
    // never a way of sending three of them.
    expect(sent?.kind === "send" ? sent.submission : null).toEqual({
      message: null,
      resolution: interactionResolution(walk(), answerAll()),
    });
    expect(
      sent?.kind === "send" ? sent.submission.resolution.answers?.map((a) => a.promptId) : null,
    ).toEqual(["prompt:0", "prompt:1", "prompt:2"]);
  });

  it("sends words no reply can carry from wherever they were typed", () => {
    // The redirection refuses the request, so it outranks both the question in
    // view and the two questions the walk had left.
    const draft = setPromptResponse({}, "prompt:1", "neither — cut a branch off the tag");
    expect(interactionAdvance(walk(), draft, 1)).toEqual({
      kind: "send",
      submission: {
        resolution: refusalResolution(walk()),
        message: "neither — cut a branch off the tag",
      },
    });
  });

  it("walks back to the question that was stepped past", () => {
    // Submit is atomic, so the press at the end of a walk with a hole in it
    // cannot fire — and saying nothing would leave the reader pressing a dead
    // control on a question that is perfectly answered.
    let draft = selectOption({}, prompt({ id: "prompt:1" }), "question:0:bWFpbg");
    draft = selectOption(draft, prompt({ id: "prompt:2" }), "question:0:bWFpbg");
    expect(interactionAdvance(walk(), draft, 2)).toEqual({
      kind: "blocked",
      at: 0,
      requirement: "Choose an option",
    });
  });
});

describe("where a card draws", () => {
  it("pairs a gated call with its question on the durable ask:<toolCallId> id", () => {
    // The identity that survives the product edge: the runtime mints the
    // interaction as `ask:<toolCallId>`, and the gated part carries the same
    // tool call id. `native` is nulled on everything the edge ships, so it
    // correlates nothing.
    const gated = permission({ id: "ask:call-1" });
    const other = permission({ id: "ask:call-2" });
    expect(interactionForApproval([other, gated], "call-1")).toBe(gated);
    expect(interactionForApproval([other, gated], "call-9")).toBe(null);
    // A row with no gate names no interaction — never the only open one by
    // adjacency, which would put a subagent's question on a parent's call.
    expect(interactionForApproval([gated], null)).toBe(null);
  });

  it("leaves the foot the oldest interaction no row is showing", () => {
    const gated = permission({ id: "ask:call-1" });
    const asked = question([prompt()]);
    expect(footInteraction([gated, asked], new Set(["call-1"]))).toBe(asked);
    expect(footInteraction([gated, asked], new Set())).toBe(gated);
    expect(footInteraction([gated], new Set(["call-1"]))).toBe(null);
  });

  it("keeps a model's own question at the foot even while calls are gated", () => {
    // An `ask-user:` id is never the `ask:` derivation of any gated call, so
    // it belongs there by construction rather than by having survived a filter.
    const loose = permission({ id: "ask-user:call-1", native: { id: null, detail: null } });
    expect(footInteraction([loose], new Set(["call-1"]))).toBe(loose);
  });
});

describe("the durable answer in scrollback", () => {
  it("indexes every interaction the log recorded opening", () => {
    const interaction = permission();
    const index = indexOpenedInteractions([
      { event: { payload: { kind: "turn.started", attachmentId: "a", turnId: "t" } } },
      { event: { payload: { kind: "interaction.opened", interaction } } },
    ]);
    expect(index.get("permission:p1")).toBe(interaction);
    expect(index.size).toBe(1);
  });

  it("reads the resolution a user message carries", () => {
    expect(
      readInteractionResolutionMessage({
        metadata: { kind: "interaction-resolution", interactionId: "permission:p1" },
        parts: [
          {
            type: "data-interaction-resolution",
            data: { optionIds: ["reject"], response: "read it instead" },
          },
        ],
      }),
    ).toEqual({
      interactionId: "permission:p1",
      resolution: { optionIds: ["reject"], response: "read it instead" },
    });
  });

  it("skips a part that is not the resolution to reach the one that is", () => {
    expect(
      readInteractionResolutionMessage({
        metadata: { interactionId: "permission:p1" },
        parts: [
          { type: "text", text: "some other part" },
          { type: "data-interaction-resolution", data: { optionIds: ["once"], response: null } },
        ],
      }),
    ).toEqual({
      interactionId: "permission:p1",
      resolution: { optionIds: ["once"], response: null },
    });
  });

  it("reads an ordinary message as not one", () => {
    // This crosses the RPC edge as JSON, so a shape we do not recognize reads
    // as "not a resolution" rather than throwing inside a render.
    expect(readInteractionResolutionMessage({ parts: [{ type: "text" }] })).toBeNull();
    expect(
      readInteractionResolutionMessage({
        metadata: { interactionId: "permission:p1" },
        parts: [{ type: "data-interaction-resolution" }],
      }),
    ).toBeNull();
    expect(
      readInteractionResolutionMessage({
        metadata: {},
        parts: [{ type: "data-interaction-resolution", data: { optionIds: ["once"] } }],
      }),
    ).toBeNull();
  });

  it("reads back every question's answer from the durable part", () => {
    // The runtime writes the whole resolution, `answers` included. Decoding
    // only the flat pair left the receipt to the single-answer fallback, which
    // stamps the union onto the first prompt — so the second question's choice
    // never reached scrollback at all.
    const branch = prompt({ id: "prompt:0" });
    const remote = prompt({
      id: "prompt:1",
      label: "Which remote?",
      options: [{ id: "question:1:b3JpZ2lu", label: "origin", description: null }],
    });
    const interaction = question([branch, remote]);
    const resolution = interactionResolution(
      interaction,
      selectOption(
        selectOption(emptyInteractionDraft(interaction), branch, "question:0:bWFpbg"),
        remote,
        "question:1:b3JpZ2lu",
      ),
    );
    // Exactly what `session-runtime` commits: the resolution, verbatim, as the
    // message's only part.
    const read = readInteractionResolutionMessage({
      metadata: { kind: "interaction-resolution", interactionId: "question:q1" },
      parts: [{ type: "data-interaction-resolution", data: resolution }],
    });
    if (!read) throw new Error("the resolution message read as an ordinary one");
    expect(read.resolution.answers).toEqual([
      { promptId: "prompt:0", optionIds: ["question:0:bWFpbg"], response: null },
      { promptId: "prompt:1", optionIds: ["question:1:b3JpZ2lu"], response: null },
    ]);
    expect(describeInteractionResolution(interaction, read.resolution).trailer).toBe(
      "main, origin",
    );
  });

  it("keeps a stored answer it cannot read out of the answers it can", () => {
    // Crossing the RPC edge as JSON, so an entry with no prompt id or no option
    // array is skipped rather than throwing inside a render.
    expect(
      readInteractionResolutionMessage({
        metadata: { interactionId: "question:q1" },
        parts: [
          {
            type: "data-interaction-resolution",
            data: {
              optionIds: ["a"],
              response: null,
              answers: [
                { promptId: "prompt:0", optionIds: ["a", 7], response: 3 },
                { optionIds: ["b"] },
                "not an answer",
              ],
            },
          },
        ],
      })?.resolution.answers,
    ).toEqual([{ promptId: "prompt:0", optionIds: ["a"], response: null }]);
  });

  it("keeps a stored answer's own free text, not just its selections", () => {
    expect(
      readInteractionResolutionMessage({
        metadata: { interactionId: "question:q1" },
        parts: [
          {
            type: "data-interaction-resolution",
            data: {
              optionIds: [],
              response: null,
              answers: [{ promptId: "prompt:0", optionIds: [], response: "the release branch" }],
            },
          },
        ],
      })?.resolution.answers,
    ).toEqual([{ promptId: "prompt:0", optionIds: [], response: "the release branch" }]);
  });

  it("leaves a resolution stored before answers existed reading flat", () => {
    // Undefined, not an empty array: an empty one would read as an interaction
    // answered with nothing, which is how a refusal reads.
    expect(
      readInteractionResolutionMessage({
        metadata: { interactionId: "permission:p1" },
        parts: [
          { type: "data-interaction-resolution", data: { optionIds: ["once"], answers: [] } },
        ],
      })?.resolution,
    ).toEqual({ optionIds: ["once"], response: null });
  });

  it("keeps a resolution with no text as one with no text", () => {
    expect(
      readInteractionResolutionMessage({
        metadata: { interactionId: "question:q1" },
        parts: [{ type: "data-interaction-resolution", data: { optionIds: [], response: null } }],
      }),
    ).toEqual({ interactionId: "question:q1", resolution: { optionIds: [], response: null } });
  });
});
