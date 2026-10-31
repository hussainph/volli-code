import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { RUNNER_LINK_REQUEST_TTL_MS, type RunnerId } from "@volli/shared/cloud";

import type { CommandInput } from "../commands";
import { RUNNER } from "../shell/identity";
import { acquireInstanceLock } from "../shell/instance-lock";
import { HOST, testContext, type Route } from "../testing/context";
import { describeLinkOnDisk, runLink, runUnlink } from "./commands";
import { fileRunnerLinkStore, LINK_FILE_NAME } from "./file-store";

const RUNNER_ID = "11111111-1111-4111-8111-111111111111" as RunnerId;
const GRANT = { runnerId: RUNNER_ID, name: "hetzner-1", credential: "vrc_first", generation: 1 };
const BAKED = {
  url: "https://baked-deployment.convex.cloud",
  siteUrl: "https://baked-deployment.convex.site",
};

let root: string;
let configDir: string;
let dataDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "runner-link-command-"));
  configDir = join(root, "config");
  dataDir = join(root, "data");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function input(values: Record<string, string> = {}): CommandInput {
  return { values: { "config-dir": configDir, "data-dir": dataDir, ...values }, positionals: [] };
}

const granted: Route = () => ({ body: GRANT });

describe("volli-runner link --token", () => {
  it("links with the token against the baked deployment, and seals the link with it", async () => {
    const context = testContext({ root, routes: { link: granted } });
    expect(await runLink(input({ token: "vrt_abc", name: "box" }), context)).toBe(0);
    expect(context.requests).toEqual([
      {
        path: "/runner/link",
        siteUrl: BAKED.siteUrl,
        body: { installToken: "vrt_abc", host: HOST, name: "box" },
      },
    ]);
    expect(context.stdout()).toBe(`Linked hetzner-1 (${RUNNER_ID}) to ${BAKED.url}.\n`);
    expect(await fileRunnerLinkStore({ configDir }).read()).toEqual({
      link: GRANT,
      deployment: BAKED,
    });
    expect(await describeLinkOnDisk(configDir)).toEqual({
      state: "linked",
      runnerId: RUNNER_ID,
      name: "hetzner-1",
      server: BAKED.url,
    });
  });

  it("reads the token and the server from the environment", async () => {
    const context = testContext({
      root,
      routes: { link: granted },
      env: {
        VOLLI_RUNNER_TOKEN: " vrt_env ",
        VOLLI_SERVER: "http://127.0.0.1:3210",
        VOLLI_SERVER_SITE: "http://127.0.0.1:3211",
      },
      buildDeployment: null,
    });
    expect(await runLink(input(), context)).toBe(0);
    expect(context.requests[0]).toMatchObject({
      siteUrl: "http://127.0.0.1:3211",
      body: { installToken: "vrt_env", name: null },
    });
    expect((await fileRunnerLinkStore({ configDir }).read())?.deployment).toEqual({
      url: "http://127.0.0.1:3210",
      siteUrl: "http://127.0.0.1:3211",
    });
  });

  it("is a usage error with no server to link to", async () => {
    const context = testContext({ root, buildDeployment: null, env: { VOLLI_SERVER: " " } });
    expect(await runLink(input({ token: "vrt_abc" }), context)).toBe(2);
    expect(context.stderr()).toContain("pass --server <url>");
  });

  it("refuses a box already linked, and one whose link it cannot read", async () => {
    const first = testContext({ root, routes: { link: granted } });
    await runLink(input({ token: "vrt_abc" }), first);
    const again = testContext({ root, routes: { link: granted } });
    expect(
      await runLink(input({ token: "vrt_def", server: "https://b.convex.cloud" }), again),
    ).toBe(1);
    expect(again.stderr()).toContain("already linked as hetzner-1");
    expect(again.requests).toEqual([]);

    writeFileSync(join(configDir, LINK_FILE_NAME), "garbage");
    const unreadable = testContext({ root });
    expect(await runLink(input({ token: "vrt_def" }), unreadable)).toBe(1);
    expect(unreadable.stderr()).toContain("could not be opened");
    expect(await describeLinkOnDisk(configDir)).toMatchObject({ state: "unreadable" });
  });

  it("says why a token was refused, or that the server could not be reached", async () => {
    const refused = testContext({
      root,
      routes: {
        link: () => ({
          status: 401,
          body: {
            error: {
              code: "invalid_install_token",
              message: "This install token was already used.",
            },
          },
        }),
      },
    });
    expect(await runLink(input({ token: "vrt_used" }), refused)).toBe(1);
    expect(refused.stderr()).toBe(
      "volli-runner: could not link: This install token was already used. (invalid_install_token).\n",
    );
    const down = testContext({ root, routes: { link: () => ({ status: 502, body: {} }) } });
    expect(await runLink(input({ token: "vrt_abc" }), down)).toBe(1);
    expect(down.stderr()).toContain("the server could not be reached");
    expect(await describeLinkOnDisk(configDir)).toEqual({ state: "unlinked" });
  });

  it.skipIf(process.getuid?.() === 0)("reports a failure that is not the server's", async () => {
    const broken = testContext({ root, routes: { link: granted } });
    // The grant arrives, and the config dir will not take the sealed link.
    mkdirSync(configDir, { mode: 0o500 });
    try {
      expect(await runLink(input({ token: "vrt_abc" }), broken)).toBe(1);
    } finally {
      chmodSync(configDir, 0o700);
    }
    expect(broken.stderr()).toMatch(/^volli-runner: could not link: .*EACCES/);
  });
});

const started: Route = () => ({
  body: {
    requestId: "req-1",
    userCode: "ABCD-EFGH",
    pollSecret: "poll-secret",
    intervalMs: 5_000,
    expiresAt: Date.now() + RUNNER_LINK_REQUEST_TTL_MS,
  },
});

describe("volli-runner link with a device code", () => {
  it("prints the code, waits for approval, and saves the link", async () => {
    const answers = [{ status: "pending" }, { status: "linked", grant: GRANT }];
    const context = testContext({
      root,
      routes: { linkStart: started, linkPoll: () => ({ body: answers.shift() }) },
    });
    expect(await runLink(input(), context)).toBe(0);
    expect(context.stdout()).toContain("    ABCD-EFGH\n");
    expect(context.stdout()).toContain(`Linked hetzner-1 (${RUNNER_ID})`);
    expect(context.requests.map((request) => request.path)).toEqual([
      "/runner/link/start",
      "/runner/link/poll",
      "/runner/link/poll",
    ]);
    expect(context.requests[1]?.body).toEqual({ requestId: "req-1", pollSecret: "poll-secret" });
    expect(await fileRunnerLinkStore({ configDir }).load()).toEqual(GRANT);
  });

  it.each([
    ["denied", "declined"],
    ["expired", "expired before it was approved"],
  ])("says when the code was %s", async (status, sentence) => {
    const context = testContext({
      root,
      routes: { linkStart: started, linkPoll: () => ({ body: { status } }) },
    });
    expect(await runLink(input(), context)).toBe(1);
    expect(context.stderr()).toContain(sentence);
    expect(await describeLinkOnDisk(configDir)).toEqual({ state: "unlinked" });
  });

  it("stops when interrupted", async () => {
    const interrupt = new AbortController();
    interrupt.abort();
    const context = testContext({ root, signal: interrupt.signal, routes: { linkStart: started } });
    expect(await runLink(input(), context)).toBe(1);
    expect(context.stderr()).toContain("linking was cancelled");
  });

  it("gives up on this machine's clock when the server cannot say", async () => {
    let clock = 0;
    const context = testContext({
      root,
      now: () => {
        clock += RUNNER_LINK_REQUEST_TTL_MS;
        return clock;
      },
      routes: { linkStart: started },
    });
    expect(await runLink(input(), context)).toBe(1);
    expect(context.stderr()).toContain("expired");
  });
});

describe("volli-runner unlink", () => {
  async function linked(): Promise<void> {
    await runLink(input({ token: "vrt_abc" }), testContext({ root, routes: { link: granted } }));
  }

  it("forgets the link, keeping its key", async () => {
    await linked();
    const context = testContext({ root });
    expect(await runUnlink(input(), context)).toBe(0);
    expect(context.stdout()).toBe(
      `Forgot this box's link as hetzner-1 (${RUNNER_ID}). Remove it in Volli → Settings → Runners as well.\n`,
    );
    expect(await describeLinkOnDisk(configDir)).toEqual({ state: "unlinked" });
  });

  it("says when there is nothing to forget, with or without a data directory", async () => {
    const context = testContext({ root });
    expect(await runUnlink(input(), context)).toBe(0);
    mkdirSync(dataDir);
    expect(await runUnlink(input(), context)).toBe(0);
    expect(context.stdout()).toBe("This box is not linked.\nThis box is not linked.\n");
  });

  it("forgets a link it cannot read", async () => {
    mkdirSync(configDir);
    writeFileSync(join(configDir, LINK_FILE_NAME), "garbage");
    const context = testContext({ root });
    expect(await runUnlink(input(), context)).toBe(0);
    expect(context.stdout()).toBe(
      "Forgot this box's link. Remove it in Volli → Settings → Runners as well.\n",
    );
    expect(await describeLinkOnDisk(configDir)).toEqual({ state: "unlinked" });
  });

  it("refuses while the runner runs, and a data directory it cannot lock", async () => {
    await linked();
    mkdirSync(dataDir);
    const held = acquireInstanceLock(RUNNER, dataDir);
    try {
      const context = testContext({ root });
      expect(await runUnlink(input(), context)).toBe(1);
      expect(context.stderr()).toContain("Another volli-runner is serving");
      expect(context.stderr()).toContain("Stop it before unlinking.");
    } finally {
      held.release();
    }
    rmSync(join(dataDir, "runner.lock"));
    mkdirSync(join(dataDir, "runner.lock"));
    const context = testContext({ root });
    expect(await runUnlink(input(), context)).toBe(1);
    expect(context.stderr()).toContain("Could not take the instance lock");
    expect(context.stderr()).not.toContain("Stop it");
    expect(await describeLinkOnDisk(configDir)).toMatchObject({ state: "linked" });
  });
});
