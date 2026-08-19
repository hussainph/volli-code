/**
 * Exa as one implementation of the provider port.
 *
 * `describe` and `read` are pure, so most of this is unit-level: the request
 * Exa's API documents, and the answer shape it documents, with nothing
 * underneath to mock. The last tests put the provider through the real boundary
 * to show the two fit together — Exa is the first shipped provider that POSTs,
 * so the body and the credential header are worth seeing land for real.
 *
 * The payloads here are shaped from Exa's published reference, not captured
 * from the live API — see the note in `./exa.ts`.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { exaWebSearchProvider, EXA_SEARCH_ENDPOINT } from "./exa";
import { createWebSearch } from "./search";

const KEY = "exa-7c2b91-DO-NOT-LEAK";

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(async (server) => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }),
  );
});

describe("the Exa provider", () => {
  it("posts the query to Exa's documented endpoint, asking for excerpts rather than pages", () => {
    const call = exaWebSearchProvider({ apiKey: KEY }).describe({
      query: "svelte 5 runes",
      limit: 5,
    });

    expect(call.url).toBe(EXA_SEARCH_ENDPOINT);
    expect(call.method).toBe("POST");
    // The credential rides the header Exa documents, and never the URL.
    expect(call.headers).toEqual({ authorization: `Bearer ${KEY}` });
    expect(call.url).not.toContain(KEY);

    // `highlights`, deliberately, and never `text`. `contents.text` returns the
    // whole page: asking for it would make one `web_search` quietly read every
    // result, which is the exact search/fetch collapse this port exists to
    // prevent. Highlights are query-relevant excerpts — a snippet, the same
    // role Brave's `description` plays.
    expect(call.body).toEqual({
      query: "svelte 5 runes",
      type: "auto",
      numResults: 5,
      contents: { highlights: true },
    });
  });

  it("never asks for whole pages or written summaries, whatever the limit", () => {
    const body = exaWebSearchProvider({ apiKey: KEY }).describe({ query: "q", limit: 3 }).body as {
      contents: Record<string, unknown>;
      [key: string]: unknown;
    };

    // The three that would turn one search into a read of every result, plus
    // the crawl switch that quietly costs seconds per call.
    expect(body.contents.text).toBeUndefined();
    expect(body.contents.summary).toBeUndefined();
    expect(body.contents.maxAgeHours).toBeUndefined();
    expect(body.contents.subpages).toBeUndefined();
    // Synthesis and streaming are different products from a list of references,
    // and the boundary above reads one JSON body.
    expect(body.outputSchema).toBeUndefined();
    expect(body.stream).toBeUndefined();
  });

  it("keeps the result count inside Exa's documented range", () => {
    const provider = exaWebSearchProvider({ apiKey: KEY });
    const count = (limit: number): unknown =>
      (provider.describe({ query: "q", limit }).body as { numResults: unknown }).numResults;

    expect(count(0)).toBe(1);
    expect(count(250)).toBe(100);
    expect(count(7)).toBe(7);
  });

  it("reads Exa's documented answer into references, joining a page's excerpts", () => {
    const references = exaWebSearchProvider({ apiKey: KEY }).read({
      requestId: "b5947044",
      searchType: "auto",
      results: [
        {
          title: "Runes",
          url: "https://svelte.dev/docs/svelte/what-are-runes",
          id: "https://svelte.dev/docs/svelte/what-are-runes",
          publishedDate: "2024-01-15T00:00:00.000Z",
          highlights: ["Runes are symbols that", "replace the reactive let"],
          highlightScores: [0.46, 0.41],
        },
      ],
      costDollars: { total: 0.007 },
    });

    expect(references).toEqual([
      {
        title: "Runes",
        url: "https://svelte.dev/docs/svelte/what-are-runes",
        snippet: "Runes are symbols that … replace the reactive let",
      },
    ]);
  });

  it("keeps a usable result whose optional halves are missing, and drops one with no URL", () => {
    const references = exaWebSearchProvider({ apiKey: KEY }).read({
      results: [
        { url: "https://example.com/a" },
        { title: "No link here", highlights: ["orphaned"] },
        { url: "", title: "Empty link" },
        { url: "https://example.com/b", title: "B", highlights: "not an array" },
        // An array with entries that are not excerpts. Each is dropped rather
        // than stringified: `[object Object]` is not something to show a model
        // as what a page says.
        { url: "https://example.com/c", title: "C", highlights: [null, "real one", { a: 1 }, 7] },
        { url: "https://example.com/d", title: "D", highlights: [null, 42] },
      ],
    });

    expect(references).toEqual([
      { title: "", url: "https://example.com/a", snippet: "" },
      { title: "B", url: "https://example.com/b", snippet: "" },
      { title: "C", url: "https://example.com/c", snippet: "real one" },
      { title: "D", url: "https://example.com/d", snippet: "" },
    ]);
  });

  it.each([[null], [{}], [{ results: "soon" }], ["a string"]])(
    "refuses %o rather than reporting it as an empty web",
    (payload) => {
      // "Exa did not answer with a search" and "nothing was found" are
      // different facts, and only one of them is safe to hand a model.
      expect(() => exaWebSearchProvider({ apiKey: KEY }).read(payload)).toThrow(
        "not an Exa search answer",
      );
    },
  );

  /**
   * Exa is the first shipped provider that POSTs, so this is the first time a
   * body and a credential header go through the real boundary together.
   */
  it("sends the body and the key through the boundary, and nothing else", async () => {
    const seen: { method?: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
    const server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        seen.push({
          method: request.method,
          headers: request.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            results: [{ title: "Runes", url: "https://svelte.dev/x", highlights: ["a rune"] }],
          }),
        );
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    const provider = exaWebSearchProvider({ apiKey: KEY });
    const search = createWebSearch({
      // Aimed at the local server, which is the one thing a test must change.
      provider: {
        ...provider,
        describe: (request) => ({
          ...provider.describe(request),
          url: `http://localhost:${port}/search`,
        }),
      },
    });

    const results = await search.search({ query: "runes", signal: new AbortController().signal });

    expect(seen[0]?.method).toBe("POST");
    expect(JSON.parse(seen[0]?.body ?? "{}")).toMatchObject({
      query: "runes",
      contents: { highlights: true },
    });
    // The key reached the header Exa asks for.
    expect(seen[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
    // And no ambient session rode along with it.
    expect(seen[0]?.headers.cookie).toBeUndefined();
    // Volli framed the body itself rather than letting the provider declare it.
    expect(seen[0]?.headers["content-type"]).toBe("application/json");
    expect(results.references[0]?.url).toBe("https://svelte.dev/x");
  });
});
