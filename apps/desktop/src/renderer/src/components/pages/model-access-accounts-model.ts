/**
 * What the Accounts list shows, decided without rendering anything.
 *
 * The ordering rule and the update fold both have edge cases that only bite in
 * sequences — a withdrawal arriving after the next question, an event landing
 * beside a pending prompt — and a sequence is what a unit test can state and a
 * screenshot cannot. The view in `model-access-accounts.tsx` holds this state
 * and draws it; every decision about what the state becomes is here.
 */

import type {
  ModelAccessProvider,
  ModelAccessSignInEvent,
  ModelAccessSignInPrompt,
  ModelAccessSignInUpdate,
} from "@volli/shared";

/** What one attempt has told one row so far. */
export interface SignInView {
  /** The step waiting for an answer, or null while the flow is working. */
  prompt: ModelAccessSignInPrompt | null;
  /** The last thing the flow said. A link or a code outlives the prompt beside it. */
  event: ModelAccessSignInEvent | null;
  failure: string | null;
  /** An answer is in flight; the same step must not be answered twice. */
  answering: boolean;
}

export const IDLE_SIGN_IN_VIEW: SignInView = {
  prompt: null,
  event: null,
  failure: null,
  answering: false,
};

/**
 * Folds one update into what a row is showing.
 *
 * Two rules earn their keep here. A withdrawal clears **only the prompt it
 * names**, so one that raced past the next question cannot blank a question the
 * flow is still waiting on. And an event never disturbs a pending prompt:
 * Anthropic emits `auth_url` and then asks for a `manual_code`, and both belong
 * on screen at once — the link to go get the code, and the field to bring it
 * back.
 */
export function applySignInUpdate(view: SignInView, update: ModelAccessSignInUpdate): SignInView {
  switch (update.kind) {
    case "prompt":
      return { ...view, prompt: update.prompt, answering: false };
    case "prompt-withdrawn":
      return view.prompt?.promptId === update.promptId ? { ...view, prompt: null } : view;
    case "event":
      return { ...view, event: update.event };
    case "settled":
      // Only a failure leaves anything to look at. A signed-in or cancelled
      // attempt closes the panel, and what changed is a question for the
      // reloaded snapshot rather than for a message composed here.
      return update.outcome.kind === "failed"
        ? { ...view, prompt: null, answering: false, failure: update.outcome.message }
        : view;
  }
}

/** Retires the step just answered so its input cannot be submitted twice. */
export function retireAnsweredPrompt(view: SignInView, promptId: string): SignInView {
  return view.prompt?.promptId === promptId ? { ...view, prompt: null, answering: false } : view;
}

/**
 * Reachable providers first, then everything else, alphabetically inside each.
 *
 * Pi ships forty and this profile has credentials for two or three. In catalog
 * order those two sit wherever the catalog put them, so the list a person opens
 * to check their own accounts opens on thirty-eight they have never used.
 * Nothing is hidden — a provider not signed in to yet is often exactly why
 * someone came here — but the ones already working sort up.
 */
export function orderedAccounts(
  providers: readonly ModelAccessProvider[],
): readonly ModelAccessProvider[] {
  return providers.toSorted(
    (a, b) =>
      reachability(a) - reachability(b) ||
      a.label.localeCompare(b.label, undefined, { numeric: true }),
  );
}

/**
 * 0 for a provider this profile can reach, 1 for one it cannot.
 *
 * Two ways to be reachable, and both count: a credential stored here, or a
 * provider already resolving one from the environment. The second has nothing
 * to sign out of but is no less usable for it.
 */
function reachability(provider: ModelAccessProvider): number {
  return provider.hasStoredCredential || provider.state === "available" ? 0 : 1;
}

/**
 * The row's one line of status, from sanitized metadata only.
 *
 * Never an account identity: Pi's auth `source` is a credential-source label
 * (an environment variable name, or "OAuth"), and relabelling it as *who* is
 * signed in would be an invention.
 */
export function providerAccessLabel(provider: ModelAccessProvider): string {
  const access =
    provider.state === "authentication-required"
      ? "Sign in required"
      : provider.state === "unavailable"
        ? "Unavailable"
        : (provider.accountLabel ?? "Available");
  const billing = provider.billingSource
    .split("-")
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
  return `${access} · ${billing}`;
}

/**
 * The action a row offers when no attempt is running.
 *
 * `retry` and `sign-in` are different recoveries and stay different actions: a
 * refresh that failed needs another attempt, and a provider with no credential
 * needs a person. A provider offering two methods gets `choose`, because they
 * are different accounts with different bills and picking one for the user
 * would sign them in to the wrong one.
 */
export type AccountAction = "retry" | "sign-in" | "choose" | "none";

export function accountAction(provider: ModelAccessProvider): AccountAction {
  if (provider.recovery?.kind === "retry") return "retry";
  if (provider.recovery?.kind !== "sign-in") return "none";
  if (provider.signIn.length === 0) return "none";
  return provider.signIn.length === 1 ? "sign-in" : "choose";
}
