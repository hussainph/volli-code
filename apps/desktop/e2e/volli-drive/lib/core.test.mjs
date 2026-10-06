/**
 * volli-drive's pure rules: run with `node --test`. Nothing here launches
 * Electron, touches a keychain or reads a real profile.
 */
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  MAX_INSTANCES,
  bundleCarriesGuard,
  createRegistry,
  electronExtraEnv,
  ensurePrivateDir,
  findInSnapshot,
  instanceLayout,
  isInstanceId,
  newInstanceId,
  readOnlySql,
  snapshotRefs,
  supervisorEnv,
} from "./core.mjs";

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(os.tmpdir(), "volli-drive-core-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("supervisorEnv", () => {
  const parent = {
    PATH: "/usr/bin",
    LANG: "en_US.UTF-8",
    VOLLI_SESSION: "outer-session",
    VOLLI_TICKET: "VC-1",
    VOLLI_SESSION_TOKEN: "secret-token",
    VOLLI_SOCKET: "/Users/me/Library/Application Support/Volli Code/volli.sock",
    VOLLI_DRIVE_HOME: "/tmp/drive",
    ELECTRON_RUN_AS_NODE: "1",
    SSH_AUTH_SOCK: "/private/tmp/agent.sock",
    GH_TOKEN: "ghp_x",
    GIT_DIR: "/somewhere/.git",
    PI_CODING_AGENT_DIR: "/Users/me/.pi/agent",
    OPENAI_API_KEY: "sk-real",
    ANTHROPIC_API_KEY: "sk-ant",
    AZURE_OPENAI_BASE_URL: "https://real.openai.azure.com",
    NODE_OPTIONS: "--require x",
  };

  it("strips the outer agent's Volli addressing, agents, tokens and git overrides", () => {
    const env = supervisorEnv(parent);
    assert.deepEqual(Object.keys(env).toSorted(), ["LANG", "PATH", "VOLLI_DRIVE_HOME"]);
  });

  it("keeps provider credentials only for --model env, and never the rest", () => {
    const env = supervisorEnv(parent, { model: "env" });
    assert.equal(env.OPENAI_API_KEY, "sk-real");
    assert.equal(env.VOLLI_SESSION_TOKEN, undefined);
    assert.equal(env.SSH_AUTH_SOCK, undefined);
    assert.equal(env.PI_CODING_AGENT_DIR, undefined);
  });
});

describe("electronExtraEnv", () => {
  it("turns harness mode on and pins every reachable home inside the scratch tree", () => {
    const layout = instanceLayout("/tmp/vd-abc123-XYZ", "/repo/.scratch/volli-drive/vd-abc123");
    const env = electronExtraEnv(layout, {
      loginShell: "/tmp/vd-abc123-XYZ/bin/fake-login-shell",
      path: "/tmp/vd-abc123-XYZ/bin:/usr/bin",
      providerEnv: { AZURE_OPENAI_API_KEY: "volli-drive-fake-key" },
    });
    assert.equal(env.VOLLI_HARNESS, "1");
    assert.equal(env.VOLLI_HARNESS_DIR, "/tmp/vd-abc123-XYZ/harness");
    assert.equal(env.VOLLI_QUIET_WINDOWS, "1");
    assert.equal(env.VOLLI_SKIP_AGENT_TOOLS, "1");
    assert.equal(env.GIT_CONFIG_NOSYSTEM, "1");
    assert.equal(env.AZURE_OPENAI_API_KEY, "volli-drive-fake-key");
    for (const key of [
      "HOME",
      "VOLLI_AGENT_HOME",
      "PI_CODING_AGENT_DIR",
      "ZDOTDIR",
      "GIT_CONFIG_GLOBAL",
      "VOLLI_WORKTREE_HOME_DIR",
      "XDG_CONFIG_HOME",
    ]) {
      assert.ok(env[key].startsWith("/tmp/vd-abc123-XYZ/"), `${key}=${env[key]}`);
    }
    assert.ok(
      env.PATH.startsWith("/tmp/vd-abc123-XYZ/bin:"),
      "the refusing gh shim is first on PATH",
    );
  });

  it("keeps the app's unix socket inside sun_path's limit", () => {
    const layout = instanceLayout("/tmp/vd-abc123-XXXXXX", "/e");
    assert.ok(Buffer.byteLength(layout.appSocket) < 100, layout.appSocket);
  });
});

describe("readOnlySql", () => {
  it("accepts one read statement", () => {
    assert.equal(readOnlySql("SELECT * FROM tickets;").ok, true);
    assert.equal(readOnlySql("with t as (select 1) select * from t").ok, true);
    assert.equal(readOnlySql("PRAGMA table_info(tickets)").ok, true);
    assert.equal(
      readOnlySql("select 'drop table x' as s").ok,
      true,
      "keywords inside strings are fine",
    );
  });

  it("refuses writes, several statements and dot-commands", () => {
    for (const sql of [
      "",
      "UPDATE tickets SET status='done'",
      "select 1; delete from tickets",
      ".shell rm -rf /",
      "PRAGMA journal_mode=delete",
      "with x as (delete from tickets returning *) select * from x",
      "ATTACH '/tmp/x.db' AS x",
    ]) {
      assert.equal(readOnlySql(sql).ok, false, sql);
    }
  });
});

describe("findInSnapshot", () => {
  const tree = [
    "- generic [ref=e1]:",
    "  - navigation [ref=e2]:",
    '    - button "Board" [ref=e3]',
    '    - button "Settings" [ref=e4]',
    "  - main [ref=e5]:",
    '    - heading "Todo" [level=2] [ref=e6]',
    "    - article [ref=e7]:",
    "      - text: DRV-1 Fix the login button",
    '      - button "Open" [ref=f2e8]',
  ].join("\n");

  it("returns matches under their ancestors, case-insensitively", () => {
    assert.deepEqual(findInSnapshot(tree, "login"), [
      "- generic [ref=e1]:",
      "  - main [ref=e5]:",
      "    - article [ref=e7]:",
      "      - text: DRV-1 Fix the login button",
    ]);
    assert.deepEqual(findInSnapshot(tree, "SETTINGS"), [
      "- generic [ref=e1]:",
      "  - navigation [ref=e2]:",
      '    - button "Settings" [ref=e4]',
    ]);
    assert.deepEqual(findInSnapshot(tree, "nothing here"), []);
  });

  it("lists the refs a snapshot minted", () => {
    assert.deepEqual([...snapshotRefs(tree)], ["e1", "e2", "e3", "e4", "e5", "e6", "e7", "f2e8"]);
  });
});

describe("instance ids", () => {
  it("are vd- plus six hex digits", () => {
    const id = newInstanceId();
    assert.ok(isInstanceId(id), id);
    assert.equal(isInstanceId("vd-zzzzzz"), false);
    assert.equal(isInstanceId("../etc"), false);
  });
});

describe("registry", () => {
  it(`caps live instances at ${MAX_INSTANCES} and frees a slot on remove`, async () => {
    const livePids = new Set([101, 102, 103]);
    const registry = createRegistry(join(dir, "home"), { alive: (pid) => livePids.has(pid) });
    for (const [i, pid] of [101, 102, 103].entries()) {
      await registry.reserve({ id: `vd-00000${i}`, supervisorPid: pid, reservedAt: 0 });
    }
    await assert.rejects(
      registry.reserve({ id: "vd-000009", supervisorPid: 109, reservedAt: 0 }),
      /already running \(max 3\)/,
    );
    await registry.remove("vd-000001");
    await registry.reserve({ id: "vd-000009", supervisorPid: 109, reservedAt: 0 });
  });

  it("does not count dead instances, but does count a fresh reservation", async () => {
    let clock = 1_000_000;
    const registry = createRegistry(join(dir, "home"), { alive: () => false, now: () => clock });
    for (let i = 0; i < 3; i++)
      await registry.reserve({ id: `vd-00000${i}`, supervisorPid: 5000 + i, reservedAt: 0 });
    // Three dead instances: still room.
    await registry.reserve({ id: "vd-0000a0", supervisorPid: null, reservedAt: clock });
    await registry.reserve({ id: "vd-0000a1", supervisorPid: null, reservedAt: clock });
    await registry.reserve({ id: "vd-0000a2", supervisorPid: null, reservedAt: clock });
    await assert.rejects(
      registry.reserve({ id: "vd-0000a3", supervisorPid: null, reservedAt: clock }),
      /max 3/,
    );
    clock += 10 * 60_000; // reservations that never booted expire
    await registry.reserve({ id: "vd-0000a3", supervisorPid: null, reservedAt: clock });
    const listed = await registry.list();
    assert.equal(listed.filter((e) => e.live).length, 1);
  });

  it("serialises concurrent reservations under the lock", async () => {
    const registry = createRegistry(join(dir, "home"), { alive: () => true });
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) =>
        registry.reserve({ id: `vd-1000${i}0`, supervisorPid: 1, reservedAt: 0 }),
      ),
    );
    assert.equal(results.filter((r) => r.status === "fulfilled").length, MAX_INSTANCES);
  });

  it("refuses a registry directory other users can reach", () => {
    const shared = join(dir, "shared");
    ensurePrivateDir(shared);
    chmodSync(shared, 0o777);
    assert.throws(() => ensurePrivateDir(shared), /accessible to other users/);
  });
});

describe("bundleCarriesGuard", () => {
  it("needs the marker, the installer and the Chromium switch together", () => {
    const bundle = join(dir, "main.cjs");
    writeFileSync(bundle, "volli-harness-keychain-guard:v1");
    assert.equal(bundleCarriesGuard(bundle), false);
    writeFileSync(
      bundle,
      'installHarnessGuard(); "volli-harness-keychain-guard:v1"; "use-mock-keychain"',
    );
    assert.equal(bundleCarriesGuard(bundle), true);
    assert.equal(bundleCarriesGuard(join(dir, "missing.cjs")), false);
  });
});
