import { afterEach, describe, expect, test, vi } from "vite-plus/test";

async function loadAuthConfig() {
  vi.resetModules();
  return (await import("../functions/auth.config")).default;
}

describe("auth.config", () => {
  const originalEnv = process.env;
  afterEach(() => {
    process.env = originalEnv;
  });

  test("trusts the test issuer only when VOLLI_TEST_JWKS is set", async () => {
    process.env = { ...originalEnv, VOLLI_TEST_JWKS: "data:application/json;base64,e30=" };
    expect((await loadAuthConfig()).providers).toEqual([
      expect.objectContaining({
        type: "customJwt",
        issuer: "https://test.volli.invalid",
        applicationID: "volli-test",
        jwks: "data:application/json;base64,e30=",
      }),
    ]);

    process.env = { ...originalEnv };
    delete process.env["VOLLI_TEST_JWKS"];
    expect((await loadAuthConfig()).providers).toEqual([]);
  });

  test("trusts WorkOS's two issuers for the environment WORKOS_CLIENT_ID names", async () => {
    process.env = { ...originalEnv, WORKOS_CLIENT_ID: "client_01TEST" };
    delete process.env["VOLLI_TEST_JWKS"];
    expect((await loadAuthConfig()).providers).toEqual([
      {
        type: "customJwt",
        issuer: "https://api.workos.com/",
        algorithm: "RS256",
        jwks: "https://api.workos.com/sso/jwks/client_01TEST",
        applicationID: "client_01TEST",
      },
      {
        type: "customJwt",
        issuer: "https://api.workos.com/user_management/client_01TEST",
        algorithm: "RS256",
        jwks: "https://api.workos.com/sso/jwks/client_01TEST",
      },
    ]);

    // Both at once (a dev deployment under test): WorkOS first, then the test issuer.
    process.env = { ...process.env, VOLLI_TEST_JWKS: "data:application/json;base64,e30=" };
    const issuers = (await loadAuthConfig()).providers.map((provider) =>
      "issuer" in provider ? provider.issuer : null,
    );
    expect(issuers).toEqual([
      "https://api.workos.com/",
      "https://api.workos.com/user_management/client_01TEST",
      "https://test.volli.invalid",
    ]);

    // An empty value is no WorkOS environment.
    process.env = { ...originalEnv, WORKOS_CLIENT_ID: "" };
    delete process.env["VOLLI_TEST_JWKS"];
    expect((await loadAuthConfig()).providers).toEqual([]);
  });

  test("trusts nothing where reading an unset variable throws, as the backend does", async () => {
    process.env = new Proxy({} as NodeJS.ProcessEnv, {
      get(_target, name) {
        if (name === "VOLLI_TEST_JWKS" || name === "WORKOS_CLIENT_ID") {
          throw new Error("used in auth config file but not set");
        }
        return originalEnv[name as string];
      },
    });
    const config = await loadAuthConfig();
    expect(config.providers).toEqual([]);
  });
});
