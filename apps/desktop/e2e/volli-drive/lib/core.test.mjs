/**
 * volli-drive's pure rules: run with `node --test`. Nothing here launches
 * Electron, touches a keychain or reads a real profile.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { checkHarnessContainment } from "../../../src/main/harness/containment.ts";
import {
  MAX_INSTANCES,
  assertScratchRemotes,
  bundleCarriesGuard,
  launchProblems,
  makeScratchRepo,
  ownedProcesses,
  parseProcessTable,
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
    assert.equal(env.GIT_TERMINAL_PROMPT, "0");
    assert.equal(env.SSH_AUTH_SOCK, undefined);
    assert.equal(env.VOLLI_HARNESS_SCRATCH, "/tmp/vd-abc123-XYZ");
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
  it("needs the guard, containment, the recorder, the installer and the switch together", () => {
    const bundle = join(dir, "main.cjs");
    writeFileSync(bundle, "volli-harness-keychain-guard:v1");
    assert.equal(bundleCarriesGuard(bundle), false);
    // A first-round (guard-only, pre-containment) bundle is refused too.
    writeFileSync(
      bundle,
      'installHarnessGuard(); "volli-harness-keychain-guard:v1"; "use-mock-keychain"',
    );
    assert.equal(bundleCarriesGuard(bundle), false);
    writeFileSync(bundle, GUARDED);
    assert.equal(bundleCarriesGuard(bundle), true);
    assert.equal(bundleCarriesGuard(join(dir, "missing.cjs")), false);
  });
});

const GUARDED =
  'installHarnessGuard(); "volli-harness-keychain-guard:v1"; "use-mock-keychain"; ' +
  '"volli-harness-containment:v1"; "volli-harness-shell-recorder:v1"';

describe("launchProblems (the one launch gate)", () => {
  function fixture() {
    const appDir = join(dir, "app");
    mkdirSync(join(appDir, "dist-electron"), { recursive: true });
    writeFileSync(join(appDir, "package.json"), JSON.stringify({ main: "dist-electron/main.cjs" }));
    const bundle = join(appDir, "dist-electron", "main.cjs");
    writeFileSync(bundle, GUARDED);
    const source = join(appDir, "src.ts");
    writeFileSync(source, "");
    utimesSync(source, new Date(1_000_000), new Date(1_000_000));
    return { appDir, bundle, source, opts: { env: {}, bundle, appDir, sources: [source] } };
  }
  const dev = (bundle) => ({ build: "dev", appBinary: null, bundle });

  it("passes a current, guarded dev bundle", () => {
    const { bundle, opts } = fixture();
    assert.deepEqual(launchProblems(dev(bundle), opts), []);
  });

  it("refuses packed mode in every form", () => {
    const { bundle, opts } = fixture();
    assert.match(
      launchProblems({ ...dev(bundle), build: "packed" }, opts).join(),
      /not yet safe; dev builds only/,
    );
    assert.match(
      launchProblems({ ...dev(bundle), appBinary: "/Applications/Volli Code.app" }, opts).join(),
      /dev builds only/,
    );
    assert.match(
      launchProblems(dev(bundle), { ...opts, env: { VOLLI_SMOKE_APP_BINARY: "/x" } }).join(),
      /VOLLI_SMOKE_APP_BINARY/,
    );
  });

  it("refuses an unguarded, stale or mismatched bundle", () => {
    const { bundle, source, opts, appDir } = fixture();
    writeFileSync(bundle, 'installHarnessGuard(); "volli-harness-keychain-guard:v1"');
    assert.match(launchProblems(dev(bundle), opts).join(), /lacks the harness/);
    writeFileSync(bundle, GUARDED);
    utimesSync(source, new Date(), new Date(Date.now() + 60_000));
    assert.match(launchProblems(dev(bundle), opts).join(), /predates .*src\.ts/);
    utimesSync(source, new Date(1_000_000), new Date(1_000_000));
    writeFileSync(join(appDir, "package.json"), JSON.stringify({ main: "other.cjs" }));
    assert.match(launchProblems(dev(bundle), opts).join(), /package\.json main/);
  });
});

describe("electronExtraEnv ↔ the app's containment check", () => {
  it("is exactly what the app's boot-time containment accepts", () => {
    const scratch = realpathSync(dir);
    const layout = instanceLayout(scratch, join(scratch, "evidence"));
    const env = electronExtraEnv(layout, { loginShell: "/bin/sh", path: "/usr/bin" });
    const result = checkHarnessContainment({
      env,
      userDataDir: layout.userDataDir,
      isPackaged: false,
      ownerHome: "/Users/volli-owner-not-real",
    });
    assert.deepEqual(result.ok ? [] : result.problems, []);
    assert.equal(result.containment.agentHome, layout.home);
  });
});

describe("scratch fixture repos", () => {
  // The repo's own git must read none of this machine's config either.
  const gitEnv = { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  let saved;
  beforeEach(() => {
    saved = { ...process.env };
    Object.assign(process.env, gitEnv);
  });
  afterEach(() => {
    for (const key of Object.keys(gitEnv)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("are created in scratch with only a local bare origin, pushed", async () => {
    const scratch = realpathSync(dir);
    const { dir: repo, origin } = await makeScratchRepo(scratch, "drive-project");
    assert.ok(repo.startsWith(`${scratch}/`) && origin.startsWith(`${scratch}/`));
    const remotes = execFileSync("git", ["remote", "-v"], { cwd: repo, encoding: "utf8" });
    assert.deepEqual(
      [...new Set(remotes.trim().split("\n").map((l) => l.split(/\s+/).slice(0, 2).join(" ")))],
      [`origin ${origin}`],
    );
    const head = execFileSync("git", ["rev-parse", "main"], { cwd: origin, encoding: "utf8" });
    assert.match(head, /^[0-9a-f]{40}/);
    await assertScratchRemotes(repo, scratch);
  });

  it("refuse any remote that is not a scratch path", async () => {
    const scratch = realpathSync(dir);
    const { dir: repo } = await makeScratchRepo(scratch, "drive-project");
    for (const url of [
      "https://github.com/someone/real.git",
      "git@github.com:someone/real.git",
      "/Users/someone/code/real",
    ]) {
      execFileSync("git", ["remote", "add", "extra", url], { cwd: repo });
      await assert.rejects(assertScratchRemotes(repo, scratch), /non-scratch remotes/);
      execFileSync("git", ["remote", "remove", "extra"], { cwd: repo });
    }
  });
});

describe("ownedProcesses (identity, never name or path)", () => {
  const T0 = "Tue Oct 6 21:00:00 2026";
  const T1 = "Tue Oct 6 21:00:05 2026";
  const BEFORE = "Tue Oct 6 20:00:00 2026";
  const row = (pid, ppid, pgid, started, command = "x") => ({ pid, ppid, pgid, started, command });

  it("owns a verified root, its group and its descendants", () => {
    const table = [
      row(100, 1, 100, T0, "node supervisor.mjs /tmp/vd-1/spec.json"),
      row(101, 100, 100, T0, "Electron"),
      row(102, 101, 102, T1, "zsh (own session, a pty)"),
      row(103, 102, 102, T1, "sleep"),
      row(200, 50, 50, T0, "tail -f /tmp/vd-1/logs/main.log"),
    ];
    const pids = ownedProcesses(table, [{ pid: 100, pgid: 100, started: T0 }], { self: 1 })
      .map((p) => p.pid)
      .toSorted();
    assert.deepEqual(pids, [100, 101, 102, 103]);
  });

  it("leaves a reused pid, and its group, alone", () => {
    const table = [row(100, 1, 100, T1, "someone else's process"), row(101, 100, 100, T1)];
    assert.deepEqual(ownedProcesses(table, [{ pid: 100, pgid: 100, started: T0 }]), []);
  });

  it("owns an exited leader's group members only if they started after it", () => {
    const table = [row(101, 1, 100, T1, "orphaned helper"), row(102, 1, 100, BEFORE)];
    assert.deepEqual(
      ownedProcesses(table, [{ pid: 100, pgid: 100, started: T0 }]).map((p) => p.pid),
      [101],
    );
  });

  it("never owns itself", () => {
    const table = [row(100, 1, 100, T0), row(101, 100, 100, T0)];
    assert.deepEqual(
      ownedProcesses(table, [{ pid: 100, pgid: 100, started: T0 }], { self: 101 }).map(
        (p) => p.pid,
      ),
      [100],
    );
  });

  it("parses ps's lstart rows", () => {
    assert.deepEqual(
      parseProcessTable("  12    1   12 Tue Oct  6 21:00:00 2026 /bin/sleep 100\n"),
      [row(12, 1, 12, "Tue Oct 6 21:00:00 2026", "/bin/sleep 100")],
    );
  });
});
