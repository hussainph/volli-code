/**
 * Exa, as one implementation of {@link WebSearchProvider}.
 *
 * Called as a REST API rather than through the `exa-js` package, for the same
 * reason Brave is: two documented facts are all that is needed to talk to it,
 * so a dependency would buy a supply-chain surface and no work.
 *
 * Everything here comes from Exa's own published reference — `POST` to
 * `https://api.exa.ai/search`, the key in `Authorization: Bearer`, `numResults`
 * bounded 1 to 100, content options nested under `contents`, and results at
 * `results[]` carrying `title`, `url` and, when asked for, `highlights`.
 * https://exa.ai/docs
 *
 * **Excerpts, never pages.** Exa will return the full text of every result
 * (`contents.text`) and an LLM-written summary of each (`contents.summary`).
 * This provider asks for neither. `web_search` returns *references* so that
 * reading a page stays a separate, separately-judged act — a search that
 * quietly retrieved five pages would put content the fetch boundary never saw
 * in front of the model, and bill for it. `contents.highlights` is the one
 * content option that answers the question a snippet answers: which part of
 * this page is about the query. It is the same role Brave's `description`
 * plays, and it is where Exa's semantic index is actually worth having.
 *
 * `maxAgeHours` is likewise left alone. Setting it to `0` forces a live crawl
 * of every result, which Exa's own reference calls out as a latency cost; the
 * default already live-crawls when it has no cached copy.
 *
 * The key arrives through construction, from a host that holds it. Nothing here
 * reads an environment variable, a file, a keychain or a setting, and the key
 * appears in one header and in no URL — a URL is the half of a request that
 * gets logged by every hop, pasted into issues and shown on screen.
 */

import type { WebSearchProvider } from "./search";

/** Volli's name for this provider, and the one shown as provenance. */
export const EXA_PROVIDER_ID = "exa";

/**
 * The one endpoint this provider calls.
 *
 * A constant rather than a setting on purpose: a configurable endpoint for a
 * keyed provider is a field whose only interesting use is sending somebody's
 * key somewhere Exa is not.
 */
export const EXA_SEARCH_ENDPOINT = "https://api.exa.ai/search";

/**
 * Exa's own bound on results per call.
 *
 * The upper bound is Exa's; Volli's own limit is almost always the smaller of
 * the two and arrives on the request.
 */
const RESULT_RANGE = { least: 1, most: 100 } as const;

/**
 * The search mode this provider asks for.
 *
 * Pinned rather than omitted. `auto` is Exa's documented default *today*, and
 * naming it means a change to that default is a change to Exa's product rather
 * than a silent change to Volli's latency and cost. The deep variants are
 * deliberately not offered: they synthesize an answer, which is a different
 * product from a list of references, and they take seconds to tens of seconds.
 */
const SEARCH_TYPE = "auto";

/** What this provider needs from the host to exist at all. */
export interface ExaSearchOptions {
  /** The API key a person configured. Supplied, never discovered. */
  apiKey: string;
}

/** One result as Exa's reference documents it, before anything is believed. */
interface ExaResult {
  title?: unknown;
  url?: unknown;
  highlights?: unknown;
}

/** The shape an Exa search answers with. */
interface ExaAnswer {
  results?: unknown;
}

/** Read one field only when it is the string it was documented to be. */
function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Exa's excerpts for one result, as one snippet.
 *
 * Documented as an array because a page can be relevant in several places.
 * Joined rather than truncated here: the boundary above bounds what any of this
 * is allowed to become, and picking one excerpt would throw away the part that
 * answered the question.
 */
function snippet(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((entry) => text(entry) ?? "")
    .filter((entry) => entry !== "")
    .join(" … ");
}

export function exaWebSearchProvider(options: ExaSearchOptions): WebSearchProvider {
  return {
    id: EXA_PROVIDER_ID,
    describe(request) {
      return {
        url: EXA_SEARCH_ENDPOINT,
        method: "POST",
        // Lower-cased because that is how the boundary compares a header
        // against the set it sends for itself.
        headers: { authorization: `Bearer ${options.apiKey}` },
        body: {
          query: request.query,
          type: SEARCH_TYPE,
          numResults: Math.min(Math.max(request.limit, RESULT_RANGE.least), RESULT_RANGE.most),
          contents: { highlights: true },
        },
      };
    },
    read(payload) {
      const results = (payload as ExaAnswer | null)?.results;
      // Throwing rather than returning nothing: "Exa did not answer with a
      // search" and "the web has nothing on this" are different facts, and the
      // second one is a lie the model would act on.
      if (!Array.isArray(results)) {
        throw new Error("this payload is not an Exa search answer");
      }
      const references = [];
      for (const result of results as ExaResult[]) {
        const url = text(result?.url);
        // A result with no URL is not somewhere to look, whatever else it
        // carries. Skipped rather than refused: one odd entry is not a reason
        // to throw away the answer.
        if (url === undefined || url === "") continue;
        references.push({
          title: text(result?.title) ?? "",
          url,
          snippet: snippet(result?.highlights),
        });
      }
      return references;
    },
  };
}
