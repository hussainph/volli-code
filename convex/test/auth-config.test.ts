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

  test("trusts nothing where reading an unset variable throws, as the backend does", async () => {
    process.env = new Proxy({} as NodeJS.ProcessEnv, {
      get(_target, name) {
        if (name === "VOLLI_TEST_JWKS") throw new Error("used in auth config file but not set");
        return originalEnv[name as string];
      },
    });
    const config = await loadAuthConfig();
    expect(config.providers).toEqual([]);
  });
});
