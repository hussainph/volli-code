/**
 * SearXNG as the other implementation of the provider port.
 *
 * The interesting difference from Brave is not the JSON — it is that the
 * endpoint is the configuration. There is no key, the instance belongs to the
 * person running it, and where it lives is the only thing they configure. So
 * these tests spend most of their attention on what Volli builds out of that
 * string, and the last one runs the whole thing against a real instance-shaped
 * server on loopback, which is where a real one lives.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { createWebSearch } from "./search";
import { searxngWebSearchProvider } from "./searxng";

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(async (server) => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }),
  );
});

/** One SearXNG answer, in the shape its API documents. */
function searxngAnswer(...results: Record<string, unknown>[]): string {
  return JSON.stringify({
    query: "vitest matchers",
    number_of_results: results.length,
    results,
    answers: [],
    infoboxes: [],
    suggestions: [],
  });
}

describe("the SearXNG provider", () => {
  it("asks the configured instance for JSON, on the search path SearXNG documents", () => {
    const provider = searxngWebSearchProvider({ endpoint: "http://localhost:8888" });

    const call = provider.describe({ query: "vitest matchers", limit: 8 });

    expect(call.url).toBe("http://localhost:8888/search?q=vitest+matchers&format=json");
    // No key exists to send, so no header is set at all.
    expect(call.headers).toBeUndefined();
  });

  it("keeps the path a person's own reverse proxy put in front of their instance", () => {
    const provider = searxngWebSearchProvider({ endpoint: "https://example.com/searxng/" });

    expect(provider.describe({ query: "tdd", limit: 8 }).url).toBe(
      "https://example.com/searxng/search?q=tdd&format=json",
    );
  });

  it("takes the whole search URL when that is what was configured", () => {
    // Both spellings are what people actually paste, and appending a second
    // `/search` to one of them is a 404 nobody can debug from the refusal.
    for (const endpoint of ["http://localhost:8888/search", "http://localhost:8888/search/"]) {
      expect(searxngWebSearchProvider({ endpoint }).describe({ query: "tdd", limit: 8 }).url).toBe(
        "http://localhost:8888/search?q=tdd&format=json",
      );
    }
  });

  it("cannot have its request reshaped by what the model typed", () => {
    const provider = searxngWebSearchProvider({ endpoint: "http://localhost:8888" });

    const call = provider.describe({
      query: "cats&format=csv#/../admin https://evil.example/",
      limit: 8,
    });

    const url = new URL(call.url);
    expect(url.host).toBe("localhost:8888");
    expect(url.pathname).toBe("/search");
    expect(url.searchParams.get("format")).toBe("json");
    expect(url.hash).toBe("");
  });

  it("reads the title, URL and content of each result", () => {
    const provider = searxngWebSearchProvider({ endpoint: "http://localhost:8888" });

    const references = provider.read(
      JSON.parse(
        searxngAnswer(
          {
            url: "https://vitest.dev/api/expect",
            title: "Vitest | expect",
            content: "The matcher reference.",
            engine: "duckduckgo",
            score: 1.5,
          },
          { url: "https://vitest.dev/", title: "Vitest", engine: "google" },
        ),
      ),
    );

    expect(references).toEqual([
      {
        title: "Vitest | expect",
        url: "https://vitest.dev/api/expect",
        snippet: "The matcher reference.",
      },
      { title: "Vitest", url: "https://vitest.dev/", snippet: "" },
    ]);
  });

  it("keeps a result whose title is missing, rather than inventing one", () => {
    const provider = searxngWebSearchProvider({ endpoint: "http://localhost:8888" });

    // Engines do omit titles. An untitled reference is still somewhere to look,
    // and an empty string is the honest reading of nothing.
    expect(provider.read(JSON.parse(searxngAnswer({ url: "https://vitest.dev/" })))).toEqual([
      { title: "", url: "https://vitest.dev/", snippet: "" },
    ]);
  });

  it("skips a result that is not somewhere a person could go", () => {
    const provider = searxngWebSearchProvider({ endpoint: "http://localhost:8888" });

    const references = provider.read(
      JSON.parse(searxngAnswer({ title: "No URL" }, { url: "https://vitest.dev/", title: "Fine" })),
    );

    expect(references).toEqual([{ title: "Fine", url: "https://vitest.dev/", snippet: "" }]);
  });

  it("refuses an answer that is not a SearXNG search at all", () => {
    const provider = searxngWebSearchProvider({ endpoint: "http://localhost:8888" });

    for (const payload of [{}, { results: "nope" }, null, "text"]) {
      expect(() => provider.read(payload)).toThrow();
    }
  });

  it("searches a self-hosted instance on this machine, end to end", async () => {
    const asked: string[] = [];
    const server = http.createServer((request, response) => {
      asked.push(request.url ?? "");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        searxngAnswer({
          url: "https://vitest.dev/api/expect",
          title: "Vitest | expect",
          content: "The matcher reference.",
        }),
      );
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    // No seam replaced: production admission, production resolution, a
    // production socket. The endpoint is exactly what a person would type.
    const search = createWebSearch({
      provider: searxngWebSearchProvider({ endpoint: `http://localhost:${port}` }),
    });

    const results = await search.search({
      query: "vitest matchers",
      signal: new AbortController().signal,
    });

    expect(asked).toEqual(["/search?q=vitest+matchers&format=json"]);
    expect(results).toEqual({
      provider: "searxng",
      query: "vitest matchers",
      references: [
        {
          title: "Vitest | expect",
          url: "https://vitest.dev/api/expect",
          snippet: "The matcher reference.",
        },
      ],
      truncated: false,
    });
  });
});
