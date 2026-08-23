/**
 * What Settings → Web draws, from the one view main answers with.
 *
 * A pure fold, extracted for the reason `cli-status-model.ts` was: the pane
 * itself is I/O and drawing, and the decisions worth checking are which fields
 * a provider needs, whether this profile's web access is actually *on*, and
 * which of several blocked states a person is in. None of those need a DOM.
 *
 * `active` is the interesting one. It answers the question a person actually
 * has — "will my next Session be able to search?" — and it is deliberately not
 * "did I pick a provider": a Brave row with no key is a provider chosen and
 * nothing configured. Main's own `resolve()` reaches the same verdict from the
 * same facts, and it is the one that decides; this exists so the page cannot
 * claim otherwise.
 *
 * The notice is the exception to "let controls talk" that `AGENTS.md` names: a
 * blocked state with one recovery action. It is one sentence saying what is
 * missing, and there is none at all for the working case. It carries no tone,
 * because every state it can describe now is an unfinished setup rather than a
 * fault — the error-toned ones were both about a keychain, and there is no
 * keychain here any more. A refusal from main is still shown in the pane's own
 * error notice; this is only ever "you have not finished yet".
 */
import type {
  KeyedWebAccessProvider,
  WebAccessProvider,
  WebAccessSettingsView,
} from "../../../../ipc/contract";

export interface WebAccessPanel {
  provider: WebAccessProvider;
  /** The SearXNG instance field: shown only for the provider that has one. */
  showsEndpoint: boolean;
  /** The Brave key field: shown only for the provider that needs one. */
  showsKey: boolean;
  /** Whether a Session starting now would actually be offered the web tools. */
  active: boolean;
  /** The one sentence naming what this setup is still missing, or nothing to say. */
  notice: string | null;
}

/** What a person calls each keyed provider, and what its key is called there. */
const KEY_NAMES: Readonly<Record<KeyedWebAccessProvider, string>> = {
  brave: "Brave Search API key",
  exa: "Exa API key",
};

/** Whether this provider is one that carries a key at all. */
function isKeyed(provider: WebAccessSettingsView["provider"]): provider is KeyedWebAccessProvider {
  return provider === "brave" || provider === "exa";
}

export function webAccessPanel(view: WebAccessSettingsView): WebAccessPanel {
  const keyed = isKeyed(view.provider);
  const base = {
    provider: view.provider,
    showsEndpoint: view.provider === "searxng",
    showsKey: keyed,
  };
  if (view.provider === "off") return { ...base, active: false, notice: null };
  if (view.provider === "searxng") {
    return view.searxngUrl === null
      ? { ...base, active: false, notice: "Enter the address of your SearXNG instance." }
      : { ...base, active: true, notice: null };
  }
  // Everything past here is a keyed provider. Narrowed rather than assumed, so
  // a provider added to the setting and not to `KEY_NAMES` cannot reach the
  // key messages below and be described with somebody else's name.
  /* v8 ignore next -- `off` and `searxng` both returned above; this is the arm no provider reaches. */
  if (!keyed) return { ...base, active: false, notice: null };
  return view.keys[view.provider] === "present"
    ? { ...base, active: true, notice: null }
    : { ...base, active: false, notice: `Enter your ${KEY_NAMES[view.provider]}.` };
}
