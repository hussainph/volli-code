/**
 * The search boundary, exercised through the only thing it exports: `search`.
 *
 * Two kinds of test, the same split `safe-fetch.test.ts` is written to. The
 * server-backed ones run a real `node:http` server and let a real client talk to
 * it, so streaming, status handling, byte counting and cancellation are proven
 * against Node rather than a hand-written double. The option-level ones assert
 * what Volli hands the socket — the method, the exact header set, the body, and
 * the pinned lookup's answers — which is where the credential rule and the
 * rebinding defence are actually visible.
 *
 * A self-hosted endpoint is loopback by definition, so those tests need no
 * transport seam at all: `http://127.0.0.1:<port>` is a *real* admitted endpoint
 * and the whole path from admission through the socket runs unmocked. Only the
 * public-endpoint tests rewrite the port, because a test server cannot listen on
 * 443 and a public policy would refuse loopback.
 *
 * The provider is a stub in almost every test here on purpose. The two shipped
 * providers are proven in their own files; what this file has to prove is that
 * the boundary treats *any* provider the same way, so the stubs deliberately
 * speak JSON shapes neither Brave nor SearXNG uses.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { createSafeWebFetch } from "./safe-fetch";
import {
  createWebSearch,
  WebSearchRefusal,
  WEB_SEARCH_LIMITS,
  WEB_SEARCH_USER_AGENT,
  type WebSearchCall,
  type WebSearchLimits,
  type WebSearchProvider,
  type WebSearchReference,
  type WebSearchRequestOptions,
} from "./search";

/** A public address the policy admits, so resolution is never the thing under test. */
const PUBLIC_V4 = "93.184.216.34";

/** The key a hostile reader would most like to find. Distinctive so a sweep can look for it. */
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

/** Start a real server and return the loopback origin it is listening on. */
async function serverAt(handler: http.RequestListener): Promise<{
  origin: string;
  port: number;
  requests: { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }[];
}> {
  const requests: {
    method: string;
    url: string;
    headers: http.IncomingHttpHeaders;
    body: string;
  }[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({
        method: request.method ?? "",
        url: request.url ?? "",
        headers: request.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
    });
    handler(request, response);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${port}`, port, requests };
}

/**
 * A provider whose JSON is nobody's: proof that the boundary reads what the
 * provider tells it to and has no opinion of its own about the payload.
 */
function stubProvider(endpoint: string, overrides: Partial<WebSearchProvider> = {}) {
  return {
    id: "stub",
    describe: (request) => {
      const url = new URL(endpoint);
      url.searchParams.set("q", request.query);
      url.searchParams.set("n", String(request.limit));
      return { url: url.href };
    },
    read: (payload) => {
      const items = (payload as { items?: { name: string; link: string; text: string }[] }).items;
      if (items === undefined) throw new Error("no items in this payload");
      return items.map((item) => ({ title: item.name, url: item.link, snippet: item.text }));
    },
    ...overrides,
  } satisfies WebSearchProvider;
}

/** The payload `stubProvider` reads, as a server would serve it. */
function stubPayload(...references: WebSearchReference[]): string {
  return JSON.stringify({
    items: references.map((reference) => ({
      name: reference.title,
      link: reference.url,
      text: reference.snippet,
    })),
  });
}

/** Serve one JSON body, whatever was asked. */
function servingJson(body: string, status = 200): http.RequestListener {
  return (_request, response) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(body);
  };
}

/** A search bound to a public endpoint, with the socket redirected to a real local server. */
function publicSearch(
  provider: WebSearchProvider,
  port: number,
  limits: Partial<WebSearchLimits> = {},
) {
  const sent: WebSearchRequestOptions[] = [];
  const search = createWebSearch({
    provider,
    limits: { ...WEB_SEARCH_LIMITS, ...limits },
    resolve: async () => [{ address: PUBLIC_V4, family: 4 }],
    open: (_scheme, options) => {
      sent.push(options);
      // The recorded options are what Volli meant to send, including `https:`
      // and port 443; what actually goes out is the same request in the clear
      // to a local server, because a test server has no certificate this
      // machine trusts and cannot listen on 443.
      return http.request({
        ...options,
        protocol: "http:",
        port,
        lookup: (_hostname, _options, callback) =>
          callback(null, [{ address: "127.0.0.1", family: 4 }]),
      });
    },
  });
  return { search, sent };
}

const running = () => new AbortController().signal;

/**
 * The refusal a search ended in.
 *
 * Reading the thrown value back through the type it is supposed to be, so a
 * test that asserts something about a refusal's wording cannot quietly pass
 * against a search that succeeded, or against an error of some other kind.
 */
async function refusalFrom(pending: Promise<unknown>): Promise<WebSearchRefusal> {
  try {
    await pending;
  } catch (thrown) {
    if (thrown instanceof WebSearchRefusal) return thrown;
    throw thrown;
  }
  throw new Error("the search resolved where a refusal was expected");
}

describe("web search boundary", () => {
  it("reads a self-hosted instance end to end, with no seam replaced", async () => {
    const server = await serverAt(
      servingJson(
        stubPayload({
          title: "Vitest matchers",
          url: "https://vitest.dev/api/expect",
          snippet: "The matcher reference.",
        }),
      ),
    );
    // No `resolve`, no `open`, no `limits`: production admission, production
    // resolution, a production socket. Loopback is the one address where that
    // is possible without leaving the machine.
    const search = createWebSearch({ provider: stubProvider(`${server.origin}/search`) });

    const results = await search.search({ query: "vitest matchers", signal: running() });

    expect(results).toEqual({
      provider: "stub",
      query: "vitest matchers",
      references: [
        {
          title: "Vitest matchers",
          url: "https://vitest.dev/api/expect",
          snippet: "The matcher reference.",
        },
      ],
      truncated: false,
    });
    expect(server.requests[0]?.url).toBe("/search?q=vitest+matchers&n=8");
  });

  it("refuses an endpoint its own policy refuses, without resolving or connecting", async () => {
    let resolutions = 0;
    let connections = 0;
    const search = createWebSearch({
      provider: stubProvider("http://169.254.169.254/search"),
      resolve: async () => {
        resolutions += 1;
        return [];
      },
      open: () => {
        connections += 1;
        throw new Error("nothing should have opened");
      },
    });

    await expect(search.search({ query: "anything", signal: running() })).rejects.toMatchObject({
      rule: "target.address",
    });
    expect([resolutions, connections]).toEqual([0, 0]);
  });

  it("sends one GET carrying Volli's fixed headers and the provider's own", async () => {
    const provider = stubProvider("https://api.example-search.com/v1/search", {
      describe: (request): WebSearchCall => ({
        url: `https://api.example-search.com/v1/search?q=${encodeURIComponent(request.query)}`,
        headers: { "x-subscription-token": KEY },
      }),
    });
    const server = await serverAt(servingJson(stubPayload()));
    const { search, sent } = publicSearch(provider, server.port);

    await search.search({ query: "tdd", signal: running() });

    expect(sent[0]).toMatchObject({
      method: "GET",
      hostname: "api.example-search.com",
      port: 443,
      path: "/v1/search?q=tdd",
      headers: {
        "user-agent": WEB_SEARCH_USER_AGENT,
        accept: "application/json",
        "accept-encoding": "identity",
        "x-subscription-token": KEY,
      },
      // TLS verifies against the name a person configured, never the pinned
      // address, and nothing here relaxes that.
      servername: "api.example-search.com",
      agent: false,
    });
    expect(sent[0]?.rejectUnauthorized).toBeUndefined();
    expect(Object.keys(sent[0]?.headers ?? {}).toSorted()).toEqual([
      "accept",
      "accept-encoding",
      "user-agent",
      "x-subscription-token",
    ]);
  });

  /**
   * The port's whole claim, stated as a test. A second implementation that
   * shares none of the first's HTTP verb, credential header, request shape or
   * JSON schema runs against the same unchanged boundary — which is the only
   * evidence that Exa or Tavily could be dropped in later without reshaping it.
   */
  it("serves a provider that posts a JSON body and reads a different schema, unchanged", async () => {
    const posting: WebSearchProvider = {
      id: "other",
      describe: (request) => ({
        url: "https://api.other-search.com/search",
        method: "POST",
        headers: { authorization: `Bearer ${KEY}` },
        body: { q: request.query, num_results: request.limit },
      }),
      read: (payload) =>
        (payload as { data: { heading: string; href: string; blurb: string }[] }).data.map(
          (entry) => ({ title: entry.heading, url: entry.href, snippet: entry.blurb }),
        ),
    };
    const server = await serverAt(
      servingJson(
        JSON.stringify({
          data: [{ heading: "Deep modules", href: "https://example.com/deep", blurb: "A book." }],
        }),
      ),
    );
    const { search, sent } = publicSearch(posting, server.port);

    const results = await search.search({ query: "deep modules", signal: running() });

    expect(results).toEqual({
      provider: "other",
      query: "deep modules",
      references: [{ title: "Deep modules", url: "https://example.com/deep", snippet: "A book." }],
      truncated: false,
    });
    expect(sent[0]).toMatchObject({ method: "POST" });
    expect(sent[0]?.headers).toMatchObject({
      authorization: `Bearer ${KEY}`,
      "content-type": "application/json",
    });
    expect(server.requests[0]?.method).toBe("POST");
    expect(server.requests[0]?.body).toBe('{"q":"deep modules","num_results":8}');
  });

  it("refuses to send a header Volli owns, rather than letting a provider set it", async () => {
    const server = await serverAt(servingJson(stubPayload()));
    const { search } = publicSearch(
      stubProvider("https://api.example-search.com/search", {
        describe: () => ({
          url: "https://api.example-search.com/search",
          headers: { cookie: "session=1" },
        }),
      }),
      server.port,
    );

    await expect(search.search({ query: "tdd", signal: running() })).rejects.toMatchObject({
      rule: "search.provider",
    });
    expect(server.requests).toEqual([]);
  });

  it("refuses a provider that describes a body on a request that does not carry one", async () => {
    const server = await serverAt(servingJson(stubPayload()));
    const { search } = publicSearch(
      stubProvider("https://api.example-search.com/search", {
        describe: () => ({ url: "https://api.example-search.com/search", body: { q: "tdd" } }),
      }),
      server.port,
    );

    // A GET with a body is a request Volli would have to guess how to frame,
    // and guessing is how a client and a server come to disagree about where
    // one request ends and the next begins.
    await expect(search.search({ query: "tdd", signal: running() })).rejects.toMatchObject({
      rule: "search.provider",
    });
    expect(server.requests).toEqual([]);
  });

  it("refuses an answer that declares no type at all", async () => {
    const server = await serverAt((_request, response) => {
      response.writeHead(200);
      response.end(stubPayload());
    });
    const search = createWebSearch({
      provider: stubProvider(`http://127.0.0.1:${server.port}/search`),
    });

    // Absent is not "probably JSON". A missing type is the one case where
    // guessing looks harmless and is still guessing.
    await expect(search.search({ query: "tdd", signal: running() })).rejects.toMatchObject({
      rule: "search.type",
    });
  });

  it("keeps a transport failure with no system code inside its own vocabulary", async () => {
    const search = createWebSearch({
      provider: stubProvider("https://api.example-search.com/search"),
      resolve: async () => [{ address: PUBLIC_V4, family: 4 }],
      open: (_scheme, options) => {
        const request = http.request({
          ...options,
          protocol: "http:",
          lookup: () => {},
        });
        setTimeout(() => request.destroy(new Error("the transport gave up")), 0);
        return request;
      },
    });

    // Not every socket failure carries an errno. Whatever arrives, the caller
    // sees a refusal it can name, never a raw Node error from underneath.
    await expect(search.search({ query: "tdd", signal: running() })).rejects.toMatchObject({
      rule: "search.transport",
      message: expect.stringContaining("Error"),
    });
  });

  it("classifies every address a public endpoint resolves to", async () => {
    const search = createWebSearch({
      provider: stubProvider("https://api.example-search.com/search"),
      resolve: async () => [
        { address: PUBLIC_V4, family: 4 },
        { address: "169.254.169.254", family: 4 },
      ],
      open: () => {
        throw new Error("nothing should have opened");
      },
    });

    await expect(search.search({ query: "tdd", signal: running() })).rejects.toMatchObject({
      rule: "search.address",
    });
  });

  it("refuses a public endpoint that resolves to nothing", async () => {
    const search = createWebSearch({
      provider: stubProvider("https://api.example-search.com/search"),
      resolve: async () => [],
    });

    await expect(search.search({ query: "tdd", signal: running() })).rejects.toMatchObject({
      rule: "search.unresolvable",
    });
  });

  it("refuses in its own words when resolution fails outright", async () => {
    const search = createWebSearch({
      provider: stubProvider("https://api.example-search.com/search"),
      resolve: async () => {
        throw new Error("EAI_AGAIN api.example-search.com");
      },
    });

    await expect(search.search({ query: "tdd", signal: running() })).rejects.toMatchObject({
      rule: "search.unresolvable",
    });
  });

  /**
   * The other half of the self-host decision. Admission reads a *name*, and a
   * name resolves wherever its operator points it — so "on this machine" has to
   * be proven against the addresses the socket would reach, or it is a label
   * anybody with a hosts file can claim.
   */
  it("requires a self-hosted endpoint to actually be on this machine", async () => {
    const search = createWebSearch({
      provider: stubProvider("http://searxng.localhost:8888/search"),
      resolve: async () => [{ address: "192.168.1.5", family: 4 }],
      open: () => {
        throw new Error("nothing should have opened");
      },
    });

    await expect(search.search({ query: "tdd", signal: running() })).rejects.toMatchObject({
      rule: "search.address",
    });
  });

  it("connects a self-hosted endpoint only to the loopback addresses it resolved", async () => {
    const server = await serverAt(servingJson(stubPayload()));
    const sent: WebSearchRequestOptions[] = [];
    const search = createWebSearch({
      provider: stubProvider(`http://localhost:${server.port}/search`),
      resolve: async () => [{ address: "127.0.0.1", family: 4 }],
      open: (_scheme, options) => {
        sent.push(options);
        return http.request(options);
      },
    });

    await search.search({ query: "tdd", signal: running() });

    // The pinned lookup is the socket's only answer, asked here with a name it
    // has never heard of: there is no second resolution for anyone to poison.
    const answers = await new Promise((resolve) => {
      sent[0]?.lookup?.("anything.example", { all: true }, (_error, address) => resolve(address));
    });
    expect(answers).toEqual([{ address: "127.0.0.1", family: 4 }]);
  });

  it("reports a redirect rather than following it, so no credential reaches the new host", async () => {
    const server = await serverAt((request, response) => {
      if (request.url?.startsWith("/search") === true) {
        response.writeHead(302, { location: "http://127.0.0.1/stolen" });
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(stubPayload());
    });
    const search = createWebSearch({
      provider: stubProvider(`http://127.0.0.1:${server.port}/search`, {
        describe: () => ({
          url: `http://127.0.0.1:${server.port}/search`,
          headers: { "x-subscription-token": KEY },
        }),
      }),
    });

    const refusal = await refusalFrom(search.search({ query: "tdd", signal: running() }));

    expect(refusal.rule).toBe("search.redirect");
    expect(refusal.message).not.toContain(KEY);
    // One request, so the key went to the endpoint a person configured and
    // nowhere else. A followed redirect is a new origin holding the credential.
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]?.url).toBe("/search");
  });

  it("names the status a provider answered with, and never the key that was sent", async () => {
    const server = await serverAt(servingJson("{}", 401));
    const search = createWebSearch({
      provider: stubProvider(`http://127.0.0.1:${server.port}/search`, {
        describe: () => ({
          url: `http://127.0.0.1:${server.port}/search`,
          headers: { "x-subscription-token": KEY },
        }),
      }),
    });

    const refusal = await refusalFrom(search.search({ query: "tdd", signal: running() }));

    expect(refusal.rule).toBe("search.status");
    // Actionable without being a leak: the model can say "the provider rejected
    // the request" and a person can go and check their key.
    expect(refusal.message).toContain("401");
    expect(refusal.message).not.toContain(KEY);
  });

  it("refuses an answer that is not JSON Volli reads", async () => {
    const server = await serverAt((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<html>results</html>");
    });
    const search = createWebSearch({
      provider: stubProvider(`http://127.0.0.1:${server.port}/search`),
    });

    await expect(search.search({ query: "tdd", signal: running() })).rejects.toMatchObject({
      rule: "search.type",
    });
  });

  it("refuses a compressed answer rather than unbounding its own byte count", async () => {
    const server = await serverAt((_request, response) => {
      response.writeHead(200, {
        "content-type": "application/json",
        "content-encoding": "gzip",
      });
      response.end(gzipSync(Buffer.from(stubPayload())));
    });
    const search = createWebSearch({
      provider: stubProvider(`http://127.0.0.1:${server.port}/search`),
    });

    await expect(search.search({ query: "tdd", signal: running() })).rejects.toMatchObject({
      rule: "search.encoding",
    });
  });

  it("stops a body that runs past the byte bound, counting rather than believing", async () => {
    const server = await serverAt((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      // Chunked with no declared length: counting is the only bound there is.
      const forever = setInterval(() => response.write(" ".repeat(4096)), 1);
      response.on("close", () => clearInterval(forever));
    });
    const search = createWebSearch({
      provider: stubProvider(`http://127.0.0.1:${server.port}/search`),
      limits: { ...WEB_SEARCH_LIMITS, bodyBytes: 16 * 1024 },
    });

    await expect(search.search({ query: "tdd", signal: running() })).rejects.toMatchObject({
      rule: "search.too-large",
    });
  });

  it("refuses a body the server itself declares over the bound, before reading it", async () => {
    const server = await serverAt((_request, response) => {
      response.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(WEB_SEARCH_LIMITS.bodyBytes + 1),
      });
      response.end(" ".repeat(64));
    });
    const search = createWebSearch({
      provider: stubProvider(`http://127.0.0.1:${server.port}/search`),
    });

    await expect(search.search({ query: "tdd", signal: running() })).rejects.toMatchObject({
      rule: "search.too-large",
    });
  });

  it("refuses an answer that is not JSON at all, in Volli's words rather than the parser's", async () => {
    const server = await serverAt(servingJson("{not json"));
    const search = createWebSearch({
      provider: stubProvider(`http://127.0.0.1:${server.port}/search`),
    });

    const refusal = await refusalFrom(search.search({ query: "tdd", signal: running() }));

    expect(refusal.rule).toBe("search.unreadable");
    // The body is the other end's text, and a refusal goes into a ledger and a
    // model's context. Quoting the parser would quote the body.
    expect(refusal.message).not.toContain("not json");
  });

  it("refuses a payload the provider cannot read, without quoting it", async () => {
    const server = await serverAt(servingJson('{"surprise":"<script>alert(1)</script>"}'));
    const search = createWebSearch({
      provider: stubProvider(`http://127.0.0.1:${server.port}/search`),
    });

    const refusal = await refusalFrom(search.search({ query: "tdd", signal: running() }));

    expect(refusal.rule).toBe("search.unreadable");
    expect(refusal.message).not.toContain("script");
  });

  it("hands back at most the reference bound, and says when there were more", async () => {
    const many = Array.from({ length: 12 }, (_unused, index) => ({
      title: `Result ${index}`,
      url: `https://example.com/${index}`,
      snippet: "A snippet.",
    }));
    const server = await serverAt(servingJson(stubPayload(...many)));
    const search = createWebSearch({
      provider: stubProvider(`http://127.0.0.1:${server.port}/search`),
      limits: { ...WEB_SEARCH_LIMITS, references: 3 },
    });

    const results = await search.search({ query: "tdd", signal: running() });

    expect(results.references).toHaveLength(3);
    expect(results.truncated).toBe(true);
  });

  it("claims nothing was left out when the count lands exactly on the bound", async () => {
    const exactly = Array.from({ length: 3 }, (_unused, index) => ({
      title: `Result ${index}`,
      url: `https://example.com/${index}`,
      snippet: "A snippet.",
    }));
    const server = await serverAt(servingJson(stubPayload(...exactly)));
    const search = createWebSearch({
      provider: stubProvider(`http://127.0.0.1:${server.port}/search`),
      limits: { ...WEB_SEARCH_LIMITS, references: 3 },
    });

    const results = await search.search({ query: "tdd", signal: running() });

    // "There were more" is a fact about the provider's answer, not about how
    // full Volli's list came out. A full list that lost nothing must not say it
    // did — a model reading that would go looking for a page nobody has.
    expect(results.references).toHaveLength(3);
    expect(results.truncated).toBe(false);
  });

  it("bounds every field of a reference to one line Volli sized", async () => {
    const server = await serverAt(
      servingJson(
        stubPayload({
          title: `Line one\nLine two\r\n\tLine three${"!".repeat(500)}`,
          url: `https://example.com/${"a".repeat(4000)}`,
          snippet: `A snippet.\n${"b".repeat(2000)}`,
        }),
      ),
    );
    const search = createWebSearch({
      provider: stubProvider(`http://127.0.0.1:${server.port}/search`),
    });

    const [reference] = (await search.search({ query: "tdd", signal: running() })).references;

    // One line each, because these are one-line fields by contract and a
    // newline in them is a third party writing the shape of Volli's own list.
    expect(reference?.title).not.toContain("\n");
    expect(reference?.snippet).not.toContain("\n");
    expect(reference?.title.startsWith("Line one Line two Line three")).toBe(true);
    expect(reference?.title.length).toBeLessThanOrEqual(WEB_SEARCH_LIMITS.titleChars);
    expect(reference?.snippet.length).toBeLessThanOrEqual(WEB_SEARCH_LIMITS.snippetChars);
    expect(reference?.url.length).toBeLessThanOrEqual(WEB_SEARCH_LIMITS.urlChars);
  });

  it("strips the characters a reference could redraw itself with", async () => {
    const server = await serverAt(
      servingJson(
        stubPayload({
          title: "Docs\u202Emoc.live\u202C",
          url: "https://example.com/\u200Bguide",
          snippet: "Safe\uFEFF enough.",
        }),
      ),
    );
    const search = createWebSearch({
      provider: stubProvider(`http://127.0.0.1:${server.port}/search`),
    });

    const [reference] = (await search.search({ query: "tdd", signal: running() })).references;

    // A transcript is read by a person as well as by the model. Bidi overrides
    // reorder what a line appears to say, and zero-width characters hide inside
    // a hostname — both are a third party choosing how its own text renders.
    expect(JSON.stringify(reference)).not.toMatch(/\\u202[ce]|\\u200b|\\ufeff/i);
    expect(reference?.url).toBe("https://example.com/guide");
  });

  it("refuses an answer whose declared encoding is not one JSON arrives in", async () => {
    const server = await serverAt((_request, response) => {
      response.writeHead(200, { "content-type": "application/json; charset=shift_jis" });
      response.end(stubPayload());
    });
    const search = createWebSearch({
      provider: stubProvider(`http://127.0.0.1:${server.port}/search`),
    });

    await expect(search.search({ query: "tdd", signal: running() })).rejects.toMatchObject({
      rule: "search.type",
    });
  });

  it("refuses a query with nothing in it, and one past the bound", async () => {
    const search = createWebSearch({
      provider: stubProvider("https://api.example-search.com/search"),
      resolve: async () => {
        throw new Error("nothing should have resolved");
      },
    });

    await expect(search.search({ query: "   ", signal: running() })).rejects.toMatchObject({
      rule: "search.query",
    });
    await expect(
      search.search({ query: "x".repeat(WEB_SEARCH_LIMITS.queryChars + 1), signal: running() }),
    ).rejects.toMatchObject({ rule: "search.query" });
  });

  it("gives the provider the query as the model wrote it, trimmed of nothing but its edges", async () => {
    const seen: string[] = [];
    const server = await serverAt(servingJson(stubPayload()));
    const search = createWebSearch({
      provider: stubProvider(`http://127.0.0.1:${server.port}/search`, {
        describe: (request) => {
          seen.push(request.query);
          return { url: `http://127.0.0.1:${server.port}/search` };
        },
      }),
    });

    const results = await search.search({
      query: "  site:vitest.dev expect().toBe  ",
      signal: running(),
    });

    expect(seen).toEqual(["site:vitest.dev expect().toBe"]);
    // What comes back says what was asked, so a caller quoting the query is
    // quoting Volli's record of it rather than re-deriving it.
    expect(results.query).toBe("site:vitest.dev expect().toBe");
  });

  it("refuses before it runs when the search was already withdrawn", async () => {
    let resolutions = 0;
    const search = createWebSearch({
      provider: stubProvider("https://api.example-search.com/search"),
      resolve: async () => {
        resolutions += 1;
        return [{ address: PUBLIC_V4, family: 4 }];
      },
    });

    await expect(
      search.search({ query: "tdd", signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ rule: "search.cancelled" });
    expect(resolutions).toBe(0);
  });

  it("does not open a socket for a search withdrawn while its endpoint was resolving", async () => {
    const withdrawn = new AbortController();
    let connections = 0;
    const search = createWebSearch({
      provider: stubProvider("https://api.example-search.com/search"),
      resolve: async () => {
        // The window between "not cancelled yet" and "listening for the
        // cancellation": a DNS answer takes real time, and a turn interrupted
        // inside it must not still put a credential on the wire.
        withdrawn.abort();
        return [{ address: PUBLIC_V4, family: 4 }];
      },
      open: () => {
        connections += 1;
        throw new Error("nothing should have opened");
      },
    });

    await expect(search.search({ query: "tdd", signal: withdrawn.signal })).rejects.toMatchObject({
      rule: "search.cancelled",
    });
    expect(connections).toBe(0);
  });

  it("withdraws a search that is already on the wire", async () => {
    const server = await serverAt(() => {
      // Answers nothing, so only the cancellation can end this.
    });
    const search = createWebSearch({
      provider: stubProvider(`http://127.0.0.1:${server.port}/search`),
    });
    const withdrawn = new AbortController();

    const pending = search.search({ query: "tdd", signal: withdrawn.signal });
    setTimeout(() => withdrawn.abort(), 10);

    await expect(pending).rejects.toMatchObject({ rule: "search.cancelled" });
  });

  it("gives up on a provider that never answers", async () => {
    const server = await serverAt(() => {
      // Silent: the header deadline is the only thing that can end this.
    });
    const search = createWebSearch({
      provider: stubProvider(`http://127.0.0.1:${server.port}/search`),
      limits: { ...WEB_SEARCH_LIMITS, headerMs: 40, totalMs: 10_000 },
    });

    await expect(search.search({ query: "tdd", signal: running() })).rejects.toMatchObject({
      rule: "search.timeout",
    });
  });

  it("gives up on a provider that answers forever", async () => {
    const server = await serverAt((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      // Never idle, so an inactivity timer would never fire.
      const forever = setInterval(() => response.write(" "), 1);
      response.on("close", () => clearInterval(forever));
    });
    const search = createWebSearch({
      provider: stubProvider(`http://127.0.0.1:${server.port}/search`),
      limits: { ...WEB_SEARCH_LIMITS, headerMs: 5_000, totalMs: 60 },
    });

    await expect(search.search({ query: "tdd", signal: running() })).rejects.toMatchObject({
      rule: "search.timeout",
    });
  });

  it("refuses in Volli's words when the connection itself fails", async () => {
    const server = await serverAt((request) => request.destroy());
    const search = createWebSearch({
      provider: stubProvider(`http://127.0.0.1:${server.port}/search`),
    });

    await expect(search.search({ query: "tdd", signal: running() })).rejects.toMatchObject({
      rule: "search.transport",
    });
  });

  it("carries no cookie from one search into the next", async () => {
    const server = await serverAt((_request, response) => {
      response.writeHead(200, {
        "content-type": "application/json",
        "set-cookie": "session=tracked; Path=/",
      });
      response.end(stubPayload());
    });
    const search = createWebSearch({
      provider: stubProvider(`http://127.0.0.1:${server.port}/search`),
    });

    await search.search({ query: "one", signal: running() });
    await search.search({ query: "two", signal: running() });

    expect(server.requests).toHaveLength(2);
    expect(server.requests[1]?.headers.cookie).toBeUndefined();
  });

  /**
   * The rule the research note is emphatic about, proven across the two
   * boundaries rather than asserted in a comment. A URL that came back from a
   * search has been through no policy at all — the search boundary carried it
   * as text and never opened it — so the fetch that reads it starts from
   * nothing. There is deliberately no channel between these two objects for an
   * admission to be cached, marked or passed along in.
   */
  it("leaves a URL it returned exactly as unjudged as any other", async () => {
    const server = await serverAt(
      servingJson(
        stubPayload({
          title: "Totally ordinary docs",
          url: "http://169.254.169.254/latest/meta-data/",
          snippet: "Read this one next.",
        }),
      ),
    );
    const search = createWebSearch({
      provider: stubProvider(`http://127.0.0.1:${server.port}/search`),
    });

    const [reference] = (await search.search({ query: "tdd", signal: running() })).references;

    // It comes back, because filtering results would be a trust judgement made
    // in the wrong place and would imply the survivors had passed one.
    expect(reference?.url).toBe("http://169.254.169.254/latest/meta-data/");
    // And it is refused on the way in, by the whole policy, from scratch.
    await expect(
      createSafeWebFetch().fetch({ url: reference?.url ?? "", signal: running() }),
    ).rejects.toMatchObject({ rule: "target.address" });
  });

  /**
   * The credential rule, swept rather than argued. Every way a search can end
   * badly is driven against a provider holding a distinctive key, and the key
   * must appear in none of the words that come back — a refusal is destined for
   * a transcript, a ledger and a model's context.
   */
  it("keeps the key out of every refusal it can produce", async () => {
    const keyed = (endpoint: string): WebSearchProvider =>
      stubProvider(endpoint, {
        describe: () => ({ url: endpoint, headers: { "x-subscription-token": KEY } }),
      });
    const server = await serverAt(servingJson("{not json", 500));
    const cases: { provider: WebSearchProvider; limits?: Partial<WebSearchLimits> }[] = [
      { provider: keyed("http://169.254.169.254/search") },
      { provider: keyed(`http://127.0.0.1:${server.port}/search`) },
      { provider: keyed(`http://127.0.0.1:${server.port}/search`), limits: { totalMs: 1 } },
    ];

    for (const { provider, limits } of cases) {
      const search = createWebSearch({
        provider,
        limits: limits === undefined ? undefined : { ...WEB_SEARCH_LIMITS, ...limits },
      });
      const error = await refusalFrom(search.search({ query: "tdd", signal: running() }));
      expect(error.message).not.toContain(KEY);
      expect(JSON.stringify(error)).not.toContain(KEY);
      expect(error.stack ?? "").not.toContain(KEY);
    }
  });
});
