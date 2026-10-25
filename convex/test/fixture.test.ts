import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vite-plus/test";

import {
  PACKAGE_DIR,
  assertConvexNpmPinned,
  backendCacheRoot,
  cliEnvFor,
  freePorts,
  readPin,
  convexCliArgs,
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

  test("blanks every cloud pointer instead of unsetting it (env files cannot refill it)", () => {
    const env = cliEnvFor("http://127.0.0.1:1", "volli-test|key", {
      PATH: "/bin",
      CONVEX_DEPLOYMENT: "prod:somewhere",
      CONVEX_DEPLOY_KEY: "prod:somewhere|secret",
      CONVEX_DEPLOYMENT_TOKEN: "prod:somewhere|secret",
      CONVEX_SELF_HOSTED_URL: "https://elsewhere.example",
    });
    expect(env).toMatchObject({
      PATH: "/bin",
      CONVEX_DEPLOYMENT: "",
      CONVEX_DEPLOY_KEY: "",
      CONVEX_DEPLOYMENT_TOKEN: "",
      CONVEX_SELF_HOSTED_URL: "http://127.0.0.1:1",
      CONVEX_SELF_HOSTED_ADMIN_KEY: "volli-test|key",
    });
    expect(env["CONVEX_PROVISION_HOST"]).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  test("the pinned CLI never reaches a control plane, even with deploy keys in env files", async () => {
    // A loopback stand-in control plane that must see nothing. It refuses
    // fast, so the one CLI that does reach it (the control case) exits.
    const controlHits: string[] = [];
    const control = createServer((request, response) => {
      controlHits.push(request.url ?? "");
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: "BadDeployKey", message: "stand-in" }));
    });
    await new Promise<void>((done) => control.listen(0, "127.0.0.1", () => done()));
    const controlUrl = `http://127.0.0.1:${(control.address() as AddressInfo).port}`;
    // Nothing listens here; `deploy` names its target and then stops at the
    // missing package.json, before any network call to it.
    const backendUrl = "http://127.0.0.1:9";
    const adminKey = "volli-test|00";
    const cwd = await mkdtemp(join(tmpdir(), "volli-cli-probe-"));
    const cli = join(PACKAGE_DIR, "node_modules/convex/bin/main.js");
    const deploy = (env: NodeJS.ProcessEnv) =>
      new Promise<string>((done) => {
        const child = spawn(process.execPath, [cli, "deploy", "--yes", "--typecheck", "disable"], {
          cwd,
          env,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let output = "";
        child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
        child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
        const kill = setTimeout(() => child.kill("SIGKILL"), 15_000);
        child.once("exit", () => {
          clearTimeout(kill);
          done(output);
        });
      });
    try {
      await writeFile(
        join(cwd, ".env.local"),
        "CONVEX_DEPLOY_KEY=prod:stand-in|secret\nCONVEX_DEPLOYMENT=prod:stand-in\n",
      );
      await writeFile(join(cwd, ".env"), "CONVEX_DEPLOYMENT_TOKEN=prod:stand-in|secret\n");
      // The fixture's dead control-plane port is swapped for the stand-in on
      // purpose: the blanked variables alone must keep the CLI on loopback.
      const fixtureEnv: NodeJS.ProcessEnv = {
        ...cliEnvFor(backendUrl, adminKey, { ...process.env, CONVEX_DEPLOYMENT_TOKEN: "prod:x|y" }),
        CONVEX_PROVISION_HOST: controlUrl,
      };
      expect(await deploy(fixtureEnv)).toContain(backendUrl);
      expect(controlHits).toEqual([]);

      // Not vacuous: with those variables merely unset, the env file wins.
      const unset: NodeJS.ProcessEnv = { ...fixtureEnv };
      for (const name of ["CONVEX_DEPLOY_KEY", "CONVEX_DEPLOYMENT", "CONVEX_DEPLOYMENT_TOKEN"]) {
        delete unset[name];
      }
      await deploy(unset);
      expect(controlHits.length).toBeGreaterThan(0);
    } finally {
      control.close();
      await rm(cwd, { recursive: true, force: true });
    }
  }, 40_000);

  test("passes --url and --admin-key to the commands that select a deployment", () => {
    const backend = { url: "http://127.0.0.1:1", adminKey: "volli-test|key" };
    expect(convexCliArgs(backend, ["deploy", "--yes"])).toEqual([
      "deploy",
      "--url",
      "http://127.0.0.1:1",
      "--admin-key",
      "volli-test|key",
      "--yes",
    ]);
    expect(convexCliArgs(backend, ["codegen"])).toContain("--url");
    expect(convexCliArgs(backend, ["--version"])).toEqual(["--version"]);
  });

  test("picks distinct free ports", async () => {
    const [a, b] = await freePorts(2);
    expect(a).not.toBe(b);
    expect(a).toBeGreaterThan(0);
  });
});
