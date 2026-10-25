import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vite-plus/test";

import {
  PACKAGE_DIR,
  assertConvexNpmPinned,
  backendCacheRoot,
  cliEnvFor,
  freePorts,
  readPin,
} from "../fixture/backend";

describe("backend pin", () => {
  const pin = readPin();

  test("names one dated release and a digest for every CI and developer platform", () => {
    expect(pin.release).toMatch(/^precompiled-\d{4}-\d{2}-\d{2}-[0-9a-f]{7}$/);
    expect(Object.keys(pin.assets).toSorted()).toEqual([
      "darwin-arm64",
      "darwin-x64",
      "linux-arm64",
      "linux-x64",
    ]);
    for (const asset of Object.values(pin.assets)) {
      expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(asset.file).toMatch(/^convex-local-backend-[\w-]+\.zip$/);
    }
  });

  test("pins the convex npm version exactly, beside the backend", () => {
    const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(manifest.dependencies["convex"]).toBe(pin.convexNpm);
    expect(() => assertConvexNpmPinned()).not.toThrow();
    expect(() => assertConvexNpmPinned({ ...pin, convexNpm: "0.0.0" })).toThrow(
      /bump them together/,
    );
  });
});

describe("fixture isolation", () => {
  test("keeps the binary cache outside the repository", () => {
    expect(backendCacheRoot({ HOME: "/home/u", XDG_CACHE_HOME: "/xdg" })).toBe(
      "/xdg/volli/convex-local-backend",
    );
    expect(backendCacheRoot({ VOLLI_CONVEX_BACKEND_CACHE: "/ci/cache" })).toBe("/ci/cache");
    expect(backendCacheRoot().startsWith(join(PACKAGE_DIR, ".."))).toBe(false);
  });

  test("never lets the CLI reach a cloud deployment", () => {
    const env = cliEnvFor("http://127.0.0.1:1", "volli-test|key", {
      PATH: "/bin",
      CONVEX_DEPLOYMENT: "prod:somewhere",
      CONVEX_DEPLOY_KEY: "prod:secret",
      CONVEX_URL: "https://somewhere.convex.cloud",
      CONVEX_SELF_HOSTED_URL: "https://elsewhere.example",
      CONVEX_SELF_HOSTED_ADMIN_KEY: "other|key",
    });
    expect(env).toEqual({
      PATH: "/bin",
      CONVEX_SELF_HOSTED_URL: "http://127.0.0.1:1",
      CONVEX_SELF_HOSTED_ADMIN_KEY: "volli-test|key",
    });
  });

  test("picks distinct free ports", async () => {
    const [a, b] = await freePorts(2);
    expect(a).not.toBe(b);
    expect(a).toBeGreaterThan(0);
  });
});
