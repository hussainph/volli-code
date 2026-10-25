import { createPublicKey, verify } from "node:crypto";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  DEV_AUDIENCE,
  DEV_CLIENT_ID,
  DEV_ISSUER,
  DEV_KEY_ID,
  devIssuerProvider,
  startDevIssuer,
  type DevIssuer,
} from "./dev-issuer";
import { readJwtClaims } from "./jwt";
import { createPkcePair } from "./pkce";
import { isProviderRefused } from "./provider";
import { testKeyPair } from "./test-support";

const REDIRECT = "http://127.0.0.1:49152/auth/callback";
const running: DevIssuer[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((issuer) => issuer.close()));
});

async function startedIssuer(options: Partial<Parameters<typeof startDevIssuer>[0]> = {}) {
  const key = testKeyPair();
  const started = await startDevIssuer({ privateKeyPem: key.privateKeyPem, ...options });
  running.push(started);
  return { ...started, key };
}

/** Follows `/authorize` by hand: the code its redirect carries. */
async function authorize(baseUrl: string, query: Record<string, string>): Promise<Response> {
  return fetch(`${baseUrl}/authorize?${new URLSearchParams(query)}`, { redirect: "manual" });
}

function authorizeQuery(challenge: string, overrides: Record<string, string> = {}) {
  return {
    response_type: "code",
    client_id: DEV_CLIENT_ID,
    redirect_uri: REDIRECT,
    state: "st",
    code_challenge: challenge,
    code_challenge_method: "S256",
    provider: "github",
    ...overrides,
  };
}

const token = (baseUrl: string, form: Record<string, string>) =>
  fetch(`${baseUrl}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: DEV_CLIENT_ID, ...form }),
  });

describe("the dev issuer", () => {
  it("approves at once with a code for the loopback redirect, then trades it once for the verifier", async () => {
    const { baseUrl, key } = await startedIssuer({
      subject: "dana",
      displayName: "Dana",
      email: "d@x.test",
    });
    const pkce = createPkcePair();
    const redirect = await authorize(baseUrl, authorizeQuery(pkce.challenge));
    expect(redirect.status).toBe(302);
    const location = new URL(redirect.headers.get("location")!);
    expect(location.origin + location.pathname).toBe(REDIRECT);
    expect(location.searchParams.get("state")).toBe("st");
    const code = location.searchParams.get("code")!;

    const wrongVerifier = await token(baseUrl, {
      grant_type: "authorization_code",
      code,
      code_verifier: createPkcePair().verifier,
      redirect_uri: REDIRECT,
    });
    expect(wrongVerifier.status).toBe(400);
    // The code was spent by the failed attempt too: single use.
    const replay = await token(baseUrl, {
      grant_type: "authorization_code",
      code,
      code_verifier: pkce.verifier,
      redirect_uri: REDIRECT,
    });
    expect(replay.status).toBe(400);

    const fresh = new URL(
      (await authorize(baseUrl, authorizeQuery(pkce.challenge))).headers.get("location")!,
    ).searchParams.get("code")!;
    const granted = await token(baseUrl, {
      grant_type: "authorization_code",
      code: fresh,
      code_verifier: pkce.verifier,
      redirect_uri: REDIRECT,
    });
    expect(granted.status).toBe(200);
    const body = (await granted.json()) as Record<string, string>;
    const claims = readJwtClaims(body["access_token"]!)!;
    expect(claims).toMatchObject({
      iss: DEV_ISSUER,
      aud: DEV_AUDIENCE,
      sub: "dev:dana",
      name: "Dana",
      email: "d@x.test",
      email_verified: true,
    });
    const [header, payload, signature] = body["access_token"]!.split(".");
    expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toMatchObject({
      kid: DEV_KEY_ID,
    });
    expect(
      verify(
        "sha256",
        Buffer.from(`${header}.${payload}`),
        { key: createPublicKey(key.privateKeyPem), dsaEncoding: "ieee-p1363" },
        Buffer.from(signature!, "base64url"),
      ),
    ).toBe(true);

    // Refresh tokens rotate: each is good once.
    const refreshed = await token(baseUrl, {
      grant_type: "refresh_token",
      refresh_token: body["refresh_token"]!,
    });
    expect(refreshed.status).toBe(200);
    const again = await token(baseUrl, {
      grant_type: "refresh_token",
      refresh_token: body["refresh_token"]!,
    });
    expect(again.status).toBe(400);
  });

  it("refuses a redirect that is not loopback http, and a malformed request", async () => {
    const { baseUrl } = await startedIssuer();
    const { challenge } = createPkcePair();
    const malformed: Record<string, string>[] = [
      { redirect_uri: "https://evil.test/callback" },
      { redirect_uri: "http://localhost:1234/callback" },
      { redirect_uri: "http://127.0.0.1/callback" },
      { redirect_uri: "not a url" },
      { code_challenge_method: "plain" },
      { client_id: "someone-else" },
      { provider: "apple" },
      { response_type: "token" },
    ];
    for (const overrides of malformed) {
      expect((await authorize(baseUrl, authorizeQuery(challenge, overrides))).status).toBe(400);
    }
    expect((await token(baseUrl, { grant_type: "password" })).status).toBe(400);
    const otherClient = await fetch(`${baseUrl}/token`, {
      method: "POST",
      body: new URLSearchParams({ client_id: "x", grant_type: "refresh_token" }),
    });
    expect(otherClient.status).toBe(401);
    expect((await fetch(`${baseUrl}/nowhere`)).status).toBe(404);
  });

  it("expires a code that waited too long", async () => {
    let clock = 1_000_000;
    const { baseUrl } = await startedIssuer({ now: () => clock });
    const pkce = createPkcePair();
    const code = new URL(
      (await authorize(baseUrl, authorizeQuery(pkce.challenge))).headers.get("location")!,
    ).searchParams.get("code")!;
    clock += 61_000;
    const late = await token(baseUrl, {
      grant_type: "authorization_code",
      code,
      code_verifier: pkce.verifier,
      redirect_uri: REDIRECT,
    });
    expect(late.status).toBe(400);
  });
});

describe("the dev issuer provider adapter", () => {
  it("starts the issuer on first use, signs in through it and refreshes", async () => {
    const key = testKeyPair();
    const provider = devIssuerProvider({ privateKeyPem: key.privateKeyPem });
    try {
      expect(provider.kind).toBe("dev");
      expect(provider.logoutUrl("anything")).toBeNull();
      const pkce = createPkcePair();
      const url = new URL(
        await provider.authorizationUrl({
          redirectUri: REDIRECT,
          state: "st",
          codeChallenge: pkce.challenge,
          connection: "google",
        }),
      );
      expect(url.searchParams.get("provider")).toBe("google");
      const code = new URL(
        (await fetch(url, { redirect: "manual" })).headers.get("location")!,
      ).searchParams.get("code")!;
      const tokens = await provider.exchangeCode({
        code,
        codeVerifier: pkce.verifier,
        redirectUri: REDIRECT,
      });
      expect(tokens.profile).toEqual({
        displayName: "Dev User",
        email: "dev-user@volli.invalid",
      });
      expect(tokens.sessionId).toMatch(/^dev_session_/u);
      expect(tokens.accessExpiresAt).toBeGreaterThan(Date.now());
      const refreshed = await provider.refresh(tokens.refreshToken);
      expect(refreshed.refreshToken).not.toBe(tokens.refreshToken);
      const refused = await provider.refresh(tokens.refreshToken).catch((error: unknown) => error);
      expect(isProviderRefused(refused)).toBe(true);
    } finally {
      provider.dispose?.();
    }
  });
});

describe("the dev issuer's refresh tokens", () => {
  it("are good across a relaunch with the same key, once, and only from that key", async () => {
    const key = testKeyPair();
    const first = await startDevIssuer({ privateKeyPem: key.privateKeyPem });
    const pkce = createPkcePair();
    const code = new URL(
      (await authorize(first.baseUrl, authorizeQuery(pkce.challenge))).headers.get("location")!,
    ).searchParams.get("code")!;
    const granted = (await (
      await token(first.baseUrl, {
        grant_type: "authorization_code",
        code,
        code_verifier: pkce.verifier,
        redirect_uri: REDIRECT,
      })
    ).json()) as Record<string, string>;
    await first.close();

    const relaunched = await startDevIssuer({ privateKeyPem: key.privateKeyPem });
    running.push(relaunched);
    const refresh = { grant_type: "refresh_token", refresh_token: granted["refresh_token"]! };
    const refreshed = await token(relaunched.baseUrl, refresh);
    expect(refreshed.status).toBe(200);
    const body = (await refreshed.json()) as Record<string, string>;
    // The same person and provider session as before the relaunch.
    expect(readJwtClaims(body["access_token"]!)).toMatchObject({
      sub: readJwtClaims(granted["access_token"]!)!["sub"],
      sid: readJwtClaims(granted["access_token"]!)!["sid"],
    });
    expect((await token(relaunched.baseUrl, refresh)).status).toBe(400);

    const other = await startedIssuer();
    expect(
      (
        await token(other.baseUrl, {
          grant_type: "refresh_token",
          refresh_token: body["refresh_token"]!,
        })
      ).status,
    ).toBe(400);
    // An access token is not a refresh token.
    expect(
      (
        await token(relaunched.baseUrl, {
          grant_type: "refresh_token",
          refresh_token: body["access_token"]!,
        })
      ).status,
    ).toBe(400);
    expect(
      (await token(relaunched.baseUrl, { grant_type: "refresh_token", refresh_token: "a.b" }))
        .status,
    ).toBe(400);
  });
});
