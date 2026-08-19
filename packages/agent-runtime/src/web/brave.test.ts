/**
 * Brave as one implementation of the provider port.
 *
 * `describe` and `read` are pure, so most of this is unit-level: the request
 * Brave's API documents, and the answer shape it documents, with nothing
 * underneath to mock. The last test puts the provider through the real boundary
 * to show the two fit together and that the key lands in the header Brave asks
 * for and nowhere else.
 *
 * The payloads here are shaped from Brave's published reference, not captured
 * from the live API — see the note in `./brave.ts`.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { braveWebSearchProvider, BRAVE_SEARCH_ENDPOINT } from "./brave";
import { createWebSearch } from "./search";

const KEY = "sk-brave-3f9a1c-DO-NOT-LEAK";

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(async (server) => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }),
  );
});

/** One Brave answer, in the shape its reference documents. */
function braveAnswer(...results: Record<string, unknown>[]): string {
  return JSON.stringify({ type: "search", web: { type: "search", results } });
}

describe("the Brave provider", () => {
  it("asks Brave's documented endpoint for the query and no more results than Volli will carry", () => {
    const provider = braveWebSearchProvider({ apiKey: KEY });

    const call = provider.describe({ query: "vitest matchers", limit: 8 });

    const url = new URL(call.url);
    expect(url.origin + url.pathname).toBe(BRAVE_SEARCH_ENDPOINT);
    expect(url.searchParams.get("q")).toBe("vitest matchers");
    expect(url.searchParams.get("count")).toBe("8");
    // The key travels in the header Brave documents, and the URL carries none
    // of it: a URL is the half of a request that gets logged, pasted and shown.
    expect(call.headers).toEqual({ "x-subscription-token": KEY });
    expect(call.url).not.toContain(KEY);
    expect(call.method).toBeUndefined();
  });

  it("keeps Brave's own count bound, whatever it is asked for", () => {
    const provider = braveWebSearchProvider({ apiKey: KEY });

    // Brave documents 1-20. Sending 40 is a 422 from the provider and a refusal
    // the model can do nothing with, so the provider clamps its own API's rule.
    expect(
      new URL(provider.describe({ query: "x", limit: 40 }).url).searchParams.get("count"),
    ).toBe("20");
    expect(new URL(provider.describe({ query: "x", limit: 0 }).url).searchParams.get("count")).toBe(
      "1",
    );
  });

  it("cannot have its request reshaped by what the model typed", () => {
    const provider = braveWebSearchProvider({ apiKey: KEY });

    const call = provider.describe({
      query: "cats&count=99#/../../admin https://evil.example/?x=y",
      limit: 8,
    });

    const url = new URL(call.url);
    expect(url.origin + url.pathname).toBe(BRAVE_SEARCH_ENDPOINT);
    expect(url.searchParams.get("count")).toBe("8");
    expect(url.hash).toBe("");
  });

  it("reads the title, URL and description of each web result", () => {
    const provider = braveWebSearchProvider({ apiKey: KEY });

    const references = provider.read(
      JSON.parse(
        braveAnswer(
          {
            title: "Vitest | expect",
            url: "https://vitest.dev/api/expect",
            description: "The <strong>matcher</strong> reference.",
            page_age: "2026-01-01",
          },
          { title: "Vitest", url: "https://vitest.dev/", description: "Home." },
        ),
      ),
    );

    expect(references).toEqual([
      {
        title: "Vitest | expect",
        url: "https://vitest.dev/api/expect",
        // Brave marks the matched terms up. It is left exactly as served: this
        // is third-party text either way, and quietly rewriting it would make
        // the boundary's own bounds harder to reason about, not safer.
        snippet: "The <strong>matcher</strong> reference.",
      },
      { title: "Vitest", url: "https://vitest.dev/", snippet: "Home." },
    ]);
  });

  it("keeps a result whose description Brave omitted", () => {
    const provider = braveWebSearchProvider({ apiKey: KEY });

    // Brave documents `description` as optional. A result with no summary is
    // still somewhere to look.
    expect(
      provider.read(JSON.parse(braveAnswer({ title: "Vitest", url: "https://vitest.dev/" })))
        .length,
    ).toBe(1);
    expect(
      provider.read(JSON.parse(braveAnswer({ title: "Vitest", url: "https://vitest.dev/" })))[0]
        ?.snippet,
    ).toBe("");
  });

  it("keeps a result whose title is missing, rather than inventing one", () => {
    const provider = braveWebSearchProvider({ apiKey: KEY });

    // Engines do omit titles. An untitled reference is still somewhere to look,
    // and an empty string is the honest reading of nothing.
    expect(provider.read(JSON.parse(braveAnswer({ url: "https://vitest.dev/" })))).toEqual([
      { title: "", url: "https://vitest.dev/", snippet: "" },
    ]);
  });

  it("skips a result that is not somewhere a person could go", () => {
    const provider = braveWebSearchProvider({ apiKey: KEY });

    const references = provider.read(
      JSON.parse(
        braveAnswer(
          { title: "No URL at all" },
          { title: "Wrong type", url: 42 },
          { url: "https://vitest.dev/", title: "Fine" },
        ),
      ),
    );

    expect(references).toEqual([{ title: "Fine", url: "https://vitest.dev/", snippet: "" }]);
  });

  it("refuses an answer that is not a Brave web search at all", () => {
    const provider = braveWebSearchProvider({ apiKey: KEY });

    // Each of these is a payload the boundary turns into one readable refusal.
    // Reading them as "no results" would tell the model the web is empty.
    for (const payload of [{}, { web: {} }, { web: { results: "nope" } }, null, "text"]) {
      expect(() => provider.read(payload)).toThrow();
    }
  });

  it("comes back through the boundary with its key in Brave's header and nowhere else", async () => {
    const requests: http.IncomingHttpHeaders[] = [];
    const server = http.createServer((request, response) => {
      requests.push(request.headers);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        braveAnswer({
          title: "Vitest | expect",
          url: "https://vitest.dev/api/expect",
          description: "The matcher reference.",
        }),
      );
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const search = createWebSearch({
      provider: braveWebSearchProvider({ apiKey: KEY }),
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      open: (_scheme, options) =>
        http.request({
          ...options,
          protocol: "http:",
          port,
          lookup: (_hostname, _options, callback) =>
            callback(null, [{ address: "127.0.0.1", family: 4 }]),
        }),
    });

    const results = await search.search({
      query: "vitest matchers",
      signal: new AbortController().signal,
    });

    expect(results).toEqual({
      provider: "brave",
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
    expect(requests[0]?.["x-subscription-token"]).toBe(KEY);
    // The key is in exactly one header and in no other part of the request.
    const elsewhere = { ...requests[0] };
    delete elsewhere["x-subscription-token"];
    expect(JSON.stringify(elsewhere)).not.toContain(KEY);
  });
});
