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
    ).toEqual({
      provider: null,
      backendUrl: null,
      siteUrl: null,
      storageOrigin: null,
      problem: null,
    });
  });

  it("uses only compiled public config in a packaged build", () => {
    expect(
      resolveAccountConfig({
        packaged: true,
        env: {
          VOLLI_WORKOS_CLIENT_ID: "client_evil",
          VOLLI_WORKOS_API_BASE: "https://evil.test",
          VOLLI_ACCOUNT_PROVIDER: "dev",
          VOLLI_CONVEX_TEST_PRIVATE_KEY: "PEM",
          VOLLI_CONVEX_URL: "https://evil.test",
          VOLLI_CONVEX_SITE_URL: "https://evil.test",
          VOLLI_CLOUD_STORAGE_ORIGIN: "https://evil.test",
        },
        build: {
          workosClientId: "client_release",
          backendUrl: "https://backend.test",
          siteUrl: "https://actions.test",
          storageOrigin: "https://storage.test",
        },
      }),
    ).toEqual({
      provider: { kind: "workos", clientId: "client_release", apiBase: null },
      backendUrl: "https://backend.test",
      siteUrl: "https://actions.test",
      storageOrigin: "https://storage.test",
      problem: null,
    });
  });

  it("names nothing in an unpackaged build with no environment", () => {
    expect(resolveAccountConfig({ ...dev, env: {} })).toEqual({
      provider: null,
      backendUrl: null,
      siteUrl: null,
      storageOrigin: null,
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
      siteUrl: null,
      storageOrigin: null,
      problem: null,
    });
  });

  it("keeps all origins together, rejects bad dev settings without throwing, and never infers the site", () => {
    expect(
      resolveAccountConfig({
        ...dev,
        env: {
          VOLLI_CONVEX_URL: "https://custom.example/",
          VOLLI_CONVEX_SITE_URL: " http://127.0.0.1:3211/ ",
          VOLLI_CLOUD_STORAGE_ORIGIN: "https://store.example/",
        },
      }),
    ).toMatchObject({
      backendUrl: "https://custom.example",
      siteUrl: "http://127.0.0.1:3211",
      storageOrigin: "https://store.example",
      problem: null,
    });
    for (const name of [
      "VOLLI_CONVEX_URL",
      "VOLLI_CONVEX_SITE_URL",
      "VOLLI_CLOUD_STORAGE_ORIGIN",
    ]) {
      expect(
        resolveAccountConfig({ ...dev, env: { [name]: "http://nonloopback.example/path" } }),
      ).toMatchObject({
        backendUrl: null,
        siteUrl: null,
        storageOrigin: null,
        problem: `${name} is not an exact permitted origin`,
      });
    }
    expect(
      resolveAccountConfig({ ...dev, env: { VOLLI_CONVEX_URL: "https://a.convex.cloud" } }).siteUrl,
    ).toBeNull();
  });

  it("accepts an exact HTTP loopback transcript store only in an unpackaged config", () => {
    for (const origin of ["http://127.0.0.1:4321", "http://localhost:4321"]) {
      const env = { VOLLI_CLOUD_STORAGE_ORIGIN: `${origin}/` };
      expect(resolveAccountConfig({ ...dev, env })).toMatchObject({
        storageOrigin: origin,
        problem: null,
      });
      expect(resolveAccountConfig({ packaged: true, env }).storageOrigin).toBeNull();
    }
    for (const origin of [
      "http://storage.example.com",
      "http://127.0.0.1:4321/path",
      "http://user@localhost:4321",
      "http://localhost:4321?key=value",
    ]) {
      expect(
        resolveAccountConfig({ ...dev, env: { VOLLI_CLOUD_STORAGE_ORIGIN: origin } }),
      ).toMatchObject({
        storageOrigin: null,
        problem: "VOLLI_CLOUD_STORAGE_ORIGIN is not an exact permitted origin",
      });
    }
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
      siteUrl: null,
      storageOrigin: null,
      problem: "VOLLI_ACCOUNT_PROVIDER=dev needs VOLLI_CONVEX_TEST_PRIVATE_KEY",
    });
  });

  it("allows distinct dev-issuer emails for two-account sharing proofs, never in packaged builds", () => {
    const env = {
      VOLLI_ACCOUNT_PROVIDER: "dev",
      VOLLI_CONVEX_TEST_PRIVATE_KEY: "PEM",
      VOLLI_ACCOUNT_DEV_SUBJECT: "robin",
      VOLLI_ACCOUNT_DEV_EMAIL: "robin@volli.invalid",
    };
    expect(resolveAccountConfig({ ...dev, env }).provider).toEqual({
      kind: "dev",
      privateKeyPem: "PEM",
      subject: "robin",
      email: "robin@volli.invalid",
    });
    expect(resolveAccountConfig({ packaged: true, env }).provider).toBeNull();
  });

  it("preserves unpackaged provider API overrides used by transport fixtures", () => {
    for (const base of [undefined, "http://127.0.0.1:3212", "ftp://invalid"]) {
      const config = resolveAccountConfig({
        ...dev,
        env: { VOLLI_WORKOS_CLIENT_ID: "c", VOLLI_WORKOS_API_BASE: base },
      });
      expect(config.provider).toEqual({
        kind: "workos",
        clientId: "c",
        apiBase: base === "http://127.0.0.1:3212" ? base : null,
      });
      expect(config.problem).toBe(
        base === "ftp://invalid" ? "VOLLI_WORKOS_API_BASE is not a URL" : null,
      );
    }
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
      siteUrl: null,
      storageOrigin: null,
      problem:
        'VOLLI_CONVEX_URL is not an exact permitted origin; VOLLI_ACCOUNT_PROVIDER must be "dev" or "workos"',
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
