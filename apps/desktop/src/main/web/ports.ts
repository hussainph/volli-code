/**
 * Turning a setting into the two ports a Session is handed, or into nothing.
 *
 * The whole of this module's judgement is in what it returns for an
 * unconfigured profile: an empty object, with neither field present. That is
 * not a stylistic choice about optional properties. `attachSession` registers
 * `web_fetch` and `web_search` only when the corresponding field exists on the
 * spec, so an absent field is a tool the model is never told about, where a
 * field wired to something that always refuses is a tool the model calls, is
 * refused by, and reasons about — including by looking for another way round.
 *
 * The two are offered together and withheld together. `web_fetch` needs no
 * credential and could technically stand alone, but Web Access is one switch a
 * person set to Off, and reading arbitrary pages is not a smaller permission
 * than asking a search engine a question. A fetch-only mode is a product
 * decision, not a default to arrive at by noticing the fetch has nothing to
 * configure.
 *
 * The credential lives in the closure `braveWebSearchProvider` builds and is
 * read from the keychain once, when a Session attaches. That pins it for the
 * life of that attachment, which is the same rule the Authority Snapshot
 * follows: a Settings change is not something a running Session finds out about
 * halfway through a turn.
 */
import {
  braveWebSearchProvider,
  exaWebSearchProvider,
  createSafeWebFetch,
  createWebSearch,
  searxngWebSearchProvider,
  type WebSearchProvider,
} from "@volli/agent-runtime";
import type { SessionRuntimeSpec } from "@volli/shared";

import type { ResolvedWebAccess } from "./settings";

/**
 * The web half of one Session's spec.
 *
 * Both optional, and the optionality is the contract: this object is spread
 * into {@link SessionRuntimeSpec}, so a missing field is a missing field there.
 */
export interface SessionWebPorts {
  webFetch?: NonNullable<SessionRuntimeSpec["webFetch"]>;
  webSearch?: NonNullable<SessionRuntimeSpec["webSearch"]>;
}

/**
 * The search provider one resolved setting names, or null when it names none.
 *
 * Separate from {@link webPortsFor} so the provider a setting builds can be
 * read on its own — where the credential goes and what URL is called are the
 * two facts worth checking, and neither needs a socket to check.
 */
export function webSearchProviderFor(access: ResolvedWebAccess): WebSearchProvider | null {
  if (!access.configured) return null;
  // Switched over rather than branched on `provider === "searxng"`, so a
  // provider added to the setting without an implementation here is a
  // compile error rather than a silent fall through to somebody else's API.
  switch (access.provider) {
    case "brave":
      return braveWebSearchProvider({ apiKey: access.apiKey });
    case "exa":
      return exaWebSearchProvider({ apiKey: access.apiKey });
    case "searxng":
      return searxngWebSearchProvider({ endpoint: access.endpoint });
  }
}

/** The ports for one attachment. `{}` when this profile has configured no web access. */
export function webPortsFor(access: ResolvedWebAccess): SessionWebPorts {
  const provider = webSearchProviderFor(access);
  if (provider === null) return {};
  const fetcher = createSafeWebFetch();
  const search = createWebSearch({ provider });
  return {
    webFetch: (input) => fetcher.fetch(input),
    webSearch: (input) => search.search(input),
  };
}
