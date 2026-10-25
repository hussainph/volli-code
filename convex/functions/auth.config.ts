import type { AuthConfig } from "convex/server";

/**
 * Identity providers this deployment trusts.
 *
 * - **WorkOS AuthKit**, the sign-in provider, when the deployment variable
 *   `WORKOS_CLIENT_ID` is set (one WorkOS environment per deployment: its
 *   staging client for dev, its production client for prod). WorkOS signs
 *   access tokens with RS256 under one of two issuers, so both are listed,
 *   each against the environment's JWKS. Without the variable, no WorkOS
 *   token is trusted.
 * - **The TEST issuer**: the local-backend fixture (`fixture/jwt.ts`) sets
 *   `VOLLI_TEST_JWKS` on its own throwaway backend so tests (and the desktop's
 *   dev issuer, `apps/desktop/src/main/account/dev-issuer.ts`) can act as any
 *   user. A deployment without that variable trusts no test issuer, and no
 *   cloud deployment may ever set it.
 *
 * - **Runners** sign in with runner tokens this deployment issues itself
 *   (`runnerHttp.ts`, `/runner/token`). `VOLLI_RUNNER_JWKS` is the public
 *   half of `VOLLI_RUNNER_SIGNING_KEY`, as a `data:` URI; every deployment
 *   that serves runners sets both. `lib/runnerAuth.ts` tells runners from
 *   people.
 *
 * A token's profile claims (`email`, `email_verified`, `name`) are read by
 * `profileFromIdentity` in `lib/auth.ts`. WorkOS adds them through the
 * environment's JWT template; see `README.md`, "Sign-in provider".
 */
export const TEST_ISSUER = "https://test.volli.invalid";
export const TEST_AUDIENCE = "volli-test";

// `RUNNER_TOKEN_ISSUER` / `RUNNER_TOKEN_AUDIENCE` from `@volli/shared/cloud`,
// repeated because the fixture loads this file under Node's type stripper,
// which cannot resolve the shared package. A unit test holds them equal.
export const RUNNER_ISSUER = "https://runners.volli.app";
export const RUNNER_AUDIENCE = "volli-runner";

/** Where WorkOS's API and JWKS live. */
const WORKOS_API_BASE = "https://api.workos.com";

// The backend throws on reading an unset variable while it evaluates this
// file (rather than returning `undefined`), so absence is caught, not tested.
function optionalEnv(name: string): string | undefined {
  try {
    const value = process.env[name];
    return value === undefined || value === "" ? undefined : value;
  } catch {
    return undefined;
  }
}

type Provider = AuthConfig["providers"][number];

/** The two issuers a WorkOS environment signs access tokens under. */
function workosProviders(clientId: string): Provider[] {
  const jwks = `${WORKOS_API_BASE}/sso/jwks/${clientId}`;
  return [
    {
      type: "customJwt",
      issuer: `${WORKOS_API_BASE}/`,
      algorithm: "RS256",
      jwks,
      applicationID: clientId,
    },
    {
      type: "customJwt",
      issuer: `${WORKOS_API_BASE}/user_management/${clientId}`,
      algorithm: "RS256",
      jwks,
    },
  ];
}

const workosClientId = optionalEnv("WORKOS_CLIENT_ID");
const testJwks = optionalEnv("VOLLI_TEST_JWKS");
const runnerJwks = optionalEnv("VOLLI_RUNNER_JWKS");

export default {
  providers: [
    ...(workosClientId ? workosProviders(workosClientId) : []),
    ...(testJwks
      ? [
          {
            type: "customJwt",
            issuer: TEST_ISSUER,
            applicationID: TEST_AUDIENCE,
            algorithm: "ES256",
            jwks: testJwks,
          } satisfies Provider,
        ]
      : []),
    ...(runnerJwks
      ? [
          {
            type: "customJwt",
            issuer: RUNNER_ISSUER,
            applicationID: RUNNER_AUDIENCE,
            algorithm: "ES256",
            jwks: runnerJwks,
          } satisfies Provider,
        ]
      : []),
  ],
} satisfies AuthConfig;
