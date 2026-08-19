/**
 * Brave Search, as one implementation of {@link WebSearchProvider}.
 *
 * Called as a REST API rather than through the `brave-search` npm package,
 * which is GPL-3.0 and not a licence this product can take on. Two documented
 * facts and nothing else is needed to talk to it, so the dependency would buy a
 * licence problem and no work.
 *
 * Everything here comes from Brave's own published reference — the endpoint
 * `https://api.search.brave.com/res/v1/web/search`, the `x-subscription-token`
 * header, the `count` bound of 1 to 20, and results at `web.results[]` carrying
 * `title`, `url` and an optional `description`.
 * https://api-dashboard.search.brave.com/api-reference/web/search/get
 *
 * The key arrives through construction, from a host that holds it. Nothing here
 * reads an environment variable, a file, a keychain or a setting, and the key
 * appears in one header and in no URL — a URL is the half of a request that
 * gets logged by every hop, pasted into issues and shown on screen.
 */

import type { WebSearchProvider } from "./search";

/** Volli's name for this provider, and the one shown as provenance. */
export const BRAVE_PROVIDER_ID = "brave";

/**
 * The one endpoint this provider calls.
 *
 * A constant rather than a setting on purpose: a configurable endpoint for a
 * keyed provider is a field whose only interesting use is sending somebody's
 * key somewhere Brave is not.
 */
export const BRAVE_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

/** Brave's own bound on results per call. */
const COUNT_RANGE = { least: 1, most: 20 } as const;

/** What this provider needs from the host to exist at all. */
export interface BraveSearchOptions {
  /** The subscription token a person configured. Supplied, never discovered. */
  apiKey: string;
}

/** One result as Brave's reference documents it, before anything is believed. */
interface BraveResult {
  title?: unknown;
  url?: unknown;
  description?: unknown;
}

/** The shape a Brave web search answers with. */
interface BraveAnswer {
  web?: { results?: unknown };
}

/** Read one field only when it is the string it was documented to be. */
function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function braveWebSearchProvider(options: BraveSearchOptions): WebSearchProvider {
  return {
    id: BRAVE_PROVIDER_ID,
    describe(request) {
      const url = new URL(BRAVE_SEARCH_ENDPOINT);
      // `searchParams` rather than string building, so a query is a parameter
      // and cannot become another one, a different path, or a different host.
      url.searchParams.set("q", request.query);
      url.searchParams.set(
        "count",
        String(Math.min(Math.max(request.limit, COUNT_RANGE.least), COUNT_RANGE.most)),
      );
      return { url: url.href, headers: { "x-subscription-token": options.apiKey } };
    },
    read(payload) {
      const results = (payload as BraveAnswer | null)?.web?.results;
      // Throwing rather than returning nothing: "Brave did not answer with a
      // web search" and "the web has nothing on this" are different facts, and
      // the second one is a lie the model would act on.
      if (!Array.isArray(results)) {
        throw new Error("this payload is not a Brave web search answer");
      }
      const references = [];
      for (const result of results as BraveResult[]) {
        const url = text(result?.url);
        // A result with no URL is not somewhere to look, whatever else it
        // carries. Skipped rather than refused: one odd entry is not a reason
        // to throw away the answer.
        if (url === undefined || url === "") continue;
        references.push({
          title: text(result?.title) ?? "",
          url,
          // Documented optional, and empty is the honest reading of absent.
          snippet: text(result?.description) ?? "",
        });
      }
      return references;
    },
  };
}
