import type { AuthConfig } from "convex/server";

/**
 * Identity providers this deployment trusts.
 *
 * The real sign-in provider is added by the accounts work. Until then the only
 * provider is the TEST one: the local-backend fixture (`fixture/jwt.ts`) sets
 * `VOLLI_TEST_JWKS` on its own throwaway backend so tests can act as any user.
 * A deployment without that variable trusts no test issuer, and no cloud
 * deployment may ever set it.
 */
export const TEST_ISSUER = "https://test.volli.invalid";
export const TEST_AUDIENCE = "volli-test";

// The backend throws on reading an unset variable while it evaluates this
// file (rather than returning `undefined`), so absence is caught, not tested.
function optionalEnv(name: string): string | undefined {
  try {
    return process.env[name];
  } catch {
    return undefined;
  }
}

const testJwks = optionalEnv("VOLLI_TEST_JWKS");

export default {
  providers: testJwks
    ? [
        {
          type: "customJwt",
          issuer: TEST_ISSUER,
          applicationID: TEST_AUDIENCE,
          algorithm: "ES256",
          jwks: testJwks,
        },
      ]
    : [],
} satisfies AuthConfig;
