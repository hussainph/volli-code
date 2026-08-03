import type { SessionInteraction, SessionInteractionPrompt } from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";

import {
  canSubmitInteraction,
  describeInteractionResolution,
  emptyInteractionDraft,
  interactionAnswers,
  interactionQuestions,
  interactionResolution,
  isPromptAnswered,
  optionPolarity,
  promptDraft,
  promptFieldRole,
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
