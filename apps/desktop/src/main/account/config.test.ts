import { describe, expect, it } from "vite-plus/test";

import { resolveAccountConfig } from "./config";

const dev = { packaged: false };

describe("the account's configuration", () => {
  it("names nothing in a packaged build, whatever the environment says", () => {
    expect(
      resolveAccountConfig({
        packaged: true,
        env: { VOLLI_WORKOS_CLIENT_ID: "client_x", VOLLI_CONVEX_URL: "https://a.convex.cloud" },
      }),
    ).toEqual({ provider: null, backendUrl: null, problem: null });
  });

  it("names nothing in an unpackaged build with no environment", () => {
    expect(resolveAccountConfig({ ...dev, env: {} })).toEqual({
      provider: null,
      backendUrl: null,
      problem: null,
    });
  });

  it("reads WorkOS and the backend from an unpackaged build's environment", () => {
    expect(
      resolveAccountConfig({
        ...dev,
        env: {
          VOLLI_WORKOS_CLIENT_ID: " client_x ",
          VOLLI_WORKOS_API_BASE: "https://auth.example.test",
          VOLLI_CONVEX_URL: "http://127.0.0.1:3210",
        },
      }),
    ).toEqual({
      provider: { kind: "workos", clientId: "client_x", apiBase: "https://auth.example.test" },
      backendUrl: "http://127.0.0.1:3210",
      problem: null,
    });
  });

  it("reads the dev issuer, which needs the fixture's key", () => {
    expect(
      resolveAccountConfig({
        ...dev,
        env: {
          VOLLI_ACCOUNT_PROVIDER: "dev",
          VOLLI_CONVEX_TEST_PRIVATE_KEY: "PEM",
          VOLLI_ACCOUNT_DEV_SUBJECT: "dana",
          VOLLI_WORKOS_CLIENT_ID: "client_x",
        },
      }).provider,
    ).toEqual({ kind: "dev", privateKeyPem: "PEM", subject: "dana" });
    expect(resolveAccountConfig({ ...dev, env: { VOLLI_ACCOUNT_PROVIDER: "dev" } })).toEqual({
      provider: null,
      backendUrl: null,
      problem: "VOLLI_ACCOUNT_PROVIDER=dev needs VOLLI_CONVEX_TEST_PRIVATE_KEY",
    });
  });

  it("names every unusable value", () => {
    expect(
      resolveAccountConfig({
        ...dev,
        env: { VOLLI_ACCOUNT_PROVIDER: "clerk", VOLLI_CONVEX_URL: "ftp://x" },
      }),
    ).toEqual({
      provider: null,
      backendUrl: null,
      problem: 'VOLLI_CONVEX_URL is not a URL; VOLLI_ACCOUNT_PROVIDER must be "dev" or "workos"',
    });
    expect(
      resolveAccountConfig({ ...dev, env: { VOLLI_ACCOUNT_PROVIDER: "workos" } }).problem,
    ).toBe("VOLLI_ACCOUNT_PROVIDER=workos needs VOLLI_WORKOS_CLIENT_ID");
    expect(
      resolveAccountConfig({
        ...dev,
        env: { VOLLI_WORKOS_CLIENT_ID: "c", VOLLI_WORKOS_API_BASE: "nope" },
      }),
    ).toMatchObject({
      provider: { kind: "workos", clientId: "c", apiBase: null },
      problem: "VOLLI_WORKOS_API_BASE is not a URL",
    });
  });
});
