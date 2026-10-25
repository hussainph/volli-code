import { createHash, createPublicKey, verify } from "node:crypto";
import { describe, expect, it } from "vite-plus/test";

import { jwtExpiry, readJwtClaims, signEs256Jwt } from "./jwt";
import { createPkcePair, newState, pkceChallenge } from "./pkce";
import { testKeyPair } from "./test-support";

describe("PKCE and state", () => {
  it("makes a fresh S256 pair each time, per RFC 7636", () => {
    const first = createPkcePair();
    const second = createPkcePair();
    expect(first.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(first.challenge).toBe(createHash("sha256").update(first.verifier).digest("base64url"));
    expect(first.verifier).not.toBe(second.verifier);
    expect(pkceChallenge(first.verifier)).toBe(first.challenge);
    expect(newState()).not.toBe(newState());
    expect(newState()).toMatch(/^[A-Za-z0-9_-]{32}$/u);
  });
});

describe("JWTs", () => {
  it("signs an ES256 token a verifier accepts, and reads its claims back", () => {
    const { privateKeyPem } = testKeyPair();
    const publicKey = createPublicKey(privateKeyPem);
    const token = signEs256Jwt(privateKeyPem, "kid-1", { sub: "dev:a", exp: 1_700_000_000 });
    const [header, body, signature] = token.split(".");
    expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toEqual({
      alg: "ES256",
      typ: "JWT",
      kid: "kid-1",
    });
    expect(
      verify(
        "sha256",
        Buffer.from(`${header}.${body}`),
        { key: publicKey, dsaEncoding: "ieee-p1363" },
        Buffer.from(signature!, "base64url"),
      ),
    ).toBe(true);
    expect(readJwtClaims(token)).toEqual({ sub: "dev:a", exp: 1_700_000_000 });
    expect(jwtExpiry(token)).toBe(1_700_000_000_000);
  });

  it("reads nothing from what is not a JWT", () => {
    for (const value of [
      "",
      "a.b",
      "a..c",
      "a.!!!.c",
      `a.${Buffer.from("[1]").toString("base64url")}.c`,
    ]) {
      expect(readJwtClaims(value)).toBeNull();
    }
    const noExp = `a.${Buffer.from(JSON.stringify({ sub: "x" })).toString("base64url")}.c`;
    expect(jwtExpiry(noExp)).toBeNull();
  });
});
