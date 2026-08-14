import type {
  AuthInteraction,
  AuthType,
  Credential,
  Models,
  Provider,
  ProviderAuth,
} from "@earendil-works/pi-ai";
import type {
  ModelAccessSignInEvent,
  ModelAccessSignInPrompt,
  ModelAccessSignInType,
} from "@volli/shared";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  piAuthType,
  piSignIn,
  providerSignInMethods,
  toSignInEvent,
  toSignInPrompt,
  type PiSignInSteps,
} from "./sign-in";

// --- fixtures --------------------------------------------------------------
//
// Nothing here reaches pi-ai's real providers: every `Provider` is the two
// fields these functions read, and every `Models` is the three members the port
// actually calls. A real collection would drag a credential file and a network
// in behind it to answer questions this module does not ask.

function providerWith(auth: ProviderAuth): Provider {
  return { id: "example", name: "Example", auth } as unknown as Provider;
}

/** An api-key method with an interactive first step — the non-ambient kind. */
const API_KEY_WITH_LOGIN: ProviderAuth["apiKey"] = {
  name: "Example API key",
  login: async () => ({ type: "api_key", key: "unused" }),
  resolve: async () => undefined,
};

/** pi-ai's "Absent = ambient-only": a key read from the environment, never asked for. */
const API_KEY_AMBIENT_ONLY: ProviderAuth["apiKey"] = {
  name: "Example ambient key",
  resolve: async () => undefined,
};

function oauthAuth(
  overrides: Partial<NonNullable<ProviderAuth["oauth"]>> = {},
): ProviderAuth["oauth"] {
  return {
    name: "Example (OAuth)",
    login: async () => ({ type: "oauth", access: "a", refresh: "r", expires: 0 }),
    refresh: async (credential) => credential,
    toAuth: async () => ({}),
    ...overrides,
  };
}

interface FakeModels {
  models: Models;
  login: ReturnType<typeof vi.fn>;
  logout: ReturnType<typeof vi.fn>;
}

/**
 * A collection that knows exactly one provider and whose `login` is whatever the
 * test scripted. `getProvider` answers by id so the unknown-provider path is
 * reachable without inventing a second collection.
 */
function fakeModels(
  provider: Provider | undefined,
  runLogin: (interaction: AuthInteraction) => Promise<Credential> = async () => ({
    type: "api_key",
    key: "stored-by-pi",
  }),
): FakeModels {
  const login = vi.fn(async (_providerId: string, _type: AuthType, interaction: AuthInteraction) =>
    runLogin(interaction),
  );
  const logout = vi.fn(async (_providerId: string) => undefined);
  const models = {
    getProvider: (id: string) => (provider?.id === id ? provider : undefined),
    login,
    logout,
  } as unknown as Models;
  return { models, login, logout };
}

interface Transcript {
  steps: PiSignInSteps;
  asked: { prompt: ModelAccessSignInPrompt; withdrawn: AbortSignal | undefined }[];
  said: ModelAccessSignInEvent[];
}

/** The driver side of the inversion: Volli's vocabulary in, ids the test can read. */
function transcript(answer: (prompt: ModelAccessSignInPrompt) => Promise<string>): Transcript {
  const asked: Transcript["asked"] = [];
  const said: ModelAccessSignInEvent[] = [];
  let next = 0;
  return {
    asked,
    said,
    steps: {
      newId: () => `prompt-${++next}`,
      ask: async (prompt, withdrawn) => {
        asked.push({ prompt, withdrawn });
        return answer(prompt);
      },
      say: (event) => {
        said.push(event);
      },
    },
  };
}

// --- tests -----------------------------------------------------------------

describe("piAuthType", () => {
  it.each([
    ["api-key" as const, "api_key" as const],
    ["oauth" as const, "oauth" as const],
  ])("spells Volli's %s as Pi's %s", (volli: ModelAccessSignInType, pi: AuthType) => {
    expect(piAuthType(volli)).toBe(pi);
  });
});

describe("toSignInPrompt", () => {
  it("carries a text step's placeholder through and offers no options", () => {
    expect(
      toSignInPrompt("p-1", { type: "text", message: "Account id", placeholder: "acct_…" }),
    ).toEqual({
      promptId: "p-1",
      kind: "text",
      message: "Account id",
      placeholder: "acct_…",
      options: [],
    });
  });

  it("reports an absent placeholder as null rather than leaving the field undefined", () => {
    expect(toSignInPrompt("p-1", { type: "text", message: "Account id" })).toEqual({
      promptId: "p-1",
      kind: "text",
      message: "Account id",
      placeholder: null,
      options: [],
    });
  });

  it("keeps a secret step a secret step, which is what decides masking downstream", () => {
    expect(
      toSignInPrompt("p-2", { type: "secret", message: "API key", placeholder: "sk-…" }),
    ).toEqual({
      promptId: "p-2",
      kind: "secret",
      message: "API key",
      placeholder: "sk-…",
      options: [],
    });
  });

  it("renames Pi's manual_code to Volli's manual-code and nothing else", () => {
    expect(
      toSignInPrompt("p-3", {
        type: "manual_code",
        message: "Paste the code from the browser",
        placeholder: "code",
      }),
    ).toEqual({
      promptId: "p-3",
      kind: "manual-code",
      message: "Paste the code from the browser",
      placeholder: "code",
      options: [],
    });
    expect(
      toSignInPrompt("p-3", { type: "manual_code", message: "Paste it" }).placeholder,
    ).toBeNull();
  });

  it("maps a select step's options and calls an option with no description null", () => {
    expect(
      toSignInPrompt("p-4", {
        type: "select",
        message: "Which project?",
        options: [
          { id: "alpha", label: "Alpha", description: "The one with billing" },
          { id: "beta", label: "Beta" },
        ],
      }),
    ).toEqual({
      promptId: "p-4",
      kind: "select",
      message: "Which project?",
      // A menu has nothing to place-hold: the choices are the field.
      placeholder: null,
      options: [
        { id: "alpha", label: "Alpha", description: "The one with billing" },
        { id: "beta", label: "Beta", description: null },
      ],
    });
  });
});

describe("toSignInEvent", () => {
  it("carries an info step's links, labelling an unlabelled one null", () => {
    expect(
      toSignInEvent({
        type: "info",
        message: "Create a key first.",
        links: [
          { url: "https://console.example/keys", label: "API keys" },
          { url: "https://example.invalid/docs" },
        ],
      }),
    ).toEqual({
      kind: "info",
      message: "Create a key first.",
      links: [
        { url: "https://console.example/keys", label: "API keys" },
        { url: "https://example.invalid/docs", label: null },
      ],
    });
  });

  it("reports an info step with no links as an empty list rather than a missing one", () => {
    expect(toSignInEvent({ type: "info", message: "Working." })).toEqual({
      kind: "info",
      message: "Working.",
      links: [],
    });
  });

  it("renames auth_url to auth-url and keeps its instructions optional", () => {
    expect(
      toSignInEvent({
        type: "auth_url",
        url: "https://auth.example/authorize",
        instructions: "Approve the request, then return here.",
      }),
    ).toEqual({
      kind: "auth-url",
      url: "https://auth.example/authorize",
      instructions: "Approve the request, then return here.",
    });
    expect(toSignInEvent({ type: "auth_url", url: "https://auth.example/authorize" })).toEqual({
      kind: "auth-url",
      url: "https://auth.example/authorize",
      instructions: null,
    });
  });

  it("renames device_code to device-code and nulls the timings a provider omits", () => {
    expect(
      toSignInEvent({
        type: "device_code",
        userCode: "WXYZ-1234",
        verificationUri: "https://example.invalid/device",
        intervalSeconds: 5,
        expiresInSeconds: 900,
      }),
    ).toEqual({
      kind: "device-code",
      userCode: "WXYZ-1234",
      verificationUri: "https://example.invalid/device",
      intervalSeconds: 5,
      expiresInSeconds: 900,
    });
    expect(
      toSignInEvent({
        type: "device_code",
        userCode: "WXYZ-1234",
        verificationUri: "https://example.invalid/device",
      }),
    ).toEqual({
      kind: "device-code",
      userCode: "WXYZ-1234",
      verificationUri: "https://example.invalid/device",
      intervalSeconds: null,
      expiresInSeconds: null,
    });
  });

  it("passes a progress step through as the one kind that spells the same in both", () => {
    expect(toSignInEvent({ type: "progress", message: "Exchanging the code…" })).toEqual({
      kind: "progress",
      message: "Exchanging the code…",
    });
  });
});

describe("providerSignInMethods", () => {
  it("advertises an api-key method under the provider's own name for the key", () => {
    expect(providerSignInMethods(providerWith({ apiKey: API_KEY_WITH_LOGIN }))).toEqual([
      { type: "api-key", label: "Example API key", isSubscription: false },
    ]);
  });

  it("advertises nothing for an ambient-only provider, which has no first step to open", () => {
    expect(providerSignInMethods(providerWith({ apiKey: API_KEY_AMBIENT_ONLY }))).toEqual([]);
  });

  it("prefers OAuth's selector label over its display name and reports a subscription", () => {
    expect(
      providerSignInMethods(
        providerWith({
          oauth: oauthAuth({
            name: "xAI (OAuth)",
            loginLabel: "Sign in with SuperGrok or X Premium",
            isSubscription: true,
          }),
        }),
      ),
    ).toEqual([
      { type: "oauth", label: "Sign in with SuperGrok or X Premium", isSubscription: true },
    ]);
  });

  it("falls back to the OAuth method's name and calls it a subscription only when it says so", () => {
    expect(providerSignInMethods(providerWith({ oauth: oauthAuth() }))).toEqual([
      { type: "oauth", label: "Example (OAuth)", isSubscription: false },
    ]);
    expect(
      providerSignInMethods(providerWith({ oauth: oauthAuth({ isSubscription: undefined }) })),
    ).toEqual([{ type: "oauth", label: "Example (OAuth)", isSubscription: false }]);
  });

  it("offers both methods, api-key first, when a provider takes either", () => {
    expect(
      providerSignInMethods(
        providerWith({
          apiKey: API_KEY_WITH_LOGIN,
          oauth: oauthAuth({ name: "Anthropic (Claude Pro/Max)", isSubscription: true }),
        }),
      ),
    ).toEqual([
      { type: "api-key", label: "Example API key", isSubscription: false },
      { type: "oauth", label: "Anthropic (Claude Pro/Max)", isSubscription: true },
    ]);
  });
});

describe("piSignIn", () => {
  it("offers nothing for a provider the collection does not know", () => {
    const { models } = fakeModels(undefined);
    expect(piSignIn(models).offers("example", "api-key")).toBe(false);
  });

  it("offers only the methods the provider actually advertises", () => {
    const { models } = fakeModels(providerWith({ apiKey: API_KEY_WITH_LOGIN }));
    const signIn = piSignIn(models);

    expect(signIn.offers("example", "api-key")).toBe(true);
    expect(signIn.offers("example", "oauth")).toBe(false);
  });

  it("offers nothing for the ambient-only provider it can describe but cannot log in", () => {
    const { models } = fakeModels(providerWith({ apiKey: API_KEY_AMBIENT_ONLY }));
    expect(piSignIn(models).offers("example", "api-key")).toBe(false);
  });

  it("drives Pi's login with the flow's own abort signal and Volli's translated steps", async () => {
    const attempt = new AbortController();
    const { models, login } = fakeModels(
      providerWith({ apiKey: API_KEY_WITH_LOGIN }),
      async (interaction) => {
        interaction.notify({ type: "progress", message: "Contacting the provider…" });
        const key = await interaction.prompt({ type: "secret", message: "API key" });
        interaction.notify({
          type: "device_code",
          userCode: "WXYZ-1234",
          verificationUri: "https://example.invalid/device",
        });
        const account = await interaction.prompt({
          type: "select",
          message: "Which account?",
          options: [{ id: "acct-1", label: "Primary" }],
        });
        return { type: "api_key", key: `${key}/${account}` };
      },
    );
    const driver = transcript(async (prompt) =>
      prompt.kind === "secret" ? "sk-live-answer" : "acct-1",
    );

    await piSignIn(models).login("example", "api-key", attempt.signal, driver.steps);

    // Pi's word for the method, Pi's signal, and Pi's callback bag — assembled
    // here so that nothing above this file ever names an `AuthInteraction`.
    expect(login).toHaveBeenCalledExactlyOnceWith("example", "api_key", {
      signal: attempt.signal,
      prompt: expect.any(Function),
      notify: expect.any(Function),
    });
    // Every question arrived translated, and each one carries an id minted by
    // the driver rather than derived from a prompt that has nothing unique in it.
    expect(driver.asked.map(({ prompt }) => prompt)).toEqual([
      {
        promptId: "prompt-1",
        kind: "secret",
        message: "API key",
        placeholder: null,
        options: [],
      },
      {
        promptId: "prompt-2",
        kind: "select",
        message: "Which account?",
        placeholder: null,
        options: [{ id: "acct-1", label: "Primary", description: null }],
      },
    ]);
    expect(driver.said).toEqual([
      { kind: "progress", message: "Contacting the provider…" },
      {
        kind: "device-code",
        userCode: "WXYZ-1234",
        verificationUri: "https://example.invalid/device",
        intervalSeconds: null,
        expiresInSeconds: null,
      },
    ]);
  });

  it("forwards the prompt's own signal, which is how a loopback callback retires its question", async () => {
    const withdrawn = new AbortController();
    const { models } = fakeModels(providerWith({ oauth: oauthAuth() }), async (interaction) => {
      await interaction.prompt({
        type: "manual_code",
        message: "Paste the code",
        signal: withdrawn.signal,
      });
      return { type: "oauth", access: "a", refresh: "r", expires: 0 };
    });
    const driver = transcript(async () => "pasted-code");

    await piSignIn(models).login("example", "oauth", new AbortController().signal, driver.steps);

    // The exact signal, not a copy: the driver has to hear the abort the flow
    // fires when the callback server answers first.
    expect(driver.asked[0]?.withdrawn).toBe(withdrawn.signal);
  });

  it("hands the driver no signal for a step the flow cannot take back", async () => {
    const { models } = fakeModels(
      providerWith({ apiKey: API_KEY_WITH_LOGIN }),
      async (interaction) => {
        await interaction.prompt({ type: "text", message: "Account id" });
        return { type: "api_key", key: "k" };
      },
    );
    const driver = transcript(async () => "acct-1");

    await piSignIn(models).login("example", "api-key", new AbortController().signal, driver.steps);

    expect(driver.asked[0]?.withdrawn).toBeUndefined();
  });

  it("resolves with nothing, dropping the credential Pi already persisted", async () => {
    const { models } = fakeModels(providerWith({ apiKey: API_KEY_WITH_LOGIN }), async () => ({
      type: "api_key",
      key: "sk-live-must-not-be-returned",
    }));
    const driver = transcript(async () => "unused");

    const returned = await piSignIn(models).login(
      "example",
      "api-key",
      new AbortController().signal,
      driver.steps,
    );

    expect(returned).toBeUndefined();
  });

  it("rejects with whatever the provider's flow rejected with", async () => {
    const { models } = fakeModels(providerWith({ oauth: oauthAuth() }), async () => {
      throw new Error("The authorization code has expired.");
    });
    const driver = transcript(async () => "unused");

    await expect(
      piSignIn(models).login("example", "oauth", new AbortController().signal, driver.steps),
    ).rejects.toThrow("The authorization code has expired.");
  });

  it("removes a stored credential through the same collection the runtime holds", async () => {
    const { models, logout } = fakeModels(providerWith({ apiKey: API_KEY_WITH_LOGIN }));

    await piSignIn(models).logout("example");

    expect(logout).toHaveBeenCalledExactlyOnceWith("example");
  });
});
