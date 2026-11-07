import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import type { CommandInput } from "../commands";
import { testContext } from "../testing/context";
import { pointCurrentAt } from "./apply";
import { UPDATE_COMMAND } from "./command";
import { updateConfigPath } from "./config";
import { EMPTY_STATE, readNowRequest, writeUpdateRequest, writeUpdaterState } from "./files";
import { updateLayout, type UpdateLayout } from "./layout";
import type { ProvenanceVerifier } from "./provenance";

let root: string;
let layout: UpdateLayout;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "runner-update-command-"));
  layout = updateLayout(
    "user",
    join(root, "share", "volli-runner"),
    join(root, "state", "volli-runner"),
  );
});

afterEach(() => {
  chmodSync(root, 0o700);
  rmSync(root, { recursive: true, force: true });
});

const input = (values: CommandInput["values"] = {}, positionals: string[] = []): CommandInput => ({
  values: { "data-dir": layout.dataDir, ...values },
  positionals,
});

function release(name: string, version = name): void {
  mkdirSync(join(layout.releasesDir, name), { recursive: true });
  writeFileSync(join(layout.releasesDir, name, "MANIFEST.json"), JSON.stringify({ version }));
}

function installed(version = "0.3.0"): void {
  release(version);
  pointCurrentAt(layout, join("releases", version));
}

function context(update: Parameters<typeof testContext>[0]["update"] = {}) {
  // The install root defaults under XDG_DATA_HOME, which the test points into root.
  return testContext({ root, env: { XDG_DATA_HOME: join(root, "share") }, update, now: () => 0 });
}

describe("update", () => {
  it("shows the install's update state", async () => {
    installed();
    writeUpdaterState(layout.stateFile, { ...EMPTY_STATE, previous: "0.2.0" });
    const ctx = context();
    expect(await UPDATE_COMMAND.run(input(), ctx)).toBe(0);
    expect(JSON.parse(ctx.stdout())).toEqual({
      version: "9.9.9-test",
      installRoot: layout.installRoot,
      current: "0.3.0",
      staged: null,
      activating: null,
      previous: "0.2.0",
      bad: [],
      lastOutcome: null,
      releaseOrigin: "https://github.com/hussainph/volli-code/releases/download/",
      provenance: "required",
    });
  });

  it("takes --install-root relative to where it runs", async () => {
    const ctx = context();
    expect(await UPDATE_COMMAND.run(input({ "install-root": "elsewhere" }), ctx)).toBe(0);
    expect(JSON.parse(ctx.stdout()).installRoot).toBe(join(root, "elsewhere"));
  });

  it("refuses a damaged config or state", async () => {
    installed();
    writeFileSync(updateConfigPath(layout), "{");
    let ctx = context();
    expect(await UPDATE_COMMAND.run(input(), ctx)).toBe(1);
    rmSync(updateConfigPath(layout));
    writeFileSync(layout.stateFile, "{");
    ctx = context();
    expect(await UPDATE_COMMAND.run(input(), ctx)).toBe(1);
    expect(ctx.stderr()).toMatch(/^volli-runner: /u);
  });

  it("refuses an argument it does not know", async () => {
    const ctx = context();
    expect(await UPDATE_COMMAND.run(input({}, ["later"]), ctx)).toBe(2);
    expect(ctx.stderr()).toMatch(/takes `apply` or no argument/u);
  });
});

describe("update --now", () => {
  it("asks the daemon to update now, to Volli's release or a named one", async () => {
    installed();
    let ctx = context();
    expect(await UPDATE_COMMAND.run(input({ now: true }), ctx)).toBe(0);
    expect(readNowRequest(layout.nowFile)).toEqual({
      v: 1,
      version: null,
      at: "1970-01-01T00:00:00.000Z",
    });
    expect(ctx.stdout()).toMatch(/^Asked the runner to update to Volli's release now/u);
    // The live clock, when the context has none.
    ctx = testContext({ root, env: { XDG_DATA_HOME: join(root, "share") } });
    expect(await UPDATE_COMMAND.run(input({ to: "0.4.0" }), ctx)).toBe(0);
    expect(readNowRequest(layout.nowFile)?.version).toBe("0.4.0");
    expect(ctx.stdout()).toMatch(/update to 0\.4\.0 now/u);
  });

  it("refuses a version that is not one, and a box with no install", async () => {
    let ctx = context();
    expect(await UPDATE_COMMAND.run(input({ to: "latest" }), ctx)).toBe(2);
    ctx = context();
    expect(await UPDATE_COMMAND.run(input({ now: true }), ctx)).toBe(1);
    expect(ctx.stderr()).toMatch(/no installed runner/u);
  });

  it("says to use sudo when the install root is not this account's", async () => {
    installed();
    chmodSync(layout.installRoot, 0o555);
    const ctx = context();
    try {
      expect(await UPDATE_COMMAND.run(input({ now: true }), ctx)).toBe(1);
    } finally {
      chmodSync(layout.installRoot, 0o755);
    }
    expect(ctx.stderr()).toMatch(/is root's; run this with sudo/u);
  });

  it("reports any other write failure as it is", async () => {
    installed();
    mkdirSync(layout.nowFile);
    writeFileSync(join(layout.nowFile, "x"), "");
    const ctx = context();
    expect(await UPDATE_COMMAND.run(input({ now: true }), ctx)).toBe(1);
    expect(ctx.stderr()).not.toMatch(/sudo/u);
  });
});

describe("update apply", () => {
  it("is idle without a request", async () => {
    installed();
    const ctx = testContext({ root, env: { XDG_DATA_HOME: join(root, "share") } });
    expect(await UPDATE_COMMAND.run(input({}, ["apply"]), ctx)).toBe(0);
    expect(JSON.parse(ctx.stdout())).toEqual({ kind: "idle", why: "no request" });
  });

  it("verifies provenance unless the install says sha-only, and fails a refused request", async () => {
    installed();
    const caches: string[] = [];
    const provenance = (cachePath: string): ProvenanceVerifier => {
      caches.push(cachePath);
      return { verify: async () => {} };
    };
    writeUpdateRequest(layout.requestFile, {
      phase: "stage",
      version: "0.2.0",
      manifestUrl: "https://example.test/m",
      urgent: false,
    });
    let ctx = context({ provenance });
    expect(await UPDATE_COMMAND.run(input({}, ["apply"]), ctx)).toBe(1);
    expect(JSON.parse(ctx.stdout())).toMatchObject({ kind: "refused", code: "downgrade" });
    expect(ctx.stderr()).toMatch(/^volli-runner update: update to 0\.2\.0 refused/u);
    expect(caches).toEqual([join(layout.cacheDir, "tuf")]);

    writeFileSync(updateConfigPath(layout), JSON.stringify({ provenance: "sha-only" }));
    writeUpdateRequest(layout.requestFile, { phase: "activate", version: "0.4.0", urgent: true });
    ctx = context({ provenance });
    expect(await UPDATE_COMMAND.run(input({}, ["apply"]), ctx)).toBe(1);
    expect(caches).toHaveLength(1);
  });

  it("applies with the live context's ports", async () => {
    installed();
    release("0.4.0");
    writeUpdaterState(layout.stateFile, {
      ...EMPTY_STATE,
      staged: { version: "0.4.0", name: "0.4.0" },
    });
    let clock = 0;
    writeUpdateRequest(layout.requestFile, { phase: "activate", version: "0.4.0", urgent: true });
    const restarts: string[] = [];
    const services: string[] = [];
    const statusFile = join(layout.dataDir, "runner-status.json");
    const ctx = testContext({
      root,
      env: { XDG_DATA_HOME: join(root, "share") },
      update: {
        restart: async (mode, unit) => {
          restarts.push(`${mode} ${unit}`);
          // A new process says "starting" first; the health check waits for "online".
          writeFileSync(
            statusFile,
            JSON.stringify({ state: "starting", pid: 2, version: "0.4.0" }),
          );
        },
        service: async (mode, unit) => {
          services.push(`${mode} ${unit}`);
          return { mainPid: 2, restarts: 0 };
        },
      },
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
        writeFileSync(statusFile, JSON.stringify({ state: "online", pid: 2, version: "0.4.0" }));
      },
      statusProbes: { read: () => null, alive: () => true, accepts: async () => true },
    });
    expect(await UPDATE_COMMAND.run(input({}, ["apply"]), ctx)).toBe(0);
    expect(JSON.parse(ctx.stdout())).toEqual({ kind: "applied", version: "0.4.0", from: "0.3.0" });
    expect(restarts).toEqual(["user volli-runner.service"]);
    expect(services[0]).toBe("user volli-runner.service");
    expect(readFileSync(layout.stateFile, "utf8")).toContain("update_applied");
  });

  it("refuses a damaged config", async () => {
    installed();
    writeFileSync(updateConfigPath(layout), JSON.stringify({ provenance: "none" }));
    const ctx = context();
    expect(await UPDATE_COMMAND.run(input({}, ["apply"]), ctx)).toBe(1);
  });
});
