import { describe, expect, it } from "vite-plus/test";
import type {
  ModelAccessProvider,
  ModelAccessSignInEvent,
  ModelAccessSignInPrompt,
} from "@volli/shared";

import {
  accountAction,
  applySignInUpdate,
  deepLinkedAction,
  IDLE_SIGN_IN_VIEW,
  orderedAccounts,
  partitionAccounts,
  providerAccessLabel,
  retireAnsweredPrompt,
  type SignInView,
} from "./model-access-accounts-model";

function provider(
  overrides: Partial<ModelAccessProvider> & Pick<ModelAccessProvider, "id" | "label">,
): ModelAccessProvider {
  return {
    state: "unavailable",
    accountLabel: null,
    billingSource: "unknown",
    recovery: null,
    signIn: [],
    hasStoredCredential: false,
    ...overrides,
  };
}

const API_KEY_PROMPT: ModelAccessSignInPrompt = {
  promptId: "p1",
  kind: "secret",
  message: "Paste your API key",
  placeholder: null,
  options: [],
};

const MANUAL_CODE_PROMPT: ModelAccessSignInPrompt = {
  promptId: "p2",
  kind: "manual-code",
  message: "Enter the code shown on the page",
  placeholder: null,
  options: [],
};

const AUTH_URL_EVENT: ModelAccessSignInEvent = {
  kind: "auth-url",
  url: "https://example.com/auth",
  instructions: null,
};

describe("folding a sign-in update into a row's view", () => {
  it("sets the pending step and clears an answer in flight", () => {
    const view: SignInView = { ...IDLE_SIGN_IN_VIEW, answering: true };
    expect(
      applySignInUpdate(view, { attemptId: "a1", kind: "prompt", prompt: API_KEY_PROMPT }),
    ).toEqual({ prompt: API_KEY_PROMPT, event: null, failure: null, answering: false });
  });

  it("a withdrawal clears only the prompt it names", () => {
    const view: SignInView = { ...IDLE_SIGN_IN_VIEW, prompt: API_KEY_PROMPT };
    expect(
      applySignInUpdate(view, { attemptId: "a1", kind: "prompt-withdrawn", promptId: "p1" }),
    ).toEqual({ ...view, prompt: null });
  });

  it("a withdrawal that races past the next question leaves it untouched", () => {
    const view: SignInView = { ...IDLE_SIGN_IN_VIEW, prompt: MANUAL_CODE_PROMPT };
    expect(
      applySignInUpdate(view, { attemptId: "a1", kind: "prompt-withdrawn", promptId: "p1" }),
    ).toBe(view);
  });

  it("a withdrawal when no question is pending does nothing", () => {
    expect(
      applySignInUpdate(IDLE_SIGN_IN_VIEW, {
        attemptId: "a1",
        kind: "prompt-withdrawn",
        promptId: "p1",
      }),
    ).toBe(IDLE_SIGN_IN_VIEW);
  });

  it("an event replaces the last one shown without disturbing a pending prompt", () => {
    const view: SignInView = { ...IDLE_SIGN_IN_VIEW, prompt: MANUAL_CODE_PROMPT };
    expect(
      applySignInUpdate(view, { attemptId: "a1", kind: "event", event: AUTH_URL_EVENT }),
    ).toEqual({ ...view, event: AUTH_URL_EVENT });
  });

  it("a failed attempt records the message and clears the prompt", () => {
    const view: SignInView = { ...IDLE_SIGN_IN_VIEW, prompt: API_KEY_PROMPT, answering: true };
    expect(
      applySignInUpdate(view, {
        attemptId: "a1",
        kind: "settled",
        outcome: { kind: "failed", message: "Invalid key" },
      }),
    ).toEqual({ prompt: null, event: null, failure: "Invalid key", answering: false });
  });

  it("signing in closes the panel without composing a message here", () => {
    const view: SignInView = { ...IDLE_SIGN_IN_VIEW, prompt: API_KEY_PROMPT };
    expect(
      applySignInUpdate(view, {
        attemptId: "a1",
        kind: "settled",
        outcome: { kind: "signed-in" },
      }),
    ).toBe(view);
  });

  it("cancelling leaves the view exactly as the flow left it", () => {
    const view: SignInView = { ...IDLE_SIGN_IN_VIEW, prompt: API_KEY_PROMPT };
    expect(
      applySignInUpdate(view, {
        attemptId: "a1",
        kind: "settled",
        outcome: { kind: "cancelled" },
      }),
    ).toBe(view);
  });
});

describe("retiring an answered prompt", () => {
  it("clears the step just answered so it cannot be submitted twice", () => {
    const view: SignInView = { ...IDLE_SIGN_IN_VIEW, prompt: API_KEY_PROMPT, answering: true };
    expect(retireAnsweredPrompt(view, "p1")).toEqual({ ...view, prompt: null, answering: false });
  });

  it("leaves a different pending prompt untouched", () => {
    const view: SignInView = { ...IDLE_SIGN_IN_VIEW, prompt: MANUAL_CODE_PROMPT, answering: true };
    expect(retireAnsweredPrompt(view, "p1")).toBe(view);
  });

  it("does nothing when no prompt is pending", () => {
    expect(retireAnsweredPrompt(IDLE_SIGN_IN_VIEW, "p1")).toBe(IDLE_SIGN_IN_VIEW);
  });
});

describe("ordering accounts by reachability", () => {
  it("sorts stored-credential and available providers before the rest", () => {
    const stored = provider({ id: "b", label: "Bravo", hasStoredCredential: true });
    const available = provider({ id: "c", label: "Charlie", state: "available" });
    const unreached = provider({ id: "a", label: "Alpha", state: "authentication-required" });
    expect(orderedAccounts([unreached, available, stored])).toEqual([stored, available, unreached]);
  });

  it("breaks ties alphabetically by label inside a tier", () => {
    const zed = provider({ id: "z", label: "Zed", state: "available" });
    const alpha = provider({ id: "a", label: "Alpha", state: "available" });
    expect(orderedAccounts([zed, alpha])).toEqual([alpha, zed]);
  });
});

describe("partitionAccounts", () => {
  const stored = provider({ id: "s", label: "Stored", hasStoredCredential: true });
  const ambient = provider({ id: "v", label: "Ambient", state: "available" });
  const cold = provider({ id: "c", label: "Cold" });

  it("splits the reachable from the rest", () => {
    const { connected, available } = partitionAccounts([cold, stored, ambient]);

    expect(connected.map((p) => p.id)).toEqual(["v", "s"]);
    expect(available.map((p) => p.id)).toEqual(["c"]);
  });

  it("counts a provider resolving its own credential as connected", () => {
    // Ambient has nothing stored and nothing to sign out of, but it answers
    // today. Filing it under "available to connect" would offer a sign-in for
    // an account that already works.
    expect(partitionAccounts([ambient]).connected).toHaveLength(1);
    expect(partitionAccounts([ambient]).available).toHaveLength(0);
  });

  it("sorts each half alphabetically, since the tier no longer sorts them", () => {
    const zed = provider({ id: "z", label: "Zed" });
    const alpha = provider({ id: "a", label: "Alpha" });

    expect(partitionAccounts([zed, alpha]).available.map((p) => p.label)).toEqual(["Alpha", "Zed"]);
  });

  it("hands back empty halves rather than throwing on an empty catalogue", () => {
    expect(partitionAccounts([])).toEqual({ connected: [], available: [] });
  });

  it("does not mutate the array it was given", () => {
    const zed = provider({ id: "z", label: "Zed", state: "available" });
    const alpha = provider({ id: "a", label: "Alpha", state: "available" });
    const input = [zed, alpha];
    orderedAccounts(input);
    expect(input).toEqual([zed, alpha]);
  });
});

describe("a row's one line of status", () => {
  it("says sign-in is required, whatever billing source it names", () => {
    const azure = provider({
      id: "azure-openai-responses",
      label: "Azure OpenAI Responses",
      state: "authentication-required",
      billingSource: "subscription",
    });
    expect(providerAccessLabel(azure)).toBe("Sign in required · Subscription");
  });

  it("says a provider is unavailable rather than naming an account it doesn't have", () => {
    const local = provider({
      id: "local",
      label: "Local",
      state: "unavailable",
      billingSource: "local",
    });
    expect(providerAccessLabel(local)).toBe("Unavailable · Local");
  });

  it("shows the account label when one is known", () => {
    const codex = provider({
      id: "openai-codex",
      label: "OpenAI Codex",
      state: "available",
      accountLabel: "Personal subscription",
      billingSource: "subscription",
    });
    expect(providerAccessLabel(codex)).toBe("Personal subscription · Subscription");
  });

  it("falls back to Available when no account label is known", () => {
    const codex = provider({
      id: "openai-codex",
      label: "OpenAI Codex",
      state: "available",
      accountLabel: null,
      billingSource: "subscription",
    });
    expect(providerAccessLabel(codex)).toBe("Available · Subscription");
  });

  it("title-cases a hyphenated billing source", () => {
    const anthropic = provider({
      id: "anthropic",
      label: "Anthropic",
      state: "available",
      billingSource: "api-key",
    });
    expect(providerAccessLabel(anthropic)).toBe("Available · Api Key");
  });
});

describe("the action a row offers", () => {
  it("offers retry when the failure was transient", () => {
    const azure = provider({ id: "azure", label: "Azure", recovery: { kind: "retry" } });
    expect(accountAction(azure)).toBe("retry");
  });

  it("offers nothing when there is no recovery to attempt", () => {
    const azure = provider({ id: "azure", label: "Azure", recovery: null });
    expect(accountAction(azure)).toBe("none");
  });

  it("offers nothing when sign-in recovery names no method", () => {
    const azure = provider({
      id: "azure",
      label: "Azure",
      recovery: { kind: "sign-in" },
      signIn: [],
    });
    expect(accountAction(azure)).toBe("none");
  });

  it("offers sign-in directly when there is exactly one method", () => {
    const codex = provider({
      id: "openai-codex",
      label: "OpenAI Codex",
      recovery: { kind: "sign-in" },
      signIn: [{ type: "oauth", label: "Sign in with OpenAI", isSubscription: true }],
    });
    expect(accountAction(codex)).toBe("sign-in");
  });

  it("asks the user to choose between two different accounts", () => {
    const codex = provider({
      id: "openai-codex",
      label: "OpenAI Codex",
      recovery: { kind: "sign-in" },
      signIn: [
        { type: "oauth", label: "Sign in with OpenAI", isSubscription: true },
        { type: "api-key", label: "API key", isSubscription: false },
      ],
    });
    expect(accountAction(codex)).toBe("choose");
  });
});

describe("what a deep-linked arrival presses", () => {
  const OAUTH = { type: "oauth", label: "Sign in with OpenAI", isSubscription: true } as const;
  const API_KEY = { type: "api-key", label: "API key", isSubscription: false } as const;
  const blocked = provider({
    id: "openai-codex",
    label: "OpenAI Codex",
    state: "authentication-required",
    recovery: { kind: "sign-in" },
    signIn: [OAUTH],
  });

  it("presses the row's own sign-in when the blocker named this provider", () => {
    expect(deepLinkedAction(blocked, "openai-codex")).toBe("sign-in");
  });

  it("presses nothing on any other row", () => {
    expect(deepLinkedAction(blocked, "anthropic")).toBe("none");
  });

  it("presses nothing on a visit nobody deep-linked — which is every visit but the first", () => {
    // The pane spends the request as it takes it (stores/ui.ts), so walking
    // back past Model Access arrives here naming nobody.
    expect(deepLinkedAction(blocked, undefined)).toBe("none");
  });

  it("opens the choice instead of picking one of two accounts", () => {
    const twoMethods = provider({ ...blocked, signIn: [OAUTH, API_KEY] });
    expect(deepLinkedAction(twoMethods, "openai-codex")).toBe("choose");
  });

  it("never starts a fresh auth flow for an account already connected", () => {
    // The row offers Sign out, not Sign in — so there is nothing here to press,
    // and launching a provider's browser flow at a connected account would be
    // an external act with no request behind it.
    const connected = provider({
      ...blocked,
      state: "available",
      recovery: null,
      hasStoredCredential: true,
    });
    expect(deepLinkedAction(connected, "openai-codex")).toBe("none");
  });

  it("never runs the Retry a failed refresh offers", () => {
    const stale = provider({ ...blocked, recovery: { kind: "retry" } });
    expect(deepLinkedAction(stale, "openai-codex")).toBe("none");
  });
});
