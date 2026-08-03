import type { SessionInteraction, SessionInteractionPrompt } from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";

import {
  canSubmitInteraction,
  indexOpenedInteractions,
  readInteractionResolutionMessage,
  describeInteractionResolution,
  emptyInteractionDraft,
  footInteraction,
  interactionAnswers,
  interactionCarousel,
  interactionForApproval,
  interactionQuestions,
  interactionResolution,
  interactionSubmitLabel,
  isPromptAnswered,
  needsOwnRefusal,
  optionPolarity,
  optionSubmitsOnSelect,
  promptDraft,
  promptFieldOpen,
  promptFieldRole,
  promptRedirected,
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

describe("optionPolarity", () => {
  it("reads a standing grant apart from a one-time yes", () => {
    expect(optionPolarity({ id: "once" })).toBe("allow");
    expect(optionPolarity({ id: "always" })).toBe("standing");
    expect(optionPolarity({ id: "reject" })).toBe("reject");
  });

  it("matches declared ids case-insensitively", () => {
    expect(optionPolarity({ id: "Once" })).toBe("allow");
    expect(optionPolarity({ id: "REJECT" })).toBe("reject");
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
});

describe("none of these work", () => {
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
    expect(promptRedirected(plain, draft)).toBe(true);
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
    expect(promptRedirected(second, draft)).toBe(false);
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

  it("sends a one-time yes on the click that chose it", () => {
    // The commonest gesture in the app used to cost one click; a radio plus a
    // generic confirm doubles it on every turn and the confirm adds nothing.
    const interaction = permission();
    const [only] = interactionQuestions(interaction);
    if (!only) throw new Error("no prompt projected");
    const once = { id: "once", label: "Allow once", description: null };
    const draft = emptyInteractionDraft(interaction);
    expect(optionSubmitsOnSelect(interaction, only.prompt, once, draft)).toBe(true);
  });

  it("still asks twice for a standing grant, a refusal, and an opaque answer", () => {
    // A standing grant outlives the turn and must never be the cheapest thing
    // on the card; a refusal is the verdict whose words matter; a question's
    // option ids are the harness's own values and state no verdict at all.
    const interaction = permission();
    const [only] = interactionQuestions(interaction);
    if (!only) throw new Error("no prompt projected");
    const draft = emptyInteractionDraft(interaction);
    for (const option of PERMISSION_OPTIONS.filter((entry) => entry.id !== "once")) {
      expect(optionSubmitsOnSelect(interaction, only.prompt, option, draft)).toBe(false);
    }
    const asked = question([prompt()]);
    const [opaque] = prompt().options;
    if (!opaque) throw new Error("no option declared");
    expect(optionSubmitsOnSelect(asked, prompt(), opaque, emptyInteractionDraft(asked))).toBe(
      false,
    );
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

describe("where a card draws", () => {
  it("pairs a gated call with its question on the harness's own id", () => {
    const gated = permission();
    const other = permission({ id: "permission:p2", native: { id: "perm-2", detail: null } });
    expect(interactionForApproval([other, gated], "perm-1")).toBe(gated);
    expect(interactionForApproval([other, gated], "perm-9")).toBe(null);
    // A row with no gate names no interaction — never the only open one by
    // adjacency, which would put a subagent's question on a parent's call.
    expect(interactionForApproval([gated], null)).toBe(null);
  });

  it("leaves the foot the oldest interaction no row is showing", () => {
    const gated = permission();
    const asked = question([prompt()]);
    expect(footInteraction([gated, asked], new Set(["perm-1"]))).toBe(asked);
    expect(footInteraction([gated, asked], new Set())).toBe(gated);
    expect(footInteraction([gated], new Set(["perm-1"]))).toBe(null);
  });

  it("keeps an interaction with no native id at the foot", () => {
    // Nothing can correlate to it, so it belongs there by construction rather
    // than by having survived a filter.
    const loose = permission({ native: { id: null, detail: null } });
    expect(footInteraction([loose], new Set(["perm-1"]))).toBe(loose);
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
