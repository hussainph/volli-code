import { describe, expect, it } from "vite-plus/test";

import type { ResolvedWebAccess } from "./settings";
import { webPortsFor, webSearchProviderFor } from "./ports";

const KEY = "BSA-super-secret-brave-key-42";

const brave: ResolvedWebAccess = { configured: true, provider: "brave", apiKey: KEY };
const searxng: ResolvedWebAccess = {
  configured: true,
  provider: "searxng",
  endpoint: "http://localhost:8888/",
};

describe("what a Session is offered", () => {
  it("offers nothing at all when nothing is configured", () => {
    for (const reason of ["off", "no-key", "unreadable-key", "no-endpoint"] as const) {
      const ports = webPortsFor({ configured: false, reason });

      // Absent, not present-and-failing: the runtime registers a tool only when
      // the field exists, so an unconfigured Session is offered no web tool to
      // call rather than one that refuses when called.
      expect("webSearch" in ports).toBe(false);
      expect("webFetch" in ports).toBe(false);
      expect(ports).toEqual({});
    }
  });

  it("offers both a read and a search once a provider is configured", () => {
    for (const access of [brave, searxng]) {
      const ports = webPortsFor(access);

      expect(typeof ports.webFetch).toBe("function");
      expect(typeof ports.webSearch).toBe("function");
    }
  });
});

describe("the provider a resolved setting builds", () => {
  it("builds none when nothing is configured", () => {
    expect(webSearchProviderFor({ configured: false, reason: "off" })).toBeNull();
  });

  it("hands Brave the stored key, in the header Brave documents and nowhere else", () => {
    const provider = webSearchProviderFor(brave);

    expect(provider?.id).toBe("brave");
    const call = provider?.describe({ query: "how do people test electron main", limit: 8 });
    expect(call?.headers?.["x-subscription-token"]).toBe(KEY);
    // Not in the URL: URLs are logged by every hop, pasted into issues, and
    // shown on screen.
    expect(call?.url).not.toContain(KEY);
    expect(
      JSON.stringify({ url: call?.url, method: call?.method, body: call?.body }),
    ).not.toContain(KEY);
  });

  it("aims SearXNG at the configured instance and sends no credential at all", () => {
    const provider = webSearchProviderFor(searxng);

    expect(provider?.id).toBe("searxng");
    const call = provider?.describe({ query: "searxng json format", limit: 8 });
    expect(call?.url.startsWith("http://localhost:8888/search?")).toBe(true);
    expect(call?.headers ?? {}).toEqual({});
  });
});
