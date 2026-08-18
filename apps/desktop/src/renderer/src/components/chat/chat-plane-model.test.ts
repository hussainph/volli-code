/**
 * The chat plane's decisions, without a plane.
 *
 * Five rules that were each a bug: what a blocker row still says while a card is
 * up, when a redirection is allowed to leave, which card a decision in flight
 * disables, where words go when there is nowhere to send them, and what a
 * streamed token is allowed to re-render.
 */
import type {
  ModelAccessModel,
  ModelAccessProvider,
  RendererSessionInteraction,
  SessionAttention,
  SessionInteractionPrompt,
  SessionInteractionResolution,
} from "@volli/shared";
import type { UIMessage } from "ai";
import { describe, expect, it } from "vite-plus/test";

import { createChatDraftsStore, type HeldMessage } from "@renderer/stores/chat-drafts";

import {
  answerInteraction,
  composerModelSelection,
  composerPress,
  coordinateQueuedMutation,
  coordinateQueuedSteerStart,
  dispatchHeldMessage,
  hasReconciledSessionSnapshot,
  heldStrip,
  holdList,
  messageCopyText,
  messageRoute,
  resolvingWith,
  sameInteractionId,
  sameMessages,
  sameQueuedMessage,
  sessionBlocker,
  sessionModelStanding,
  steerRollbackState,
  steerTurnIsCurrent,
  steerQueuedMessage,
  settledHeldIds,
  terminalCompanionTabId,
  withdrawInteraction,
  type SessionBlockerActs,
  type SessionBlockerInput,
  type QueuedSteerActs,
  type QueuedSteerDelivery,
} from "./chat-plane-model";

function heldMessage(id: string, text: string, state: HeldMessage["state"]): HeldMessage {
  return { id, text, state };
}

interface SteerHarnessInput {
  held?: readonly HeldMessage[];
  queue?: readonly { id: string; text: string }[];
  steerable?: boolean;
  submit?: QueuedSteerActs["submit"];
}

function steerHarness({ held = [], queue = [], steerable = true, submit }: SteerHarnessInput = {}) {
  const drafts = createChatDraftsStore({
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  });
  for (const entry of held) {
    drafts.getState().holdMessage("s1", entry);
    drafts.getState().markHeld("s1", entry.id, entry.state);
  }
  let releaseQueue = [...queue];
  const events: string[] = [];
  const acts: QueuedSteerActs = {
    read: () => ({
      held: drafts.getState().drafts.s1?.held ?? [],
      queue: releaseQueue,
      steerable,
    }),
    start: async (visible, targetId) => {
      events.push(`start:${visible.map((entry) => entry.id).join(",")}:${targetId}`);
      drafts.getState().beginQueuedSteer("s1", visible, targetId);
      releaseQueue = releaseQueue.filter((entry) => entry.id !== targetId);
      return "started";
    },
    submit: (message, delivery) => {
      events.push(`submit:${message.id}:${delivery}`);
      return submit?.(message, delivery) ?? Promise.resolve("delivered");
    },
    finish: async (id, outcome) => {
      events.push(`finish:${id}:${outcome}`);
      if (outcome === "refused") drafts.getState().markHeld("s1", id, "unsent");
      else drafts.getState().dropHeld("s1", id);
    },
  };
  return {
    acts,
    events,
    held: () => drafts.getState().drafts.s1?.held ?? [],
    queue: () => releaseQueue,
    strip: () => heldStrip(drafts.getState().drafts.s1?.held ?? [], releaseQueue),
  };
}

describe("composer model selection", () => {
  it("accepts only product reasoning levels at the durable command boundary", () => {
    expect(
      composerModelSelection({
        providerId: "openai-codex",
        modelId: "gpt-5.6-sol",
        reasoningLevel: "high",
      }),
    ).toEqual({
      providerId: "openai-codex",
      modelId: "gpt-5.6-sol",
      reasoningLevel: "high",
    });
    expect(
      composerModelSelection({
        providerId: "openai-codex",
        modelId: "gpt-5.6-sol",
        reasoningLevel: "",
      }),
    ).toBeNull();
    expect(
      composerModelSelection({
        providerId: "openai-codex",
        modelId: "gpt-5.6-sol",
        reasoningLevel: "provider-ultra",
      }),
    ).toBeNull();
  });
});

describe("the Session's own model, against the catalog", () => {
  const catalog: readonly ModelAccessModel[] = [
    {
      providerId: "openai-codex",
      modelId: "gpt-5.6-luna",
      label: "GPT-5.6 Luna",
      state: "available",
      reasoningLevels: ["medium"],
      acceptsImageInput: true,
    },
    {
      // The same model name, from a provider this profile never signed into.
      providerId: "azure-openai-responses",
      modelId: "gpt-5.6-luna",
      label: "GPT-5.6 Luna",
      state: "authentication-required",
      reasoningLevels: ["medium"],
      acceptsImageInput: true,
    },
  ];
  const providers: readonly ModelAccessProvider[] = [
    {
      id: "azure-openai-responses",
      label: "Azure OpenAI Responses",
      state: "authentication-required",
      accountLabel: null,
      billingSource: "unknown",
      recovery: { kind: "sign-in" },
      signIn: [],
      hasStoredCredential: false,
    },
  ];

  it("separates two identically named models by the provider each belongs to", () => {
    expect(
      sessionModelStanding(
        { providerId: "azure-openai-responses", modelId: "gpt-5.6-luna" },
        catalog,
        providers,
      ),
    ).toEqual({
      providerId: "azure-openai-responses",
      providerLabel: "Azure OpenAI Responses",
      state: "authentication-required",
    });
    expect(
      sessionModelStanding(
        { providerId: "openai-codex", modelId: "gpt-5.6-luna" },
        catalog,
        providers,
      ),
    ).toEqual({ providerId: "openai-codex", providerLabel: "openai-codex", state: "available" });
  });

  it("counts a model the catalog no longer lists as one that cannot be run", () => {
    expect(
      sessionModelStanding({ providerId: "openai", modelId: "gone" }, catalog, providers),
    ).toEqual({ providerId: "openai", providerLabel: "openai", state: "unavailable" });
  });

  it("has nothing to say about a Session with no recorded model", () => {
    expect(sessionModelStanding(null, catalog, providers)).toBeNull();
  });
});

const NO_OP = () => undefined;
const ACTS: SessionBlockerActs = {
  recover: NO_OP,
  retryRuntime: NO_OP,
  openSettings: NO_OP,
  signIn: NO_OP,
};

function blockerInput(overrides: Partial<SessionBlockerInput> = {}): SessionBlockerInput {
  return {
    sessionError: null,
    attention: { active: [], primary: null },
    catalogState: "ready",
    catalogError: null,
    sessionModel: { providerId: "openai-codex", providerLabel: "OpenAI Codex", state: "available" },
    signInProviders: [],
    ...overrides,
  };
}

/** The kinds that carry nothing but the base fields — no `retryAt`, no `resetAt`. */
type PlainAttentionKind = Exclude<SessionAttention["kind"], "quota_exhausted" | "rate_limited">;

function attention(kind: PlainAttentionKind, detail: string | null = null): SessionAttention {
  return { id: `attention-${kind}`, attachmentId: null, detail, diagnostic: null, kind };
}

function raised(primary: SessionAttention): SessionBlockerInput {
  return blockerInput({ attention: { active: [primary], primary } });
}

const rateLimited = (retryAt: number | null): SessionAttention => ({
  id: "attention-rate",
  attachmentId: null,
  detail: null,
  diagnostic: null,
  kind: "rate_limited",
  retryAt,
});

const quotaSpent = (resetAt: number | null): SessionAttention => ({
  id: "attention-quota",
  attachmentId: null,
  detail: null,
  diagnostic: null,
  kind: "quota_exhausted",
  resetAt,
});

const REFUSAL: SessionInteractionResolution = { optionIds: [], response: null };

/** One card's round trip, with what it told the surface along the way. */
function recorder(resolved: boolean) {
  const delivered: string[] = [];
  const flags: [string, boolean][] = [];
  return {
    delivered,
    flags,
    acts: {
      resolve: () => Promise.resolve(resolved),
      deliver: (message: string) => delivered.push(message),
      resolving: (id: string, active: boolean) => flags.push([id, active]),
    },
  };
}

describe("sessionBlocker", () => {
  it("reports a failed decision while its card is still on screen", () => {
    const blocker = sessionBlocker(
      blockerInput({ sessionError: "Decision not delivered: socket hang up" }),
      ACTS,
      true,
    );

    expect(blocker?.message).toBe("Decision not delivered: socket hang up");
    expect(blocker?.action?.label).toBe("Retry");
  });

  it("keeps a harness attention the card cannot answer", () => {
    expect(sessionBlocker(raised(attention("auth_required")), ACTS, true)?.message).toBe(
      "Sign-in required",
    );
  });

  it("sends both provider-owned recoveries to Settings with the failed run's retry beside it", () => {
    // Signing in happens inside Settings now, so the pair no longer forks on
    // whether a manual Ticket terminal exists to hand off to.
    expect(sessionBlocker(raised(attention("auth_required")), ACTS, false)).toEqual({
      message: "Sign-in required",
      detail: null,
      tone: "error",
      action: { label: "Settings", act: NO_OP },
      secondaryAction: { label: "Retry", act: NO_OP },
    });
    expect(sessionBlocker(raised(attention("configuration_invalid")), ACTS, false)).toEqual({
      message: "Configuration invalid",
      detail: null,
      tone: "error",
      action: { label: "Settings", act: NO_OP },
      secondaryAction: { label: "Retry", act: NO_OP },
    });
  });

  it("offers a project chat the same retry a Ticket chat gets", () => {
    // The old rule withheld it from a Session with no terminal, on the honest
    // ground that retrying a run whose sign-in could not be reached was a
    // button that could not work. Both can reach the sign-in now.
    const projectChat = sessionBlocker(raised(attention("auth_required")), ACTS, false);

    expect(projectChat?.secondaryAction).toEqual({ label: "Retry", act: NO_OP });
  });

  it("says the Session's own model needs sign-in before a message is spent on it", () => {
    // The exact shape of the bug: a Session born with the app default still
    // pointing at a provider nobody signed into. Today it looks ordinary until
    // the first message dies at the provider's API.
    const pinned = blockerInput({
      sessionModel: {
        providerId: "azure-openai-responses",
        providerLabel: "Azure OpenAI Responses",
        state: "authentication-required",
      },
    });

    expect(sessionBlocker(pinned, ACTS, false)).toMatchObject({
      message: "Sign-in required for Azure OpenAI Responses",
      detail: null,
      tone: "error",
      action: { label: "Sign in" },
    });
  });

  // The row that already knows WHICH provider is blocking typing sends the
  // reader straight to that provider's sign-in, never merely to the category
  // (VC-53). The harness's own `auth_required` names no provider id, so its
  // recovery stays Settings.
  it("deep-links a signed-out pinned model to its own provider's sign-in", () => {
    const signedInTo: string[] = [];
    const pinned = blockerInput({
      sessionModel: {
        providerId: "azure-openai-responses",
        providerLabel: "Azure OpenAI Responses",
        state: "authentication-required",
      },
    });

    const blocker = sessionBlocker(pinned, { ...ACTS, signIn: (id) => signedInTo.push(id) }, false);
    blocker?.action?.act();

    expect(signedInTo).toEqual(["azure-openai-responses"]);
    expect(sessionBlocker(raised(attention("auth_required")), ACTS, false)?.action?.label).toBe(
      "Settings",
    );
  });

  // Settings writes the app DEFAULT, copied into a Session at birth and never
  // re-read: it cannot repin a Session already born on a model that has gone.
  // The pill under this row can, so the row offers no button rather than one
  // that spends the reader's attempt and leaves them where they started.
  it("offers no action for a model Settings would not repin", () => {
    expect(
      sessionBlocker(
        blockerInput({
          sessionModel: { providerId: "openai", providerLabel: "OpenAI", state: "unavailable" },
        }),
        ACTS,
        false,
      ),
    ).toEqual({
      message: "Model unavailable for OpenAI",
      detail: null,
      tone: "error",
      action: null,
    });
  });

  it("outranks the harness's own report of the same fact, but never the transport's", () => {
    const pinned = {
      ...raised(attention("auth_required", "Provider is not configured: azure-openai-responses")),
      sessionModel: {
        providerId: "azure-openai-responses",
        providerLabel: "Azure OpenAI Responses",
        state: "authentication-required" as const,
      },
    };

    expect(sessionBlocker(pinned, ACTS, false)?.message).toBe(
      "Sign-in required for Azure OpenAI Responses",
    );
    expect(
      sessionBlocker({ ...pinned, sessionError: "Lost the Session stream" }, ACTS, false)?.message,
    ).toBe("Lost the Session stream");
  });

  it("accuses no model until the catalog has answered", () => {
    const unanswered = {
      sessionModel: {
        providerId: "openai",
        providerLabel: "OpenAI",
        state: "unavailable" as const,
      },
    };

    expect(
      sessionBlocker(blockerInput({ ...unanswered, catalogState: "loading" }), ACTS, false),
    ).toBeNull();
    // A Session whose executor pins its own model has no catalog to weigh.
    expect(
      sessionBlocker(blockerInput({ ...unanswered, catalogState: "pinned" }), ACTS, false),
    ).toBeNull();
    expect(sessionBlocker(blockerInput({ sessionModel: null }), ACTS, false)).toBeNull();
  });

  it("stands down for the attention the card is itself the answer to", () => {
    const asked = raised(attention("permission_required"));

    expect(sessionBlocker(asked, ACTS, true)).toBeNull();
    expect(sessionBlocker(asked, ACTS, false)?.message).toBe("Waiting for approval");
  });

  it("does not ask for models while a card is waiting for an answer", () => {
    const empty = blockerInput({ catalogState: "empty" });

    expect(sessionBlocker(empty, ACTS, true)).toBeNull();
    expect(sessionBlocker(empty, ACTS, false)?.message).toBe("No models configured");
    // No providers offering sign-in — the row offers Settings alone, no menu.
    expect(sessionBlocker(empty, ACTS, false)?.signInMenu).toBeUndefined();
  });

  it("offers the first-run provider menu, and it routes straight to sign-in", () => {
    const signedInTo: string[] = [];
    const empty = blockerInput({
      catalogState: "empty",
      signInProviders: [
        { id: "anthropic", label: "Anthropic" },
        { id: "openai-codex", label: "OpenAI Codex" },
      ],
    });

    const blocker = sessionBlocker(empty, { ...ACTS, signIn: (id) => signedInTo.push(id) }, false);

    expect(blocker?.signInMenu?.label).toBe("Sign in");
    expect(blocker?.signInMenu?.options.map((option) => option.id)).toEqual([
      "anthropic",
      "openai-codex",
    ]);
    // Settings stays beside the menu — the rest of the pane (defaults,
    // visibility, the full account list) is still one press away.
    expect(blocker?.action?.label).toBe("Settings");
    blocker?.signInMenu?.choose("anthropic");
    expect(signedInTo).toEqual(["anthropic"]);
  });

  it("never lets a catalog failure stand in for the Session's own", () => {
    const blocker = sessionBlocker(
      blockerInput({
        sessionError: "Lost the Session stream: socket hang up",
        catalogError: "ECONNRESET",
      }),
      ACTS,
      false,
    );

    expect(blocker?.message).toBe("Lost the Session stream: socket hang up");
    expect(blocker?.action?.label).toBe("Retry");
  });

  it("says a catalog refresh failed, and offers the place that re-asks it", () => {
    const blocker = sessionBlocker(
      blockerInput({ catalogError: "ECONNRESET", catalogState: "error" }),
      ACTS,
      false,
    );

    expect(blocker).toEqual({
      message: "Models unavailable",
      detail: "ECONNRESET",
      tone: "error",
      action: { label: "Settings", act: NO_OP },
    });
    // A card on screen is not a reason to hide it, but it IS a reason not to
    // add a second row about models to one.
    expect(sessionBlocker(blockerInput({ catalogError: "ECONNRESET" }), ACTS, true)).toBeNull();
  });

  it("stays quiet when a loading catalog has simply not answered yet", () => {
    expect(sessionBlocker(blockerInput({ catalogState: "loading" }), ACTS, false)).toBeNull();
    expect(sessionBlocker(blockerInput(), ACTS, false)).toBeNull();
  });

  it("carries the harness's own wording under every attention it draws", () => {
    expect(sessionBlocker(raised(attention("adapter_disconnected", "EPIPE")), ACTS, false)).toEqual(
      {
        message: "Disconnected",
        detail: "EPIPE",
        tone: "error",
        action: { label: "Retry", act: NO_OP },
      },
    );
  });

  it("answers every attention kind, and offers a button only where one can help", () => {
    const plain: PlainAttentionKind[] = [
      "auth_required",
      "configuration_invalid",
      "transport_retrying",
      "adapter_disconnected",
      "context_limit_reached",
      "partial_turn_interrupted",
      "adapter_unrecoverable",
      "input_required",
      "permission_required",
    ];
    const drawn = plain.map((kind) => {
      const blocker = sessionBlocker(raised(attention(kind)), ACTS, false);
      return [blocker?.message, blocker?.action?.label ?? null];
    });

    expect(drawn).toEqual([
      ["Sign-in required", "Settings"],
      ["Configuration invalid", "Settings"],
      ["Reconnecting", "Retry"],
      ["Disconnected", "Retry"],
      ["Context limit reached", null],
      ["Turn interrupted", null],
      ["Session stopped", "Retry"],
      ["Waiting for an answer", null],
      ["Waiting for approval", null],
    ]);
  });

  it("retries the run itself once the runtime has stopped retrying for you", () => {
    const acted: string[] = [];
    const acts: SessionBlockerActs = {
      ...ACTS,
      recover: () => acted.push("recover"),
      retryRuntime: () => acted.push("retryRuntime"),
    };
    const blocker = sessionBlocker(
      raised(attention("adapter_unrecoverable", "WebSocket closed 1006 (after 10 retries)")),
      acts,
      false,
    );

    expect(blocker).toMatchObject({
      message: "Session stopped",
      detail: "WebSocket closed 1006 (after 10 retries)",
      tone: "error",
      action: { label: "Retry" },
    });
    blocker?.action?.act();
    expect(acted).toEqual(["retryRuntime"]);
  });

  it("names the provider's own time where it sent one, and invents none where it did not", () => {
    const at = Date.UTC(2026, 0, 2, 15, 4);
    const clause = ` until ${new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;

    expect(sessionBlocker(raised(rateLimited(at)), ACTS, false)?.message).toBe(
      `Rate limited${clause}`,
    );
    expect(sessionBlocker(raised(rateLimited(null)), ACTS, false)).toEqual({
      message: "Rate limited",
      detail: null,
      tone: "waiting",
      action: { label: "Retry", act: NO_OP },
    });
    expect(sessionBlocker(raised(quotaSpent(at)), ACTS, false)?.message).toBe(
      `Quota exhausted${clause}`,
    );
    expect(sessionBlocker(raised(quotaSpent(Number.NaN)), ACTS, false)?.message).toBe(
      "Quota exhausted",
    );
  });
});

describe("terminalCompanionTabId", () => {
  it("opens the user's active existing tab, with the newest tab as a defensive fallback", () => {
    expect(
      terminalCompanionTabId({
        activeSessionId: "terminal-1",
        tabs: [{ sessionId: "terminal-1" }, { sessionId: "terminal-2" }],
      }),
    ).toBe("terminal-1");
    expect(
      terminalCompanionTabId({
        activeSessionId: null,
        tabs: [{ sessionId: "terminal-1" }, { sessionId: "terminal-2" }],
      }),
    ).toBe("terminal-2");
    expect(terminalCompanionTabId(undefined)).toBeNull();
  });
});

describe("answerInteraction", () => {
  it("sends the redirection once the refusal has landed", async () => {
    const acts = recorder(true);

    await answerInteraction(
      "permission:1",
      { resolution: REFUSAL, message: "run the tests" },
      acts.acts,
    );

    expect(acts.delivered).toEqual(["run the tests"]);
  });

  it("keeps the redirection to itself when the decision never reached the harness", async () => {
    const acts = recorder(false);

    await answerInteraction(
      "permission:1",
      { resolution: REFUSAL, message: "run the tests" },
      acts.acts,
    );

    expect(acts.delivered).toEqual([]);
  });

  it("marks only its own card, and clears it however the round trip ends", async () => {
    const landed = recorder(true);
    const failed = recorder(false);

    await answerInteraction("permission:1", { resolution: REFUSAL, message: null }, landed.acts);
    await answerInteraction("permission:2", { resolution: REFUSAL, message: null }, failed.acts);

    expect(landed.flags).toEqual([
      ["permission:1", true],
      ["permission:1", false],
    ]);
    expect(failed.flags).toEqual([
      ["permission:2", true],
      ["permission:2", false],
    ]);
  });

  it("resolves the interaction it was given, with the submission's own resolution", async () => {
    const seen: [string, SessionInteractionResolution][] = [];

    await answerInteraction(
      "question:7",
      { resolution: REFUSAL, message: null },
      {
        resolve: (interactionId, resolution) => {
          seen.push([interactionId, resolution]);
          return Promise.resolve(true);
        },
        deliver: NO_OP,
        resolving: NO_OP,
      },
    );

    expect(seen).toEqual([["question:7", REFUSAL]]);
  });
});

describe("withdrawInteraction", () => {
  /** The card's controls, including Cancel request, share this in-flight latch. */
  it("holds the card's own in-flight latch for the whole round trip", async () => {
    const flags: [string, boolean][] = [];
    const acts: string[] = [];

    await withdrawInteraction("permission:1", {
      interrupt: () => {
        acts.push("interrupt");
        return Promise.resolve(true);
      },
      cancel: (interactionId) => {
        expect(flags).toEqual([["permission:1", true]]);
        acts.push(`cancel:${interactionId}`);
        return Promise.resolve(true);
      },
      resolving: (id, active) => flags.push([id, active]),
    });

    expect(acts).toEqual(["interrupt", "cancel:permission:1"]);
    expect(flags).toEqual([
      ["permission:1", true],
      ["permission:1", false],
    ]);
  });

  it("gives the card back however the round trip ends", async () => {
    const flags: [string, boolean][] = [];

    await expect(
      withdrawInteraction("permission:1", {
        interrupt: () => Promise.reject(new Error("socket hang up")),
        cancel: () => Promise.resolve(true),
        resolving: (id, active) => flags.push([id, active]),
      }),
    ).rejects.toThrow("socket hang up");

    expect(flags).toEqual([
      ["permission:1", true],
      ["permission:1", false],
    ]);
  });
});

describe("resolvingWith", () => {
  it("answers one card without disabling the others", () => {
    const resolving = resolvingWith(new Set(["permission:1"]), "permission:2", true);

    expect([...resolving]).toEqual(["permission:1", "permission:2"]);
    expect([...resolvingWith(resolving, "permission:1", false)]).toEqual(["permission:2"]);
  });

  it("leaves the set it was given alone", () => {
    const current: ReadonlySet<string> = new Set(["permission:1"]);

    resolvingWith(current, "permission:2", true);

    expect([...current]).toEqual(["permission:1"]);
  });
});

function askPrompt(overrides: Partial<SessionInteractionPrompt> = {}): SessionInteractionPrompt {
  return {
    id: "prompt:0",
    label: "Which branch should this land on?",
    detail: null,
    options: [{ id: "question:0:bWFpbg", label: "main", description: null }],
    multiple: false,
    custom: true,
    ...overrides,
  };
}

/** A model's own question: encoded ids, so none of them can read as a declared no. */
function ask(prompts: readonly SessionInteractionPrompt[]): RendererSessionInteraction {
  return {
    id: "ask-user:call-7",
    attachmentId: "attach-1",
    kind: "question",
    title: "Which branch should this land on?",
    detail: null,
    options: prompts.flatMap((prompt) => prompt.options),
    multiple: false,
    prompts,
    native: { id: null, detail: null },
  };
}

describe("composerPress", () => {
  it("answers the open question with what was typed, under that question's id", () => {
    // The dead end this closes: a press here used to be a message, and a
    // message typed at a blocked turn joins a queue that only an idle Session
    // drains — which this one cannot become until the question is answered.
    expect(composerPress(ask([askPrompt()]), "the release branch")).toEqual({
      kind: "answer",
      interactionId: "ask-user:call-7",
      submission: {
        resolution: {
          optionIds: [],
          response: "the release branch",
          answers: [{ promptId: "prompt:0", optionIds: [], response: "the release branch" }],
        },
        message: null,
      },
    });
  });

  it("is an ordinary message while nothing is being asked", () => {
    expect(composerPress(null, "ship it")).toEqual({ kind: "message" });
  });

  it("is an ordinary message wherever the request cannot take the words", () => {
    // The rule and its reasons are `composerAnswer`'s; what is pinned here is
    // that a press it refuses is never dropped — it falls back to the road it
    // has always taken.
    expect(composerPress(ask([askPrompt({ custom: false })]), "neither")).toEqual({
      kind: "message",
    });
    expect(composerPress(ask([askPrompt()]), "   ")).toEqual({ kind: "message" });
  });
});

describe("messageRoute", () => {
  it("holds anything typed before there is somewhere to send it", () => {
    expect(messageRoute("send", false)).toBe("hold");
    expect(messageRoute("steer", false)).toBe("hold");
  });

  it("holds what the composer queued on purpose", () => {
    expect(messageRoute("queue", true)).toBe("hold");
  });

  it("sends when the Session can take it", () => {
    expect(messageRoute("send", true)).toBe("send");
    expect(messageRoute("steer", true)).toBe("send");
  });
});

describe("messageCopyText", () => {
  it("keeps every visible text part in feed order", () => {
    const messages: readonly UIMessage[] = [
      {
        id: "user-1",
        role: "user",
        parts: [
          { type: "text", text: "Rewrite this prompt." },
          { type: "text", text: "Keep the examples." },
        ],
      },
      {
        id: "assistant-1",
        role: "assistant",
        parts: [{ type: "text", text: "Here is a tighter version." }],
      },
    ];

    expect(messageCopyText(messages)).toBe(
      "Rewrite this prompt.\n\nKeep the examples.\n\nHere is a tighter version.",
    );
  });

  it("offers no copy for a feed row with no message text", () => {
    const messages: readonly UIMessage[] = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          { type: "reasoning", text: "Private reasoning", state: "done" },
          { type: "text", text: "" },
        ],
      },
    ];

    expect(messageCopyText(messages)).toBeNull();
  });
});

describe("dispatchHeldMessage", () => {
  it("does not deliver direct typing until its held copy is durable", async () => {
    let acknowledge!: (durable: boolean) => void;
    const events: string[] = [];
    const drafts = createChatDraftsStore({
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    });
    drafts.getState().holdMessage("s1", { id: "m1", text: "ship it" });
    const dispatching = dispatchHeldMessage({
      persist: async () => {
        expect(drafts.getState().drafts.s1?.held).toEqual([
          heldMessage("m1", "ship it", "sending"),
        ]);
        events.push("persist");
        return new Promise<boolean>((resolve) => {
          acknowledge = resolve;
        });
      },
      deliver: async () => {
        events.push("deliver");
        return "delivered";
      },
      finish: async (outcome) => {
        events.push(`finish:${outcome}`);
      },
    });
    await Promise.resolve();
    const beforeAcknowledgement = [...events];
    acknowledge(true);

    await expect(dispatching).resolves.toBe("delivered");
    expect(beforeAcknowledgement).toEqual(["persist"]);
    expect(events).toEqual(["persist", "deliver", "finish:delivered"]);
  });

  it("keeps the held copy unsent when its durability barrier is refused", async () => {
    const events: string[] = [];

    await expect(
      dispatchHeldMessage({
        persist: async () => false,
        deliver: async () => {
          events.push("deliver");
          return "delivered";
        },
        finish: async (outcome) => {
          events.push(`finish:${outcome}`);
        },
      }),
    ).resolves.toBe("refused");

    expect(events).toEqual(["finish:refused"]);
  });

  it("restores the held copy when delivery rejects unexpectedly", async () => {
    const events: string[] = [];

    await expect(
      dispatchHeldMessage({
        persist: async () => true,
        deliver: async () => {
          throw new Error("unexpected delivery failure");
        },
        finish: async (outcome) => {
          events.push(`finish:${outcome}`);
        },
      }),
    ).resolves.toBe("refused");

    expect(events).toEqual(["finish:refused"]);
  });
});

describe("coordinateQueuedMutation", () => {
  it("refuses to mutate a queue row already owned by resident delivery", () => {
    const events: string[] = [];

    expect(
      coordinateQueuedMutation({
        queueBacked: true,
        claim: () => (events.push("claim"), false),
        consumeClaim: () => (events.push("consume"), true),
        releaseClaim: () => events.push("release"),
        dropHeld: () => events.push("drop"),
      }),
    ).toBe(false);
    expect(events).toEqual(["claim"]);
  });

  it("atomically consumes an unclaimed queue row before dropping its held copy", () => {
    const events: string[] = [];

    expect(
      coordinateQueuedMutation({
        queueBacked: true,
        claim: () => (events.push("claim"), true),
        consumeClaim: () => (events.push("consume"), true),
        releaseClaim: () => events.push("release"),
        dropHeld: () => events.push("drop"),
      }),
    ).toBe(true);
    expect(events).toEqual(["claim", "consume", "drop"]);
  });

  it("releases a claim when its queue row vanished before consumption", () => {
    const events: string[] = [];

    expect(
      coordinateQueuedMutation({
        queueBacked: true,
        claim: () => true,
        consumeClaim: () => false,
        releaseClaim: () => events.push("release"),
        dropHeld: () => events.push("drop"),
      }),
    ).toBe(false);
    expect(events).toEqual(["release"]);
  });

  it("drops a held-only row without touching the resident queue", () => {
    const events: string[] = [];

    expect(
      coordinateQueuedMutation({
        queueBacked: false,
        claim: () => (events.push("claim"), false),
        consumeClaim: () => (events.push("consume"), false),
        releaseClaim: () => events.push("release"),
        dropHeld: () => events.push("drop"),
      }),
    ).toBe(true);
    expect(events).toEqual(["drop"]);
  });
});

describe("steerQueuedMessage", () => {
  it("restores queue-backed targets as queued and held-only targets as unsent", () => {
    expect(steerRollbackState(true, "unsent")).toBe("queued");
    expect(steerRollbackState(false, "unsent")).toBe("unsent");
    expect(steerRollbackState(false, undefined)).toBe("unsent");
  });

  it("refuses to steer a new working turn that replaced the one the user targeted", () => {
    expect(steerTurnIsCurrent(4, { turnEpoch: 5, working: true, deliverable: true })).toBe(false);
    expect(steerTurnIsCurrent(4, { turnEpoch: 4, working: true, deliverable: true })).toBe(true);
    expect(steerTurnIsCurrent(undefined, { turnEpoch: 4, working: true, deliverable: true })).toBe(
      false,
    );
    expect(steerTurnIsCurrent(4, undefined)).toBe(false);
    expect(steerTurnIsCurrent(4, { turnEpoch: 4, working: false, deliverable: true })).toBe(false);
    expect(steerTurnIsCurrent(4, { turnEpoch: 4, working: true, deliverable: false })).toBe(false);
  });

  it("leaves source state untouched when the resident target cannot be claimed", async () => {
    const events: string[] = [];
    const outcome = await coordinateQueuedSteerStart(4, {
      queueBacked: true,
      claim: () => (events.push("claim"), false),
      persist: async () => (events.push("persist"), true),
      current: () => ({ turnEpoch: 4, working: true, deliverable: true }),
      consumeClaim: () => (events.push("consume"), true),
      restore: async () => {
        events.push("restore");
      },
      releaseClaim: () => {
        events.push("release");
      },
    });

    expect(outcome).toBe("stale");
    expect(events).toEqual(["claim"]);
  });

  it("restores and releases a queue claim when durability is refused", async () => {
    const events: string[] = [];
    const outcome = await coordinateQueuedSteerStart(4, {
      queueBacked: true,
      claim: () => (events.push("claim"), true),
      persist: async () => (events.push("persist"), false),
      current: () => ({ turnEpoch: 4, working: true, deliverable: true }),
      consumeClaim: () => (events.push("consume"), true),
      restore: async () => {
        events.push("restore");
      },
      releaseClaim: () => {
        events.push("release");
      },
    });

    expect(outcome).toBe("refused");
    expect(events).toEqual(["claim", "persist", "restore", "release"]);
  });

  it("releases its queue claim even when persistence rejects", async () => {
    const events: string[] = [];
    const steering = coordinateQueuedSteerStart(4, {
      queueBacked: true,
      claim: () => (events.push("claim"), true),
      persist: async () => {
        events.push("persist");
        throw new Error("ipc gone");
      },
      current: () => ({ turnEpoch: 4, working: true, deliverable: true }),
      consumeClaim: () => true,
      restore: async () => {
        events.push("restore");
      },
      releaseClaim: () => {
        events.push("release");
      },
    });

    await expect(steering).rejects.toThrow("ipc gone");
    expect(events).toEqual(["claim", "persist", "restore", "release"]);
  });

  it("restores and releases when the targeted turn changed during persistence", async () => {
    const events: string[] = [];
    const outcome = await coordinateQueuedSteerStart(4, {
      queueBacked: true,
      claim: () => true,
      persist: () => Promise.resolve(true),
      current: () => ({ turnEpoch: 5, working: true, deliverable: true }),
      consumeClaim: () => (events.push("consume"), true),
      restore: async () => {
        events.push("restore");
      },
      releaseClaim: () => {
        events.push("release");
      },
    });

    expect(outcome).toBe("held");
    expect(events).toEqual(["restore", "release"]);
  });

  it("restores and releases when the claimed row vanished before consumption", async () => {
    const events: string[] = [];
    const outcome = await coordinateQueuedSteerStart(4, {
      queueBacked: true,
      claim: () => (events.push("claim"), true),
      persist: async () => (events.push("persist"), true),
      current: () => ({ turnEpoch: 4, working: true, deliverable: true }),
      consumeClaim: () => (events.push("consume"), false),
      restore: async () => {
        events.push("restore");
      },
      releaseClaim: () => {
        events.push("release");
      },
    });

    expect(outcome).toBe("stale");
    expect(events).toEqual(["claim", "persist", "consume", "restore", "release"]);
  });

  it("consumes a queue claim only after persistence and turn revalidation", async () => {
    const events: string[] = [];
    const outcome = await coordinateQueuedSteerStart(4, {
      queueBacked: true,
      claim: () => (events.push("claim"), true),
      persist: async () => (events.push("persist"), true),
      current: () => ({ turnEpoch: 4, working: true, deliverable: true }),
      consumeClaim: () => (events.push("consume"), true),
      restore: async () => {
        events.push("restore");
      },
      releaseClaim: () => {
        events.push("release");
      },
    });

    expect(outcome).toBe("started");
    expect(events).toEqual(["claim", "persist", "consume"]);
  });

  it("restores only once when restoration itself rejects", async () => {
    const events: string[] = [];
    const steering = coordinateQueuedSteerStart(4, {
      queueBacked: true,
      claim: () => true,
      persist: () => Promise.resolve(false),
      current: () => ({ turnEpoch: 4, working: true, deliverable: true }),
      consumeClaim: () => true,
      restore: async () => {
        events.push("restore");
        throw new Error("restore failed");
      },
      releaseClaim: () => {
        events.push("release");
      },
    });

    await expect(steering).rejects.toThrow("restore failed");
    expect(events).toEqual(["restore", "release"]);
  });

  it("starts a held-only target without claiming the resident queue", async () => {
    const events: string[] = [];
    const outcome = await coordinateQueuedSteerStart(4, {
      queueBacked: false,
      claim: () => (events.push("claim"), false),
      persist: async () => (events.push("persist"), true),
      current: () => ({ turnEpoch: 4, working: true, deliverable: true }),
      consumeClaim: () => (events.push("consume"), false),
      restore: async () => {
        events.push("restore");
      },
      releaseClaim: () => {
        events.push("release");
      },
    });

    expect(outcome).toBe("started");
    expect(events).toEqual(["persist"]);
  });

  it("waits for the held strip to become durable before dequeueing or submitting", async () => {
    let acknowledge!: (durable: boolean) => void;
    let queue = [{ id: "q1", text: "first" }];
    const events: string[] = [];
    const acts: QueuedSteerActs = {
      read: () => ({ held: [], queue, steerable: true }),
      start: async () => {
        events.push("persist");
        const durable = await new Promise<boolean>((resolve) => {
          acknowledge = resolve;
        });
        if (!durable) return "refused";
        queue = [];
        events.push("dequeue");
        return "started";
      },
      submit: () => {
        events.push("submit");
        return Promise.resolve("delivered");
      },
      finish: async () => {
        events.push("finish");
      },
    };

    const steering = steerQueuedMessage("q1", new Set(), acts);
    await Promise.resolve();
    const beforeAcknowledgement = [...events];
    const queueBeforeAcknowledgement = [...queue];
    acknowledge(true);

    await expect(steering).resolves.toBe("delivered");
    expect(beforeAcknowledgement).toEqual(["persist"]);
    expect(queueBeforeAcknowledgement).toEqual([{ id: "q1", text: "first" }]);
    expect(events).toEqual(["persist", "dequeue", "submit", "finish"]);
  });

  it("does not complete a delivered steer until held cleanup is durable", async () => {
    let acknowledgeCleanup!: () => void;
    let cleanupStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      cleanupStarted = resolve;
    });
    const acts: QueuedSteerActs = {
      read: () => ({
        held: [{ id: "q1", text: "first", state: "unsent" }],
        queue: [],
        steerable: true,
      }),
      start: () => Promise.resolve("started"),
      submit: () => Promise.resolve("delivered"),
      finish: async () => {
        cleanupStarted();
        await new Promise<void>((resolve) => {
          acknowledgeCleanup = resolve;
        });
      },
    };

    const steering = steerQueuedMessage("q1", new Set(), acts);
    let settled = false;
    void steering.then(() => {
      settled = true;
    });
    await started;
    await Promise.resolve();
    const settledBeforeCleanup = settled;
    acknowledgeCleanup();

    await expect(steering).resolves.toBe("delivered");
    expect(settledBeforeCleanup).toBe(false);
  });

  it("keeps the release queue and refuses submission when durability fails", async () => {
    const queue = [{ id: "q1", text: "first" }];
    const events: string[] = [];
    const acts: QueuedSteerActs = {
      read: () => ({ held: [], queue, steerable: true }),
      start: async () => {
        events.push("persist:refused");
        return "refused";
      },
      submit: () => {
        events.push("submit");
        return Promise.resolve("delivered");
      },
      finish: async (id, outcome) => {
        events.push(`finish:${id}:${outcome}`);
      },
    };

    await expect(steerQueuedMessage("q1", new Set(), acts)).resolves.toBe("refused");

    expect(queue).toEqual([{ id: "q1", text: "first" }]);
    expect(events).toEqual(["persist:refused"]);
  });

  it("persists the ordered strip before dequeueing and submitting", async () => {
    const state = steerHarness({
      held: [heldMessage("q1", "first", "queued")],
      queue: [{ id: "q1", text: "first" }],
      submit: (message, delivery) => {
        expect(message).toEqual({ id: "q1", text: "first" });
        expect(delivery).toBe("steer");
        expect(state.held()).toEqual([heldMessage("q1", "first", "sending")]);
        expect(state.queue()).toEqual([]);
        return Promise.resolve("delivered");
      },
    });

    await expect(steerQueuedMessage("q1", new Set(), state.acts)).resolves.toBe("delivered");

    expect(state.held()).toEqual([]);
    expect(state.events).toEqual(["start:q1:q1", "submit:q1:steer", "finish:q1:delivered"]);
  });

  // The other half of the strip's VC-49 round trip: `heldStrip` keeps a held
  // row's skill resources, and this pins that a steer's rebuilt submit row
  // carries them too — a `/skill` message queued behind a live turn delivers
  // what it resolved to at ⏎, not bare text.
  it("hands a held row's skill resources to submit when steered", async () => {
    const resources = [{ name: "logos", text: "# Logos" }];
    const state = steerHarness({
      held: [{ ...heldMessage("q1", "/logos go", "unsent"), resources }],
      submit: (message, delivery) => {
        expect(message).toEqual({ id: "q1", text: "/logos go", resources });
        expect(delivery).toBe("steer");
        return Promise.resolve("delivered");
      },
    });

    await expect(steerQueuedMessage("q1", new Set(), state.acts)).resolves.toBe("delivered");

    expect(state.held()).toEqual([]);
    expect(state.events).toEqual(["start:q1:q1", "submit:q1:steer", "finish:q1:delivered"]);
  });

  it("restores a refused queue-only row between its original neighbors", async () => {
    const state = steerHarness({
      queue: [
        { id: "q1", text: "first" },
        { id: "q2", text: "second" },
        { id: "q3", text: "third" },
      ],
      submit: () => Promise.resolve("refused"),
    });

    await expect(steerQueuedMessage("q2", new Set(), state.acts)).resolves.toBe("refused");

    expect(state.held()).toEqual([
      heldMessage("q1", "first", "queued"),
      heldMessage("q2", "second", "unsent"),
      heldMessage("q3", "third", "queued"),
    ]);
    expect(state.strip().map((message) => message.id)).toEqual(["q1", "q2", "q3"]);
    expect(new Set(state.strip().map((message) => message.id)).size).toBe(3);
  });

  it.each(["delivered", "recorded"] satisfies readonly QueuedSteerDelivery[])(
    "retires only the queue-only target after a %s steer",
    async (outcome) => {
      const state = steerHarness({
        queue: [
          { id: "q1", text: "first" },
          { id: "q2", text: "second" },
          { id: "q3", text: "third" },
        ],
        submit: () => Promise.resolve(outcome),
      });

      await expect(steerQueuedMessage("q2", new Set(), state.acts)).resolves.toBe(outcome);

      expect(state.strip().map((message) => message.id)).toEqual(["q1", "q3"]);
      expect(state.held()).toEqual([
        heldMessage("q1", "first", "queued"),
        heldMessage("q3", "third", "queued"),
      ]);
    },
  );

  it("leaves a queue-only source untouched when the Session is no longer steerable", async () => {
    const state = steerHarness({
      queue: [
        { id: "q1", text: "first" },
        { id: "q2", text: "second" },
      ],
      steerable: false,
    });

    await expect(steerQueuedMessage("q1", new Set(), state.acts)).resolves.toBe("held");

    expect(state.held()).toEqual([]);
    expect(state.queue().map((message) => message.id)).toEqual(["q1", "q2"]);
    expect(state.events).toEqual([]);
  });

  it("leaves a held-only source untouched when the Session is no longer steerable", async () => {
    const state = steerHarness({
      held: [heldMessage("q1", "first", "unsent")],
      steerable: false,
    });

    await expect(steerQueuedMessage("q1", new Set(), state.acts)).resolves.toBe("held");

    expect(state.held()).toEqual([heldMessage("q1", "first", "unsent")]);
    expect(state.queue()).toEqual([]);
    expect(state.events).toEqual([]);
  });

  it("ignores a repeated steer while the first click owns the queue-only id", async () => {
    let settle!: (outcome: "recorded") => void;
    let submissions = 0;
    const state = steerHarness({
      queue: [
        { id: "q1", text: "first" },
        { id: "q2", text: "second" },
        { id: "q3", text: "third" },
      ],
      submit: () => {
        submissions += 1;
        return new Promise<"recorded">((resolve) => {
          settle = resolve;
        });
      },
    });
    const inFlight = new Set<string>();

    const first = steerQueuedMessage("q2", inFlight, state.acts);
    await expect(steerQueuedMessage("q2", inFlight, state.acts)).resolves.toBe("stale");

    expect(submissions).toBe(1);
    expect(state.strip().map((message) => message.id)).toEqual(["q1", "q3"]);
    settle("recorded");
    await expect(first).resolves.toBe("recorded");
    expect(state.strip().map((message) => message.id)).toEqual(["q1", "q3"]);
  });

  it("retries a held-only row without moving either neighbor", async () => {
    const state = steerHarness({
      held: [
        heldMessage("q1", "first", "unsent"),
        heldMessage("q2", "second", "unsent"),
        heldMessage("q3", "third", "unsent"),
      ],
    });

    await expect(steerQueuedMessage("q2", new Set(), state.acts)).resolves.toBe("delivered");

    expect(state.strip().map((message) => message.id)).toEqual(["q1", "q3"]);
    expect(state.events).toEqual(["start:q1,q2,q3:q2", "submit:q2:steer", "finish:q2:delivered"]);
  });

  it("leaves a missing, already-sending, or already-released row untouched as stale", async () => {
    const states = [
      steerHarness(),
      steerHarness({ held: [heldMessage("q1", "first", "sending")] }),
      steerHarness({ held: [heldMessage("q1", "first", "queued")] }),
    ];

    await expect(steerQueuedMessage("q1", new Set(), states[0]!.acts)).resolves.toBe("stale");
    await expect(steerQueuedMessage("q1", new Set(), states[1]!.acts)).resolves.toBe("stale");
    await expect(steerQueuedMessage("q1", new Set(), states[2]!.acts)).resolves.toBe("stale");
    expect(states.flatMap((state) => state.events)).toEqual([]);
  });
});

/* -------------------------------------------------------------- identity */

function assistantMessage(id: string, text: string): UIMessage {
  return { id, role: "assistant", parts: [{ type: "text", text }] };
}

describe("holdList", () => {
  /**
   * The whole of the transcript's frame budget, stated as a count. Every turn
   * arrives in a new array on every frame batch, so without this each of them is
   * a new prop and each of them re-segments and repaints.
   */
  it("hands back every turn but the one the token landed in", () => {
    const settled = [assistantMessage("m1", "one"), assistantMessage("m2", "two")];
    const live = assistantMessage("m3", "thin");
    const previous = [[settled[0]!], [settled[1]!], [live]];
    const next = [[settled[0]!], [settled[1]!], [assistantMessage("m3", "thinking")]];

    const held = holdList(previous, next, sameMessages);

    expect(held[0]).toBe(previous[0]);
    expect(held[1]).toBe(previous[1]);
    expect(held[2]).toBe(next[2]);
    expect(held.filter((turn, index) => turn !== previous[index])).toHaveLength(1);
  });

  it("keeps the list itself when nothing in it moved", () => {
    const previous = [[assistantMessage("m1", "one")]];

    expect(holdList(previous, [[...previous[0]!]], sameMessages)).toBe(previous);
  });

  it("gives up the list the moment a turn is added", () => {
    const previous = [[assistantMessage("m1", "one")]];
    const next = [[...previous[0]!], [assistantMessage("m2", "two")]];

    const held = holdList(previous, next, sameMessages);

    expect(held).not.toBe(previous);
    expect(held[0]).toBe(previous[0]);
    expect(held[1]).toBe(next[1]);
  });

  it("takes the shorter list rather than holding a row that is gone", () => {
    const previous = [[assistantMessage("m1", "one")], [assistantMessage("m2", "two")]];

    expect(holdList(previous, [previous[0]!], sameMessages)).toEqual([previous[0]]);
  });
});

describe("sameMessages", () => {
  it("reads a re-emitted message as a change and a settled one as none", () => {
    const settled = assistantMessage("m1", "one");
    const streaming = assistantMessage("m2", "thin");

    expect(sameMessages([settled, streaming], [settled, streaming])).toBe(true);
    expect(sameMessages([settled, streaming], [settled, assistantMessage("m2", "thinking")])).toBe(
      false,
    );
    expect(sameMessages([settled], [settled, streaming])).toBe(false);
  });
});

describe("heldStrip", () => {
  it("draws one row for a message both records name", () => {
    expect(
      heldStrip([heldMessage("m1", "ship it", "queued")], [{ id: "m1", text: "ship it" }]),
    ).toEqual([{ id: "m1", text: "ship it" }]);
  });

  // The transcript is already showing it. A second copy under the composer
  // reads as a message that failed to leave.
  it("draws nothing for a message with a round trip still open on it", () => {
    expect(heldStrip([heldMessage("m1", "ship it", "sending")], [])).toEqual([]);
    expect(
      heldStrip([heldMessage("m1", "ship it", "sending")], [{ id: "m1", text: "ship it" }]),
    ).toEqual([]);
  });

  // A crash between the box emptying and anything accepting the words. The
  // whole point of persisting them is that they come back as their own message
  // rather than welded onto whatever was typed next.
  it("draws a message nothing took, in its own row", () => {
    expect(heldStrip([heldMessage("m1", "ship it", "unsent")], [])).toEqual([
      { id: "m1", text: "ship it" },
    ]);
  });

  it("exposes no retained row before the initial Session projection is reconciled", () => {
    const held = [heldMessage("m1", "already accepted", "unsent")];

    expect(hasReconciledSessionSnapshot(undefined)).toBe(false);
    expect(hasReconciledSessionSnapshot(null)).toBe(false);
    expect(hasReconciledSessionSnapshot({ id: "session" })).toBe(true);
    expect(heldStrip(held, [], new Set(), hasReconciledSessionSnapshot(undefined))).toEqual([]);
    expect(heldStrip(held, [], new Set(), hasReconciledSessionSnapshot({ id: "session" }))).toEqual(
      [{ id: "m1", text: "already accepted" }],
    );
  });

  it("keeps a queued message no held copy names — a card's redirection", () => {
    expect(
      heldStrip(
        [heldMessage("m1", "one", "queued")],
        [
          { id: "m1", text: "one" },
          { id: "m2", text: "two" },
        ],
      ),
    ).toEqual([
      { id: "m1", text: "one" },
      { id: "m2", text: "two" },
    ]);
  });

  // The row is also what `beginQueuedSteer` persists back, so a skill body
  // riding the held copy must survive the strip round trip (VC-49).
  it("keeps a held row's skill resources on its strip row", () => {
    const resources = [{ name: "logos", text: "# Logos" }];
    expect(heldStrip([{ ...heldMessage("m1", "/logos go", "unsent"), resources }], [])).toEqual([
      { id: "m1", text: "/logos go", resources },
    ]);
  });
});

describe("settledHeldIds", () => {
  it("hides and retires a crash-held retry once the durable transcript has the same id", () => {
    const held = [heldMessage("q1", "steer once", "unsent")];
    const durableMessageIds = new Set(["q1"]);

    expect(heldStrip(held, [], durableMessageIds)).toEqual([]);
    expect(settledHeldIds(held, [], durableMessageIds)).toEqual(["q1"]);
  });

  it("retires the copy once the release queue has let go of it", () => {
    expect(settledHeldIds([heldMessage("m1", "ship it", "queued")], [])).toEqual(["m1"]);
  });

  it("keeps the copy while the queue still names it", () => {
    expect(
      settledHeldIds([heldMessage("m1", "ship it", "queued")], [{ id: "m1", text: "ship it" }]),
    ).toEqual([]);
  });

  it("leaves alone what the queue never had", () => {
    expect(
      settledHeldIds([heldMessage("m1", "one", "sending"), heldMessage("m2", "two", "unsent")], []),
    ).toEqual([]);
  });
});

describe("sameInteractionId", () => {
  it("reads an interaction re-projected under the same id as the one it already had", () => {
    const opened = {
      id: "permission:1",
      title: "Run tests?",
      detail: null,
    } as unknown as Parameters<typeof sameInteractionId>[0];
    const again = { ...opened };
    const other = { ...opened, id: "permission:2" };

    expect(sameInteractionId(opened, again)).toBe(true);
    expect(sameInteractionId(opened, other)).toBe(false);
  });
});

describe("sameQueuedMessage", () => {
  it("reads two freshly built rows for the same message as the same row", () => {
    const row = { id: "m1", text: "ship it" };

    expect(sameQueuedMessage(row, { ...row })).toBe(true);
  });

  it("separates a row whose text was edited, and one that is a different message", () => {
    const row = { id: "m1", text: "ship it" };

    expect(sameQueuedMessage(row, { id: "m1", text: "ship it now" })).toBe(false);
    expect(sameQueuedMessage(row, { id: "m2", text: "ship it" })).toBe(false);
  });

  it("separates rows whose resolved skill resources differ, and holds a shared list", () => {
    const resources = [{ name: "logos", text: "# Logos" }];
    const row = { id: "m1", text: "/logos go", resources };

    // The strip reuses the stored array, so identity is the honest comparison.
    expect(sameQueuedMessage(row, { ...row })).toBe(true);
    expect(sameQueuedMessage(row, { ...row, resources: [...resources] })).toBe(false);
    expect(sameQueuedMessage(row, { id: "m1", text: "/logos go" })).toBe(false);
  });

  it("holds a strip's identity across a rebuild that changed nothing", () => {
    // The whole point of the predicate: `heldStrip` mints new row objects on
    // every flush of a live turn, and the composer's memo compares by identity.
    const strip = [
      { id: "m1", text: "ship it" },
      { id: "m2", text: "then rest" },
    ];
    const rebuilt = strip.map((entry) => ({ ...entry }));

    expect(holdList(strip, rebuilt, sameQueuedMessage)).toBe(strip);
  });
});
