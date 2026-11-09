import { describe, expect, it } from "vite-plus/test";

import { registrableDomainForOrigin } from "./domain";

describe("source icon registrable domain identity", () => {
  it.each([
    ["https://docs.example.com", "example.com"],
    ["https://research.example.co.uk", "example.co.uk"],
    ["http://docs.example.com", "example.com"],
    ["https://project.github.io", "project.github.io"],
    ["https://docs.project.github.io", "project.github.io"],
    ["https://project.appspot.com", "project.appspot.com"],
    // PSL wildcard and exception: a last-two-label rule gets both wrong.
    ["https://a.b.ck", "a.b.ck"],
    ["https://x.www.ck", "www.ck"],
    ["https://www.xn--bcher-kva.de", "xn--bcher-kva.de"],
  ])("uses real public/private suffix data for %s", (origin, domain) => {
    expect(registrableDomainForOrigin(origin)).toBe(domain);
  });

  it.each([
    "https://127.0.0.1",
    "https://8.8.8.8",
    "https://[::1]",
    "https://[2001:4860:4860::8888]",
    "https://localhost",
    "https://service.internal",
    "https://docs.example.invalid",
    "https://example.this-suffix-is-not-in-the-psl",
    "https://com",
    "https://co.uk",
    "https://github.io",
  ])("does not invent a root for %s", (origin) => {
    expect(registrableDomainForOrigin(origin)).toBeNull();
  });

  it.each([
    "",
    "not a URL",
    "example.com",
    "file:///example.com",
    "data:text/plain,https://example.com",
    "ftp://example.com",
    "https://user:password@example.com",
    "https://example.com/",
    "https://example.com/page",
    "https://example.com?token=private",
    "https://example.com#fragment",
    "https://EXAMPLE.com",
    "https://example.com:443",
    `https://${"x".repeat(2048)}.com`,
  ])("accepts canonical web origins only (%#)", (origin) => {
    expect(registrableDomainForOrigin(origin)).toBeNull();
  });

  it("does not conflate private-suffix tenants even though both have an icon cache miss", () => {
    // Identity derives without a cache, bytes, Session lookup or network access.
    // The watch projection must use the same derivation for hits and misses.
    expect(registrableDomainForOrigin("https://alice.github.io")).toBe("alice.github.io");
    expect(registrableDomainForOrigin("https://bob.github.io")).toBe("bob.github.io");
  });
});
