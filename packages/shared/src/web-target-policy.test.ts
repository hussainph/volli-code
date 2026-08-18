import { describe, expect, it } from "vite-plus/test";

import { admitWebTarget } from "./web-target-policy";

describe("web target admission", () => {
  it("admits an ordinary public https URL and says where to connect", () => {
    expect(admitWebTarget("https://example.com/docs/intro")).toEqual({
      outcome: "admit",
      target: {
        url: "https://example.com/docs/intro",
        scheme: "https",
        hostname: "example.com",
        port: 443,
      },
    });
  });

  /**
   * The refusal that makes the rest of the policy meaningful: everything below
   * reasons about hosts and addresses, and a scheme that never resolves a host
   * would walk straight past all of it. `file:` and `data:` read local bytes
   * with no network involved at all.
   */
  it.each([
    "file:///etc/passwd",
    "data:text/html,<h1>hi",
    "javascript:fetch('/')",
    "ftp://example.com/x",
    "ws://example.com",
    "about:blank",
    "volli://ticket/VC-31",
  ])("refuses %s, which is not a web read at all", (input) => {
    expect(admitWebTarget(input)).toEqual({
      outcome: "refuse",
      rule: "target.scheme",
      reason: expect.stringContaining("http"),
    });
  });

  /**
   * `https://evil.com@example.com/` reads as host `example.com` to a parser and
   * as `evil.com` to a person skimming it. Volli attaches no credentials to a
   * web read, so a URL carrying them is refused rather than silently stripped —
   * stripping would quietly fetch a different resource than the one requested.
   */
  it.each([
    "https://user:pass@example.com/",
    "https://user@example.com/",
    "https://evil.com@example.com/",
  ])("refuses %s rather than choosing which half is the host", (input) => {
    expect(admitWebTarget(input)).toMatchObject({
      outcome: "refuse",
      rule: "target.credentials",
    });
  });

  /**
   * A deliberately narrower policy than the Internet. Admin and database
   * services live on other ports, and refusing them removes a whole class of
   * target without having to argue that reaching them is harmless. An explicit
   * `:443` is the same target as none at all, so it is admitted and normalized.
   */
  it.each([
    ["https://example.com:8080/", "a non-web port"],
    ["https://example.com:22/", "SSH"],
    ["http://example.com:6379/", "Redis"],
    ["http://example.com:5432/", "Postgres"],
  ])("refuses %s (%s)", (input) => {
    expect(admitWebTarget(input)).toMatchObject({ outcome: "refuse", rule: "target.port" });
  });

  it("treats an explicitly spelled default port as the same target", () => {
    expect(admitWebTarget("https://example.com:443/a")).toMatchObject({
      outcome: "admit",
      target: { port: 443, url: "https://example.com/a" },
    });
    expect(admitWebTarget("http://example.com:80/a")).toMatchObject({
      outcome: "admit",
      target: { port: 80, url: "http://example.com/a" },
    });
  });

  /**
   * Refused by name, before anything resolves them. This is defence in depth and
   * a legible error, *not* the control that makes loopback and metadata
   * unreachable — a hostname the operator owns can point at any of them, and
   * only address classification catches that. Both halves ship or neither works.
   *
   * The trailing-dot and `.localhost` spellings are here because a resolver
   * treats them as the same name and a naive string compare does not.
   */
  it.each([
    "http://localhost/",
    "http://localhost./",
    "http://LocalHost/",
    "http://app.localhost/",
    "http://metadata.google.internal/computeMetadata/v1/",
    "http://metadata/",
  ])("refuses %s by name before any lookup happens", (input) => {
    expect(admitWebTarget(input)).toMatchObject({ outcome: "refuse", rule: "target.host" });
  });

  it("does not refuse a public name that merely contains a blocked one", () => {
    // `localhost.example.com` is an ordinary public name, and a substring match
    // would refuse it. The rule is about labels, not text.
    expect(admitWebTarget("https://localhost.example.com/")).toMatchObject({ outcome: "admit" });
    expect(admitWebTarget("https://mylocalhost.dev/")).toMatchObject({ outcome: "admit" });
  });

  /**
   * A URL can skip DNS entirely by naming an address outright, and the name
   * blocklist above never sees it. `https://169.254.169.254/` is the AWS
   * metadata service written as a perfectly ordinary URL; admitting it here on
   * the grounds that the runtime will check addresses later would mean the
   * check depends on a caller remembering to make it.
   */
  it.each([
    "https://169.254.169.254/latest/meta-data/",
    "http://127.0.0.1:80/",
    "https://10.0.0.1/",
    "https://192.168.1.1/",
    "http://[::1]/",
    "http://[fd00:ec2::254]/",
    "https://[::ffff:127.0.0.1]/",
  ])("refuses literal address %s without waiting for a lookup", (input) => {
    expect(admitWebTarget(input)).toMatchObject({ outcome: "refuse", rule: "target.address" });
  });

  it("still admits a public address written literally", () => {
    expect(admitWebTarget("https://93.184.216.34/")).toMatchObject({
      outcome: "admit",
      target: { hostname: "93.184.216.34" },
    });
    // Brackets are URL syntax, not part of the address the runtime resolves or
    // pins to, so an admitted target carries the bare form.
    expect(admitWebTarget("https://[2606:4700:4700::1111]/")).toMatchObject({
      outcome: "admit",
      target: { hostname: "2606:4700:4700::1111" },
    });
  });

  /**
   * The classic bypass list. Every one of these is 127.0.0.1 wearing a costume,
   * and each is refused because WHATWG `URL` canonicalizes the spelling before
   * this policy looks at it — verified behaviour, not an assumption, and pinned
   * here because the whole literal-address rule rests on it.
   */
  it.each([
    "http://0177.0.0.1/",
    "http://2130706433/",
    "http://0x7f.0.0.1/",
    "http://127.1/",
    "http://0/",
    "http://[::ffff:7f00:1]/",
  ])("refuses %s, which is loopback in another spelling", (input) => {
    expect(admitWebTarget(input)).toMatchObject({ outcome: "refuse", rule: "target.address" });
  });
});
