import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vite-plus/test";

import type { RunnerId } from "@volli/shared/cloud";

import { fileRunnerLinkStore } from "../link/file-store";
import { RUNNER } from "../shell/identity";
import { acquireInstanceLock } from "../shell/instance-lock";
import { testContext } from "../testing/context";
import { revokeRunner } from "./uninstall";

const id = "11111111-1111-4111-8111-111111111111" as RunnerId;
const deployment = {
  url: "https://baked-deployment.convex.cloud",
  siteUrl: "https://baked-deployment.convex.site",
};
let root: string;
let configDir: string;
let dataDir: string;
const input = () => ({ values: { "config-dir": configDir, "data-dir": dataDir }, positionals: [] });
const grant = {
  token: "runner_jwt",
  credential: "vrc_next",
  generation: 2,
  serverTime: 1000,
  expiresAt: 901000,
};

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "runner-revoke-"));
  dataDir = join(root, "data");
  configDir = join(root, "config");
  mkdirSync(dataDir);
  await fileRunnerLinkStore({ configDir, deployment }).save({
    runnerId: id,
    name: "box",
    credential: "vrc_first",
    generation: 1,
  });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

it("uses the real Convex HTTP mutation envelope and bearer token, rotating before use", async () => {
  let body = "";
  let auth: string | undefined;
  const server = createServer((req, res) => {
    auth = req.headers.authorization;
    req.on("data", (chunk) => {
      body += String(chunk);
    });
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ status: "success", value: null }));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  try {
    const address = server.address() as { port: number };
    const url = `http://127.0.0.1:${address.port}`;
    const localConfig = join(root, "local-config");
    const store = fileRunnerLinkStore({
      configDir: localConfig,
      deployment: { url, siteUrl: url },
    });
    await store.save({ runnerId: id, name: "box", credential: "vrc_first", generation: 1 });
    const context = testContext({ root, routes: { token: () => ({ body: grant }) } });
    const wrapped: typeof fetch = async (target, init) => {
      expect(target).toBe(`${url}/api/mutation`);
      expect((await store.read())?.link.generation).toBe(2);
      return fetch(target, init);
    };
    expect(
      await revokeRunner(
        { values: { "config-dir": localConfig, "data-dir": dataDir }, positionals: [] },
        context,
        wrapped,
      ),
    ).toBe(0);
    expect(JSON.parse(body)).toEqual({ path: "runners:unlinkSelf", args: {}, format: "json" });
    expect(auth).toBe("Bearer runner_jwt");
    expect(await store.read()).toBe(null);
    expect(context.stdout() + context.stderr()).not.toContain("runner_jwt");
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
});

it("handles unlinked, already-revoked, offline, unreadable and failed HTTP responses without retaining a link", async () => {
  for (const failure of ["offline", "http", "mutation", "revoked", "unreadable", "unlinked"]) {
    const store = fileRunnerLinkStore({ configDir, deployment });
    await store.clear();
    if (failure !== "unlinked")
      await store.save({ runnerId: id, name: "box", credential: "vrc_first", generation: 1 });
    if (failure === "unreadable") writeFileSync(join(configDir, "credential"), "bad envelope");
    const context = testContext({
      root,
      routes: {
        token: () =>
          failure === "revoked"
            ? { status: 401, body: { error: { code: "revoked", message: "removed" } } }
            : { body: grant },
      },
    });
    const request: typeof fetch = async () => {
      if (failure === "offline") throw new Error("network down");
      return new Response(
        JSON.stringify({
          status: failure === "mutation" || failure === "http" ? "error" : "success",
        }),
        { status: failure === "http" ? 500 : 200 },
      );
    };
    expect(await revokeRunner(input(), context, request)).toBe(0);
    expect(await store.read()).toBe(null);
    if (["offline", "http", "mutation", "unreadable"].includes(failure))
      expect(context.stderr()).toContain("Settings → Runners");
  }
});

it("supports never-started directories but refuses to rotate credentials beneath a live daemon", async () => {
  const context = testContext({ root });
  const lock = acquireInstanceLock(RUNNER, dataDir);
  try {
    await expect(revokeRunner(input(), context)).rejects.toThrow("instance lock");
    expect(existsSync(join(configDir, "credential"))).toBe(true);
  } finally {
    lock.release();
  }
  rmSync(dataDir, { recursive: true });
  expect(await revokeRunner(input(), context)).toBe(0);
});
