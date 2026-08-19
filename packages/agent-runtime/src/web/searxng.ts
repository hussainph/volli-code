/**
 * SearXNG, as the other implementation of {@link WebSearchProvider}.
 *
 * The keyless one, and the reason the endpoint policy in `./search-endpoint.ts`
 * exists: a SearXNG instance is a thing a person runs, usually on their own
 * machine, and where it lives is the whole of its configuration.
 *
 * From SearXNG's own API documentation: `GET /search` with `q` and
 * `format=json`, both `/` and `/search` accepted, and JSON returned only when
 * the instance has that format enabled — `search.formats` in `settings.yml`,
 * which is off by default and answers `403` when it is. Results arrive at
 * `results[]` carrying `url`, `title` and `content`.
 * https://docs.searxng.org/dev/search_api.html
 *
 * There is deliberately no credential here. An instance behind basic auth or a
 * token is not supported by this slice: a URL carrying credentials is refused
 * at admission, and inventing a second credential shape for the one provider
 * that does not need one is not a decision this seam should make quietly.
 */

import type { WebSearchProvider } from "./search";

/** Volli's name for this provider, and the one shown as provenance. */
export const SEARXNG_PROVIDER_ID = "searxng";

/** What this provider needs from the host to exist at all. */
export interface SearxngSearchOptions {
  /**
   * The instance a person configured, as they typed it.
   *
   * Judged by {@link admitSearchEndpoint} on every search, not here: this is a
   * string from settings, and the policy that decides where a search may go is
   * one place rather than one per provider.
   */
  endpoint: string;
}

/** The answer shape SearXNG documents, before anything is believed. */
interface SearxngAnswer {
  results?: unknown;
}

interface SearxngResult {
  url?: unknown;
  title?: unknown;
  content?: unknown;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * The search URL for one configured instance.
 *
 * A person configures where their instance is, and both spellings turn up in
 * the wild: the instance root, and the search URL itself, with or without a
 * trailing slash. Appending a second `/search` to the latter is a 404 nobody
 * can debug from a refusal, so the path is only added when it is not already
 * there. A path in front of it is kept, because a reverse proxy that serves an
 * instance under `/searxng` is an ordinary way to run one.
 */
function searchUrl(endpoint: string): URL {
  const url = new URL(endpoint);
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path.endsWith("/search") ? path : `${path}/search`;
  return url;
}

export function searxngWebSearchProvider(options: SearxngSearchOptions): WebSearchProvider {
  return {
    id: SEARXNG_PROVIDER_ID,
    describe(request) {
      const url = searchUrl(options.endpoint);
      // `searchParams` rather than string building, so a query is a parameter
      // and cannot become another one, a different path, or a different host.
      url.searchParams.set("q", request.query);
      // JSON rather than the HTML a browser gets. An instance with the format
      // disabled answers 403, which reaches the model as a readable refusal.
      url.searchParams.set("format", "json");
      return { url: url.href };
    },
    read(payload) {
      const results = (payload as SearxngAnswer | null)?.results;
      if (!Array.isArray(results)) {
        throw new Error("this payload is not a SearXNG search answer");
      }
      const references = [];
      for (const result of results as SearxngResult[]) {
        const url = text(result?.url);
        if (url === undefined || url === "") continue;
        references.push({
          title: text(result?.title) ?? "",
          url,
          snippet: text(result?.content) ?? "",
        });
      }
      return references;
    },
  };
}
