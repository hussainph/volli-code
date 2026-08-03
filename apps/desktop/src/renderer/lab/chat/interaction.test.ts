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
  isPromptAnswered,
  needsOwnRefusal,
  optionPolarity,
  promptTakesText,
  promptDraft,
  promptFieldRole,
  refusalResolution,
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
  it("is a note beside a declared answer", () => {
    const single = prompt();
    expect(promptFieldRole(single, selectOption({}, single, "question:0:bWFpbg"))).toBe("note");
  });

  it("becomes the redirection beside a refusal", () => {
    const [permissionPrompt] = permission().prompts ?? [];
    if (!permissionPrompt) throw new Error("fixture has no prompt");
    expect(promptFieldRole(permissionPrompt, selectOption({}, permissionPrompt, "reject"))).toBe(
      "redirection",
    );
    expect(promptFieldRole(permissionPrompt, selectOption({}, permissionPrompt, "once"))).toBe(
      "note",
    );
  });

  it("is the answer itself where the harness accepts one and nothing is chosen", () => {
    expect(promptFieldRole(prompt({ custom: true }), {})).toBe("answer");
    expect(promptFieldRole(prompt({ custom: false }), {})).toBe("note");
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

describe("where a box is offered", () => {
  it("follows the harness, not the shape of the question", () => {
    // A prompt declaring `custom` is answered in words, and a permission's
    // refusal carries a `message`. A question refused out of band sends a body
    // -less reject, so a box there would take a sentence nobody would read.
    const [permissionPrompt] = permission().prompts ?? [];
    if (!permissionPrompt) throw new Error("fixture has no prompt");
    expect(promptTakesText(permissionPrompt)).toBe(true);
    expect(promptTakesText(prompt({ custom: true }))).toBe(true);
    expect(promptTakesText(prompt({ custom: false }))).toBe(false);
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

  it("keeps a resolution with no text as one with no text", () => {
    expect(
      readInteractionResolutionMessage({
        metadata: { interactionId: "question:q1" },
        parts: [{ type: "data-interaction-resolution", data: { optionIds: [], response: null } }],
      }),
    ).toEqual({ interactionId: "question:q1", resolution: { optionIds: [], response: null } });
  });
});
