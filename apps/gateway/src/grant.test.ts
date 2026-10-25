import { GATEWAY_AUDIENCE } from "@volli/shared/cloud";
import { describe, expect, test, vi } from "vite-plus/test";

import { createDevIssuer, signJws } from "../scripts/dev-credentials.ts";
import { context, fixture, grant } from "../test/support.ts";
import { toBase64Url, utf8 } from "./bytes.ts";
import {
  CLOCK_SKEW_SECONDS,
  IssuerKeys,
  JWKS_FETCH_TIMEOUT_MS,
  JWKS_REFETCH_INTERVAL_MS,
  JWKS_TTL_MS,
  verifyGrant,
} from "./grant.ts";

const NOW_S = 2_000_000_000;
const NOW = NOW_S * 1000;

async function setup() {
  const f = await fixture();
  const keys = new IssuerKeys({ inline: f.issuer.jwks }, vi.fn(), () => NOW);
  return {
    f,
    keys,
    verify: (token: string, nowMs = NOW) =>
      verifyGrant(token, { issuer: f.issuer.issuer, keys, nowMs, waitUntil: context() }),
  };
}

describe("verifyGrant", () => {
  test("accepts a grant the dev issuer minted, so the dev CLI's audience is the gateway's", async () => {
    const { f, verify } = await setup();
    const result = await verify(await grant(f, { issuedAt: NOW_S }));
    expect(result.ok && result.claims.aud).toBe(GATEWAY_AUDIENCE);
  });

  test("expiry, with clock skew either way", async () => {
    const { f, verify } = await setup();
    const token = await grant(f, { issuedAt: NOW_S - 600, lifetimeSeconds: 600 });
    expect((await verify(token)).ok).toBe(true);
    expect(await verify(token, NOW + CLOCK_SKEW_SECONDS * 1000)).toEqual({
      ok: false,
      code: "volli_grant_expired",
    });
  });

  test("refuses a grant issued in the future or claiming a long life", async () => {
    const { f, verify } = await setup();
    expect(await verify(await grant(f, { issuedAt: NOW_S + CLOCK_SKEW_SECONDS + 1 }))).toEqual({
      ok: false,
      code: "volli_grant_invalid",
    });
    expect(await verify(await grant(f, { issuedAt: NOW_S, lifetimeSeconds: 1201 }))).toEqual({
      ok: false,
      code: "volli_grant_invalid",
    });
    // Expiring before it was issued, even inside the skew window.
    expect(await verify(await grant(f, { issuedAt: NOW_S + 30, lifetimeSeconds: -10 }))).toEqual({
      ok: false,
      code: "volli_grant_invalid",
    });
  });

  test("refuses another issuer, another audience and a malformed claim set", async () => {
    const { f, verify } = await setup();
    for (const claims of [
      { iss: "https://elsewhere.example" },
      { aud: "volli-runner" },
      { routes: {} },
    ]) {
      expect(await verify(await grant(f, { issuedAt: NOW_S, claims }))).toEqual({
        ok: false,
        code: "volli_grant_invalid",
      });
    }
  });

  test("refuses a grant signed by another key under the same kid", async () => {
    const { f, verify } = await setup();
    const impostor = { ...(await createDevIssuer(f.issuer.issuer, f.issuer.kid)) };
    const token = await signJws(impostor, { iss: f.issuer.issuer });
    expect(await verify(token)).toEqual({ ok: false, code: "volli_grant_invalid" });
  });

  test("refuses an unknown kid", async () => {
    const { f, verify } = await setup();
    const token = await signJws(f.issuer, {}, { kid: "unknown" });
    expect(await verify(token)).toEqual({ ok: false, code: "volli_grant_invalid" });
  });

  test.each([
    ["two parts", "a.b"],
    ["an unreadable header", "!!.e30.AAAA"],
    ["a header that is not JSON", `${toBase64Url(utf8("{"))}.e30.AAAA`],
  ])("refuses %s", async (_label, token) => {
    const { verify } = await setup();
    expect(await verify(token)).toEqual({ ok: false, code: "volli_grant_invalid" });
  });

  test("refuses other algorithms, a missing kid, crit headers and short signatures", async () => {
    const { f, verify } = await setup();
    for (const header of [{ alg: "HS256" }, { alg: "none" }, { kid: 1 }, { crit: ["exp"] }]) {
      expect(await verify(await signJws(f.issuer, {}, header))).toEqual({
        ok: false,
        code: "volli_grant_invalid",
      });
    }
    const [h, p] = (await grant(f)).split(".");
    expect(await verify(`${h}.${p}.${toBase64Url(new Uint8Array(63))}`)).toEqual({
      ok: false,
      code: "volli_grant_invalid",
    });
  });

  test("a payload that is not JSON fails after a valid signature", async () => {
    const { f, verify } = await setup();
    const key = await crypto.subtle.importKey(
      "jwk",
      f.issuer.privateJwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
    const input = `${toBase64Url(utf8(JSON.stringify({ alg: "ES256", kid: f.issuer.kid })))}.${toBase64Url(utf8("nope"))}`;
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      utf8(input),
    );
    expect(await verify(`${input}.${toBase64Url(new Uint8Array(signature))}`)).toEqual({
      ok: false,
      code: "volli_grant_invalid",
    });
  });
});

describe("IssuerKeys", () => {
  const URL_SOURCE = { url: "https://issuer.example/jwks" };

  test("a JWKS with no usable keys is the gateway's misconfiguration", async () => {
    const skip = JSON.stringify({
      keys: [
        { kty: "RSA", kid: "r" },
        { kty: "EC", crv: "P-384", kid: "p" },
        { kty: "EC", crv: "P-256" },
        { kty: "EC", crv: "P-256", kid: "k" },
        null,
      ],
    });
    const keys = new IssuerKeys({ inline: skip }, vi.fn(), () => NOW);
    expect(await keys.lookup("k", context())).toEqual({
      ok: false,
      code: "volli_gateway_misconfigured",
    });
  });

  test("an inline JWKS that does not parse is the gateway's misconfiguration", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const inline of ["{", "{}"]) {
      const keys = new IssuerKeys({ inline }, vi.fn(), () => NOW);
      expect(await keys.lookup("k", context())).toEqual({
        ok: false,
        code: "volli_gateway_misconfigured",
      });
    }
    error.mockRestore();
  });

  test("a JWKS URL is fetched with a timeout, cached, and refreshed in the background after its TTL", async () => {
    const issuer = await createDevIssuer();
    let now = NOW;
    const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) => new Response(issuer.jwks));
    const keys = new IssuerKeys(URL_SOURCE, fetchFn, () => now);
    expect((await keys.lookup(issuer.kid, context())).ok).toBe(true);
    expect(fetchFn.mock.calls[0]![1]!.signal).toBeInstanceOf(AbortSignal);
    expect((await keys.lookup(issuer.kid, context())).ok).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    now += JWKS_TTL_MS;
    const ctx = context();
    // The held key answers at once; the refresh runs through waitUntil.
    expect((await keys.lookup(issuer.kid, ctx)).ok).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    await ctx.settled();
    // One refresh at a time: a request during it does not start another.
    expect((await keys.lookup(issuer.kid, context())).ok).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  test("a hanging JWKS endpoint never holds up a request once keys are held", async () => {
    const issuer = await createDevIssuer();
    let now = NOW;
    let hang = false;
    const fetchFn = vi.fn(async () =>
      hang ? new Promise<Response>(() => {}) : new Response(issuer.jwks),
    );
    const keys = new IssuerKeys(URL_SOURCE, fetchFn, () => now);
    await keys.lookup(issuer.kid, context());
    hang = true;
    now += JWKS_TTL_MS;
    expect((await keys.lookup(issuer.kid, context())).ok).toBe(true);
    expect(JWKS_FETCH_TIMEOUT_MS).toBeLessThan(JWKS_REFETCH_INTERVAL_MS);
  });

  test("an unknown kid refetches at a bounded rate, so a rotation is picked up", async () => {
    const before = await createDevIssuer(undefined, "old");
    const after = await createDevIssuer(undefined, "new");
    let now = NOW;
    let served = before.jwks;
    const fetchFn = vi.fn(async () => new Response(served));
    const keys = new IssuerKeys(URL_SOURCE, fetchFn, () => now);
    expect((await keys.lookup("old", context())).ok).toBe(true);
    served = after.jwks;
    expect(await keys.lookup("new", context())).toEqual({ ok: false, code: "volli_grant_invalid" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    now += JWKS_REFETCH_INTERVAL_MS;
    expect((await keys.lookup("new", context())).ok).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  test("an inline JWKS never refetches for an unknown kid", async () => {
    const issuer = await createDevIssuer();
    let now = NOW;
    const keys = new IssuerKeys({ inline: issuer.jwks }, vi.fn(), () => now);
    await keys.lookup(issuer.kid, context());
    now += JWKS_REFETCH_INTERVAL_MS;
    expect(await keys.lookup("other", context())).toEqual({
      ok: false,
      code: "volli_grant_invalid",
    });
  });

  test("a failing JWKS endpoint keeps the keys already held and retries after the refetch interval", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const issuer = await createDevIssuer();
    let now = NOW;
    let healthy = true;
    const fetchFn = vi.fn(async () =>
      healthy ? new Response(issuer.jwks) : new Response("down", { status: 503 }),
    );
    const keys = new IssuerKeys(URL_SOURCE, fetchFn, () => now);
    expect((await keys.lookup(issuer.kid, context())).ok).toBe(true);
    healthy = false;
    now += JWKS_TTL_MS;
    const ctx = context();
    expect((await keys.lookup(issuer.kid, ctx)).ok).toBe(true);
    await ctx.settled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("JWKS answered 503"));
    expect(fetchFn).toHaveBeenCalledTimes(2);
    now += JWKS_REFETCH_INTERVAL_MS - 1;
    await keys.lookup(issuer.kid, context());
    expect(fetchFn).toHaveBeenCalledTimes(2);
    healthy = true;
    now += 1;
    const again = context();
    await keys.lookup(issuer.kid, again);
    await again.settled();
    expect(fetchFn).toHaveBeenCalledTimes(3);
    error.mockRestore();
  });

  test("with no keys held, an unreachable endpoint is retried only after the refetch interval", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    let now = NOW;
    const fetchFn = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const keys = new IssuerKeys(URL_SOURCE, fetchFn, () => now);
    expect(await keys.lookup("k", context())).toEqual({
      ok: false,
      code: "volli_gateway_misconfigured",
    });
    expect(await keys.lookup("k", context())).toEqual({
      ok: false,
      code: "volli_gateway_misconfigured",
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    now += JWKS_REFETCH_INTERVAL_MS;
    await keys.lookup("k", context());
    expect(fetchFn).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });
});
