import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import type { RunnerId } from "@volli/shared/cloud";

import { fileRunnerLinkStore } from "../link/file-store";
import { testContext } from "../testing/context";
import type { RunnerStatus } from "./runner-status";
import { runStatus } from "./status-command";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "runner-status-command-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const RUNNER_ID = "11111111-1111-4111-8111-111111111111" as RunnerId;
const paths = () => ({ "data-dir": join(root, "data"), "config-dir": join(root, "config") });

function online(): RunnerStatus {
  return {
    v: 1,
    state: "online",
    pid: 42,
    version: "9.9.9-test",
    startedAt: "2026-10-31T12:00:00.000Z",
    updatedAt: "2026-10-31T12:00:00.000Z",
    dataDir: join(root, "data"),
    socketPath: join(root, "data", "volli.sock"),
    link: { runnerId: RUNNER_ID, name: "hetzner-1", server: "https://a.convex.cloud" },
    backend: {
      state: "online",
      since: "2026-10-31T12:00:00.000Z",
      lastHeartbeatAt: null,
      detail: null,
    },
    update: null,
    credentials: null,
  };
}

describe("volli-runner status", () => {
  it("exits 3 on a box with no runner running and no link", async () => {
    const context = testContext({ root });
    expect(await runStatus({ values: paths(), positionals: [] }, context)).toBe(3);
    expect(JSON.parse(context.stdout())).toEqual({
      verdict: "not-serving",
      detail: "no status file",
      status: null,
      link: { state: "unlinked" },
    });
  });

  it("exits 0 for an online runner, and names the link on disk", async () => {
    await fileRunnerLinkStore({
      configDir: join(root, "config"),
      deployment: { url: "https://a.convex.cloud", siteUrl: "https://a.convex.site" },
    }).save({ runnerId: RUNNER_ID, name: "hetzner-1", credential: "vrc_secret", generation: 1 });
    const context = testContext({
      root,
      statusProbes: {
        read: () => online(),
        alive: () => true,
        accepts: () => Promise.resolve(true),
      },
    });
    expect(await runStatus({ values: paths(), positionals: [] }, context)).toBe(0);
    const report = JSON.parse(context.stdout()) as Record<string, unknown>;
    expect(report["verdict"]).toBe("serving");
    expect(report["link"]).toEqual({
      state: "linked",
      runnerId: RUNNER_ID,
      name: "hetzner-1",
      server: "https://a.convex.cloud",
    });
    expect(context.stdout()).not.toContain("vrc_secret");
  });
});
