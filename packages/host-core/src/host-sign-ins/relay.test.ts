import { describe, expect, it } from "vite-plus/test";

import { deliveryMatches, relayTargetOf, replayUrl } from "./relay";

const anthropic =
  "https://claude.ai/oauth/authorize?code=true&client_id=c&response_type=code" +
  "&redirect_uri=http%3A%2F%2Flocalhost%3A53692%2Fcallback&scope=user%3Ainference&state=v";

describe("relayTargetOf", () => {
  it("reads each Pi browser flow's loopback redirect", () => {
    // Anthropic advertises `localhost` and Pi binds 127.0.0.1.
    expect(relayTargetOf(anthropic)).toEqual({
      redirectUri: "http://localhost:53692/callback",
      origin: "http://127.0.0.1:53692",
      path: "/callback",
    });
    // Sign in with ChatGPT and OpenAI Codex: 127.0.0.1:1455.
    expect(
      relayTargetOf(
        "https://auth.openai.com/oauth/authorize?redirect_uri=http%3A%2F%2F127.0.0.1%3A1455%2Fauth%2Fcallback",
      ),
    ).toMatchObject({ origin: "http://127.0.0.1:1455", path: "/auth/callback" });
    // OpenRouter names it `callback_url`, on an ephemeral port and a random path.
    expect(
      relayTargetOf(
        "https://openrouter.ai/auth?callback_url=http%3A%2F%2Flocalhost%3A49152%2Foauth%2Fcallback%2Fabc",
      ),
    ).toMatchObject({ origin: "http://127.0.0.1:49152", path: "/oauth/callback/abc" });
    expect(
      relayTargetOf("https://x.test/a?redirect_uri=http%3A%2F%2F%5B%3A%3A1%5D%3A8080%2Fcb"),
    ).toMatchObject({ origin: "http://[::1]:8080", path: "/cb" });
  });

  it("grants nothing that could point anywhere but this host's own loopback", () => {
    for (const redirect of [
      "https://localhost:53692/callback", // not plain loopback http
      "http://evil.test:53692/callback",
      "http://10.0.0.5:53692/callback",
      "http://localhost/callback", // no port: no listener Pi bound
      "http://user:pass@localhost:1/callback",
      "https://platform.claude.com/oauth/code/callback", // Anthropic's copy-code method
    ]) {
      expect(
        relayTargetOf(`https://p.test/a?redirect_uri=${encodeURIComponent(redirect)}`),
      ).toBeNull();
    }
    expect(relayTargetOf("https://p.test/no-redirect")).toBeNull();
    expect(relayTargetOf("not a url")).toBeNull();
  });
});

describe("deliveryMatches", () => {
  const target = relayTargetOf(anthropic)!;

  it("takes the grant's path with any query, and nothing else", () => {
    expect(deliveryMatches(target, "/callback?code=c&state=s")).toBe(true);
    expect(deliveryMatches(target, "/callback")).toBe(true);
    for (const other of [
      "/callback/../admin",
      "/callbackx?code=c",
      "//evil.test/callback",
      "/callback#frag",
      "/callback?code=a b",
      "http://127.0.0.1:53692/callback",
    ]) {
      expect(deliveryMatches(target, other)).toBe(false);
    }
    expect(replayUrl(target, "/callback?code=c")).toBe("http://127.0.0.1:53692/callback?code=c");
  });
});
