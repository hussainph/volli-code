import { describe, expect, it } from "vite-plus/test";
import { exactOrigin, packagedCloudConfig } from "./deployment-config";

const env = {
  VOLLI_BUILD_WORKOS_CLIENT_ID: " client_public ",
  VOLLI_BUILD_CONVEX_URL: "https://api.example.com/",
  VOLLI_BUILD_CONVEX_SITE_URL: "https://actions.example.net",
  VOLLI_BUILD_STORAGE_ORIGIN: "https://storage.example.org",
};

describe("public packaged deployment inputs", () => {
  it("are absent by default, complete or a build error", () => {
    expect(packagedCloudConfig({})).toBeNull();
    expect(packagedCloudConfig({ VOLLI_BUILD_WORKOS_CLIENT_ID: " " })).toBeNull();
    for (const name of Object.keys(env)) {
      expect(() => packagedCloudConfig({ ...env, [name]: "" })).toThrow("Set all or none");
    }
    expect(packagedCloudConfig(env)).toEqual({
      workosClientId: "client_public",
      backendUrl: "https://api.example.com",
      siteUrl: "https://actions.example.net",
      storageOrigin: "https://storage.example.org",
    });
    expect(() => packagedCloudConfig({ ...env, VOLLI_BUILD_WORKOS_CLIENT_ID: "secret" })).toThrow(
      "public WorkOS client id",
    );
  });
  it("rejects non-origins and CSP injection, and never allows HTTP in release inputs", () => {
    for (const value of [
      "http://127.0.0.1:3210",
      "https://*.example.com",
      "https://user:pass@example.com",
      "https://example.com/path",
      "https://example.com?x=1",
      "https://example.com/#hash",
      "not a URL",
      "https://a.test;script-src",
    ]) {
      expect(() => exactOrigin(value)).toThrow();
    }
    expect(exactOrigin("http://127.0.0.1:3210", true)).toBe("http://127.0.0.1:3210");
    expect(exactOrigin("http://localhost:3210/", true)).toBe("http://localhost:3210");
    expect(() => exactOrigin("http://other.test", true)).toThrow();
  });
});
