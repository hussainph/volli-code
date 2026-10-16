import { describe, expect, it } from "vite-plus/test";

import { SIGN_IN_CATALOG, signInWebUrl } from "./sign-in-catalog";

describe("Client sign-in catalog", () => {
  it("pins a bounded, exact-domain policy for every bundled browser/device provider", () => {
    expect(SIGN_IN_CATALOG.version).toBe(1);
    expect(SIGN_IN_CATALOG.providers.map((provider) => provider.id)).toEqual([
      "anthropic",
      "openai",
      "openai-codex",
      "github-copilot",
      "openrouter",
      "xai",
      "kimi-coding",
      "meta",
      "radius",
    ]);
    for (const provider of SIGN_IN_CATALOG.providers) {
      expect(provider.authorizationDomains.length).toBeLessThanOrEqual(2);
      for (const host of provider.authorizationDomains) {
        expect(host.length).toBeLessThanOrEqual(253);
        expect(host).toMatch(/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/u);
        expect(new URL(`https://${host}`).host).toBe(host);
      }
    }
    expect(
      SIGN_IN_CATALOG.providers.find((provider) => provider.id === "radius")!.authorizationDomains,
    ).toEqual([]);
  });

  it("offers only bounded HTTP(S) links, independently of domain auto-open policy", () => {
    expect(signInWebUrl("https://off-domain.example/login")?.host).toBe("off-domain.example");
    expect(signInWebUrl("http://localhost:1234/login")?.host).toBe("localhost:1234");
    const prefix = "https://example.com/";
    const atLimit = prefix + "a".repeat(8192 - prefix.length);
    expect(signInWebUrl(atLimit)?.href).toBe(atLimit);
    for (const url of [
      atLimit + "a",
      "not a URL",
      "file:///tmp/key",
      "javascript:alert(1)",
      "ssh://host",
    ]) {
      expect(signInWebUrl(url)).toBeNull();
    }
  });
});
