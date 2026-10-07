import { spawnSync } from "node:child_process";
import * as processes from "node:child_process";
import * as files from "node:fs/promises";
import * as board from "@volli/host-core/board";
import { createDetachedWorkTracker } from "../../../packages/host-core/src/detached-work";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { insertProject, listProjects, openVolliDb } from "@volli/host-core/db";
import { testProject } from "@volli/host-core/testing";
import { COMMAND_INTENT_CONFLICT, type HostWorkspaceCreateInput } from "@volli/shared";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createHostWorkspaces, type HostWorkspacesOptions } from "./host-workspaces";

// Native ESM namespace properties are immutable; keep real implementations,
// but make these external-boundary exports spyable for defensive failure tests.
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
}));
vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
}));

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
  vi.restoreAllMocks();
});
function fixture(extra: Partial<HostWorkspacesOptions> = {}) {
  const scratch = resolve(import.meta.dirname, "../../../.tmp");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "host-workspaces-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const db = openVolliDb(join(root, "volli.db"));
  cleanups.push(() => db.close());
  const home = join(root, "home");
  mkdirSync(home);
  const env = {
    HOME: home,
    PATH: process.env.PATH,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
  const projectsRoot = join(home, "volli");
  const options: HostWorkspacesOptions = {
    db,
    projectsRoot,
    userInstall: true,
    env,
    gitCredentialHelper: "",
    ...extra,
  };
  const service = createHostWorkspaces(options);
  cleanups.push(() => service.close());
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: root, env, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout;
  };
  const folder = (name = "folder") => {
    const path = join(root, name);
    mkdirSync(path);
    return path;
  };
  return { root, home, db, env, projectsRoot, service, options, git, folder };
}
const input = (path: string, name?: string): HostWorkspaceCreateInput => ({
  commandId: randomUUID(),
  source: { path },
  ...(name === undefined ? {} : { name }),
});
const cloneInput = (gitUrl: string, name?: string): HostWorkspaceCreateInput => ({
  commandId: randomUUID(),
  source: { gitUrl },
  ...(name === undefined ? {} : { name }),
});

/** Only external git failure boundaries are scripted; DB and registration always run for real. */
function fakeGit(
  f: ReturnType<typeof fixture>,
  script: string,
  extra: Partial<HostWorkspacesOptions> = {},
) {
  const bin = join(f.root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "git"), `#!/bin/sh\n${script}\n`, { mode: 0o700 });
  const service = createHostWorkspaces({
    ...f.options,
    env: { ...f.env, PATH: `${bin}:${process.env.PATH}` },
    ...extra,
  });
  cleanups.push(() => service.close());
  return service;
}

describe("host-owned workspace registration", () => {
  it("expires settled outcomes after one hour, recovers capacity and naturally replays existing paths", async () => {
    let at = 100;
    const onCreated = vi.fn();
    const f = fixture({ onCreated, testOnly: { capacity: 1, now: () => at } });
    const path = f.folder();
    const request = input(path);
    const result = await f.service.create(request);
    expect(result.ok).toBe(true);
    expect(await f.service.create(request)).toBe(result);
    expect(await f.service.create(input(path))).toMatchObject({
      ok: false,
      failure: { code: "capacity" },
    });
    at += 60 * 60_000 - 1;
    expect(await f.service.create(request)).toBe(result);
    at++;
    const retried = await f.service.create({ ...request, name: "Different intent after expiry" });
    expect(retried).toEqual(result);
    expect(retried).not.toBe(result);
    expect(onCreated).toHaveBeenCalledOnce();
    at += 60 * 60_000;
    expect(await f.service.create(input(path))).toEqual(result);
    expect(onCreated).toHaveBeenCalledOnce();
  });

  it("never expires running commands and starts retention at settlement", async () => {
    let at = 0;
    const f = fixture();
    const path = f.folder();
    let release!: (path: string) => void;
    const original = files.realpath;
    vi.spyOn(files, "realpath").mockImplementationOnce(
      () =>
        new Promise<string>((done) => {
          release = done;
        }),
    );
    const service = createHostWorkspaces({
      ...f.options,
      testOnly: { capacity: 1, now: () => at },
    });
    cleanups.push(() => service.close());
    const request = input(path);
    const pending = service.create(request);
    await vi.waitFor(() => expect(release).toBeDefined());
    at = 2 * 60 * 60_000;
    expect(await service.create(request)).toMatchObject({
      ok: false,
      failure: { code: "still-running" },
    });
    expect(await service.create(input(path))).toMatchObject({
      ok: false,
      failure: { code: "capacity" },
    });
    release(await original(path));
    const result = await pending;
    expect(result.ok).toBe(true);
    at += 60 * 60_000 - 1;
    expect(await service.create(request)).toBe(result);
    at++;
    expect(await service.create(input(path))).toEqual(result);
  });

  it("expired clone intents refuse the existing destination without repeating a clone", async () => {
    let at = 0;
    const f = fixture({ testOnly: { allowFileUrls: true, now: () => at } });
    const repo = f.folder("repo");
    f.git("init", repo);
    const request = cloneInput(pathToFileURL(repo).href);
    expect((await f.service.create(request)).ok).toBe(true);
    at += 60 * 60_000;
    expect(await f.service.create(request)).toMatchObject({
      ok: false,
      failure: { code: "target-exists" },
    });
  });
  it("bounds concurrent creates without retaining unaccepted commands", async () => {
    const f = fixture();
    const service = fakeGit(
      f,
      'for target do :; done\ncase "$target" in */repo-0|*/later) exit 1;; *) exec sleep 60;; esac',
    );
    const spawn = vi.spyOn(processes, "spawn");
    const running = Array.from({ length: 4 }, (_, i) =>
      service.create(cloneInput(`https://example.com/repo-${i}.git`)),
    );
    const retryable = cloneInput("https://example.com/later.git");
    expect(await service.create(retryable)).toMatchObject({
      ok: false,
      failure: { code: "capacity" },
    });
    expect(await service.create({ ...retryable, name: "Another intent" })).toMatchObject({
      ok: false,
      failure: { code: "capacity" },
    });
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(4));
    expect(await running[0]).toMatchObject({ ok: false, failure: { code: "clone-failed" } });
    expect(await service.create(retryable)).toMatchObject({
      ok: false,
      failure: { code: "clone-failed" },
    });
    await service.close();
    expect(await Promise.all(running.slice(1))).toEqual(
      Array.from({ length: 3 }, () =>
        expect.objectContaining({
          ok: false,
          failure: expect.objectContaining({ code: "interrupted" }),
        }),
      ),
    );
    expect(listProjects(f.db)).toEqual([]);
  });

  it("coalesces overlapping catalogs into one process-owned read", async () => {
    const f = fixture();
    const path = f.folder();
    insertProject(f.db, testProject({ id: randomUUID(), path }));
    const service = fakeGit(f, "exec sleep 60");
    const spawn = vi.spyOn(processes, "spawn");
    const first = service.list();
    const refused = expect(first).rejects.toThrow("shutting down");
    for (let i = 0; i < 20; i++) expect(service.list()).toBe(first);
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
    await service.close();
    await refused;
  });

  it("does not signal a child whose executable never started", async () => {
    const f = fixture();
    const service = createHostWorkspaces({
      ...f.options,
      env: { ...f.env, PATH: join(f.root, "missing-bin") },
    });
    cleanups.push(() => service.close());
    const spawn = processes.spawn;
    vi.spyOn(processes, "spawn").mockImplementationOnce((...args) => {
      const child = spawn(...args);
      expect(child.pid).toBeUndefined();
      queueMicrotask(() => {
        void service.close();
      });
      return child;
    });
    expect(await service.create(cloneInput("https://example.com/repo.git"))).toMatchObject({
      ok: false,
      failure: { code: "interrupted" },
    });
  });

  it("releases the production detached-work drain at bounded shutdown, even while filesystem work has not settled", async () => {
    const tracker = createDetachedWorkTracker();
    const f = fixture({ detachedWork: tracker });
    const path = f.folder();
    let release!: (path: string) => void;
    const gate = new Promise<string>((done) => {
      release = done;
    });
    vi.spyOn(files, "realpath").mockImplementationOnce(() => gate);
    const work = f.service.create(input(path));
    expect(tracker.pending).toBe(1);
    const drained = tracker.drain();
    vi.useFakeTimers();
    try {
      const closing = f.service.close();
      await vi.advanceTimersByTimeAsync(3000);
      await closing;
      await drained;
      expect(tracker.pending).toBe(0);
      release(path);
      expect(await work).toMatchObject({ ok: false, failure: { code: "interrupted" } });
      expect(listProjects(f.db)).toEqual([]);
    } finally {
      release(path);
      vi.useRealTimers();
    }
  });

  it("fences a statement prepared before shutdown, while preserving DB read properties", async () => {
    const f = fixture();
    let entered!: () => void;
    const ready = new Promise<void>((done) => {
      entered = done;
    });
    let release!: () => void;
    const gate = new Promise<void>((done) => {
      release = done;
    });
    const original = board.createProject;
    vi.spyOn(board, "createProject").mockImplementationOnce(async (ports, request) => {
      expect(ports.db.inTransaction).toBe(false);
      const statement = ports.db.prepare("SELECT 1");
      entered();
      await gate;
      statement.run();
      return original(ports, request);
    });
    const work = f.service.create(input(f.folder()));
    await ready;
    const closing = f.service.close();
    release();
    expect(await work).toMatchObject({ ok: false, failure: { code: "interrupted" } });
    await closing;
    expect(listProjects(f.db)).toEqual([]);
  });

  it("omits an overlong canonical locator, and refuses overlong registration and clone destinations", async () => {
    const f = fixture();
    const path = f.folder();
    insertProject(f.db, testProject({ id: randomUUID(), path }));
    const long = `/${"a".repeat(4097)}`;
    const realpath = files.realpath;
    vi.spyOn(files, "realpath").mockImplementation(async (...args) =>
      args[0] === path || args[0] === f.projectsRoot ? long : realpath(...args),
    );
    expect(await f.service.list()).toEqual({ workspaces: [], omitted: 1 });
    const stat = files.stat;
    const access = files.access;
    vi.spyOn(files, "stat").mockImplementation((...args) =>
      stat(args[0] === long ? path : args[0], args[1]),
    );
    vi.spyOn(files, "access").mockImplementation((...args) =>
      access(args[0] === long ? path : args[0], args[1]),
    );
    expect(await f.service.create(input(path))).toMatchObject({
      ok: false,
      failure: { code: "invalid-source" },
    });
    expect(await f.service.create(cloneInput("https://example.com/repo.git"))).toMatchObject({
      ok: false,
      failure: { code: "invalid-source" },
    });
    expect(listProjects(f.db)).toHaveLength(1);
  });
  it("registers a real readable folder canonically, reuses the shared registration, and replays exact outcomes", async () => {
    const track = vi.fn();
    const f = fixture({ detachedWork: { track } });
    const path = f.folder("project");
    const alias = join(f.root, "alias");
    symlinkSync(path, alias);
    const request = input(alias, " Project ");
    const result = await f.service.create(request);
    expect(result).toMatchObject({
      ok: true,
      workspace: { name: "Project", path, gitRemoteUrl: null },
    });
    expect(await f.service.create(request)).toBe(result);
    expect(await f.service.create(input(path))).toEqual(result);
    expect(listProjects(f.db)).toHaveLength(1);
    expect(await f.service.list()).toEqual({
      workspaces: [result.ok ? result.workspace : null],
      omitted: 0,
    });
    expect(track).toHaveBeenCalledTimes(2);
    expect(() => f.service.create({ ...request, name: "Different" })).toThrowError(
      expect.objectContaining({ [COMMAND_INTENT_CONFLICT]: true }),
    );
  });

  it("detects the base branch through git with isolated configuration", async () => {
    const f = fixture();
    const path = f.folder();
    f.git("init", "--initial-branch=fixture-main", path);
    expect(await f.service.create(input(path))).toMatchObject({ ok: true });
    expect(listProjects(f.db)[0]?.baseBranch).toBe("fixture-main");
  });

  it("refuses invalid sources, unreadable directories and conflicting shared prefixes without reflecting input", async () => {
    const f = fixture();
    const file = join(f.root, "file");
    writeFileSync(file, "x");
    for (const path of ["relative", "~/folder", "bad\0path", `/${"x".repeat(4097)}`]) {
      expect(await f.service.create(input(path))).toMatchObject({
        ok: false,
        failure: { code: "invalid-source" },
      });
    }
    for (const path of [file, join(f.root, "missing")]) {
      expect(await f.service.create(input(path))).toMatchObject({
        ok: false,
        failure: { code: "path-unreadable" },
      });
    }
    for (const name of [" ", "x".repeat(513), "x\ny", "x\u2028y", "x\u2029y"]) {
      expect(await f.service.create(input(f.root, name))).toMatchObject({
        ok: false,
        failure: { code: "invalid-source" },
      });
    }
    await f.service.create(input(f.folder("one"), "Same"));
    const refused = await f.service.create(input(f.folder("two"), "Same"));
    expect(refused).toMatchObject({ ok: false, failure: { code: "registration-failed" } });
    expect(await f.service.create(input(f.folder("three"), "Unique"))).toMatchObject({ ok: true });
  });

  it.each([
    "file:///tmp/repository.git",
    "http://example.com/repo.git",
    "https://user:secret@example.com/repo.git",
    "https://user@example.com/repo.git",
    "ssh://git:secret@example.com/repo.git",
    "https://example.com/repo.git?token=secret",
    "https://example.com/repo.git#secret",
    "https://example.com/%72epo.git",
    "-bad",
    "https://example.com/..",
    "https://example.com/repo name",
  ])("never starts a clone for forbidden production URL %s", async (url) => {
    const f = fixture();
    expect(await f.service.create(cloneInput(url))).toMatchObject({
      ok: false,
      failure: { code: "invalid-source" },
    });
    expect(existsSync(f.projectsRoot)).toBe(false);
  });

  it("clones a local bare fixture only with the explicit internal file transport seam", async () => {
    const f = fixture({ testOnly: { allowFileUrls: true } });
    const bare = join(f.root, "repository.git");
    f.git("init", "--bare", "--initial-branch=main", bare);
    const request = cloneInput(pathToFileURL(bare).href, "Cloned");
    const result = await f.service.create(request);
    const target = join(f.projectsRoot, "repository");
    expect(result).toMatchObject({
      ok: true,
      workspace: { name: "Cloned", path: target, gitRemoteUrl: null },
    });
    expect(existsSync(join(target, ".git"))).toBe(true);
    expect(statSync(f.projectsRoot).mode & 0o777).toBe(0o700);
    expect(await f.service.create(request)).toBe(result);
    expect(await f.service.create(cloneInput(pathToFileURL(bare).href))).toMatchObject({
      ok: false,
      failure: { code: "target-exists" },
    });
    await f.service.close();
    const restarted = createHostWorkspaces(f.options);
    cleanups.push(() => restarted.close());
    expect(await restarted.create(request)).toMatchObject({
      ok: false,
      failure: { code: "target-exists" },
    });
    expect(listProjects(f.db)).toHaveLength(1);
  });

  it("uses argument arrays and only the supplied helper, with prompts and inherited git configuration disabled", async () => {
    const f = fixture();
    const args = join(f.root, "args");
    const envPath = join(f.root, "environment");
    const helper = "!fixture-only-helper";
    const service = fakeGit(f, `printf '%s\\n' "$@" > '${args}'\nenv > '${envPath}'\nexit 1`);
    // Supply hostile ambient config without ever running its helper.
    const bin = join(f.root, "bin");
    const isolated = createHostWorkspaces({
      ...f.options,
      gitCredentialHelper: helper,
      env: {
        ...f.env,
        PATH: `${bin}:${process.env.PATH}`,
        SSH_AUTH_SOCK: "/fixture/own-agent.sock",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "credential.helper",
        GIT_CONFIG_VALUE_0: "real-helper-never-run",
      },
    });
    cleanups.push(() => isolated.close());
    expect(await isolated.create(cloneInput("git@example.com:group/repo.git"))).toMatchObject({
      ok: false,
      failure: { code: "clone-failed" },
    });
    expect(readFileSync(args, "utf8").trim().split("\n")).toEqual([
      "-c",
      "credential.helper=",
      "-c",
      `credential.helper=${helper}`,
      "clone",
      "--quiet",
      "--no-recurse-submodules",
      "--",
      "git@example.com:group/repo.git",
      join(f.projectsRoot, "repo"),
    ]);
    const environment = readFileSync(envPath, "utf8");
    expect(environment).toContain("GIT_TERMINAL_PROMPT=0");
    expect(environment).toContain("GIT_CONFIG_GLOBAL=/dev/null");
    expect(environment).toContain("GIT_ALLOW_PROTOCOL=https:ssh");
    expect(environment).toContain("SSH_AUTH_SOCK=/fixture/own-agent.sock");
    expect(environment).toContain("StrictHostKeyChecking=accept-new");
    expect(environment).not.toContain("real-helper-never-run");
    expect(environment).not.toContain("GIT_CONFIG_COUNT=");
    await service.close();
  });

  it("reserves destinations atomically and never deletes an existing directory or symlink", async () => {
    const f = fixture();
    mkdirSync(f.projectsRoot);
    const existing = join(f.projectsRoot, "repo");
    mkdirSync(existing);
    const marker = join(existing, "person-work");
    writeFileSync(marker, "keep");
    expect(await f.service.create(cloneInput("https://example.com/repo.git"))).toMatchObject({
      ok: false,
      failure: { code: "target-exists" },
    });
    expect(readFileSync(marker, "utf8")).toBe("keep");
    const alias = join(f.projectsRoot, "alias");
    symlinkSync(existing, alias);
    expect(await f.service.create(cloneInput("ssh://git@example.com/alias.git"))).toMatchObject({
      ok: false,
      failure: { code: "target-exists" },
    });
    expect(existsSync(alias)).toBe(true);
  });

  it("returns still-running, preserves completed outcomes at capacity and does not evict", async () => {
    const f = fixture();
    const service = fakeGit(f, "sleep 5", { testOnly: { capacity: 1, timeoutMs: 50 } });
    const request = cloneInput("https://example.com/repo.git");
    const pending = service.create(request);
    expect(await service.create(request)).toMatchObject({
      ok: false,
      failure: { code: "still-running" },
    });
    expect(() => service.create({ ...request, name: "Conflict" })).toThrowError(
      expect.objectContaining({ [COMMAND_INTENT_CONFLICT]: true }),
    );
    expect(await service.create(cloneInput("https://example.com/another.git"))).toMatchObject({
      ok: false,
      failure: { code: "capacity" },
    });
    const result = await pending;
    expect(result).toMatchObject({ ok: false, failure: { code: "clone-timeout" } });
    expect(await service.create(request)).toBe(result);
    expect(await service.create(cloneInput("https://example.com/another.git"))).toMatchObject({
      ok: false,
      failure: { code: "capacity" },
    });
    expect(existsSync(join(f.projectsRoot, "repo"))).toBe(false);
  });

  it("bounds child output and emits fixed sanitized failure text", async () => {
    const f = fixture();
    const service = fakeGit(
      f,
      "trap '' TERM\nwhile :; do printf 'password=secret-token https://user:secret@example.com/repo?token=secret\\n' >&2; done",
      { testOnly: { outputLimit: 50, timeoutMs: 5000 } },
    );
    const result = await service.create(cloneInput("https://example.com/repo.git"));
    expect(result).toEqual({
      ok: false,
      failure: { code: "clone-failed", message: "The host could not clone the repository." },
    });
    expect(existsSync(join(f.projectsRoot, "repo"))).toBe(false);
    expect(listProjects(f.db)).toEqual([]);
  });

  it("close cancels owned children, cleans failed clones and fences all later DB writes", async () => {
    const f = fixture();
    const service = fakeGit(f, "sleep 60");
    const request = cloneInput("https://example.com/repo.git");
    const pending = service.create(request);
    await vi.waitFor(() => expect(existsSync(join(f.projectsRoot, "repo"))).toBe(true));
    const closing = service.close();
    expect(service.close()).toBe(closing);
    await closing;
    expect(await pending).toMatchObject({ ok: false, failure: { code: "interrupted" } });
    expect(listProjects(f.db)).toEqual([]);
    expect(existsSync(join(f.projectsRoot, "repo"))).toBe(false);
    expect(await service.create(input(f.root))).toMatchObject({
      ok: false,
      failure: { code: "interrupted" },
    });
    await expect(service.list()).rejects.toThrow("shutting down");
  });

  it("fences shutdown during the shared core's awaited base-branch detection", async () => {
    const f = fixture();
    const path = f.folder();
    const marker = join(f.root, "detecting");
    const service = fakeGit(f, `touch '${marker}'\nsleep 60`);
    const pending = service.create(input(path));
    await vi.waitFor(() => expect(existsSync(marker)).toBe(true), { timeout: 5000 });
    await service.close();
    expect(await pending).toMatchObject({ ok: false, failure: { code: "interrupted" } });
    expect(listProjects(f.db)).toEqual([]);
  });

  it("escalates timeout and shutdown to SIGKILL when the external child ignores SIGTERM", async () => {
    const f = fixture();
    const service = fakeGit(f, "trap '' TERM\nexec sleep 60", { testOnly: { timeoutMs: 1000 } });
    expect(await service.create(cloneInput("https://example.com/repo.git"))).toMatchObject({
      ok: false,
      failure: { code: "clone-timeout" },
    });
    const pending = service.create(cloneInput("https://example.com/second.git"));
    await vi.waitFor(() => expect(existsSync(join(f.projectsRoot, "second"))).toBe(true));
    // Allow the shell to install its signal disposition before shutdown.
    await new Promise<void>((done) => setTimeout(done, 25));
    await service.close();
    expect(await pending).toMatchObject({ ok: false, failure: { code: "interrupted" } });
  });

  it("surfaces a missing git executable without raw spawn errors", async () => {
    const f = fixture();
    const service = createHostWorkspaces({
      ...f.options,
      env: { ...f.env, PATH: join(f.root, "no-programs") },
    });
    cleanups.push(() => service.close());
    expect(await service.create(cloneInput("https://example.com/repo.git"))).toEqual({
      ok: false,
      failure: { code: "clone-failed", message: "The host could not clone the repository." },
    });
    expect(existsSync(join(f.projectsRoot, "repo"))).toBe(false);
  });

  it("falls back to killing the direct child if signaling its group fails", async () => {
    const f = fixture();
    const service = fakeGit(f, "exec sleep 60", { testOnly: { timeoutMs: 50 } });
    const kill = vi.spyOn(process, "kill").mockImplementationOnce(() => {
      throw new Error("fixture signal boundary failure");
    });
    try {
      expect(await service.create(cloneInput("https://example.com/repo.git"))).toMatchObject({
        ok: false,
        failure: { code: "clone-timeout" },
      });
    } finally {
      kill.mockRestore();
    }
  });

  it("cleans a real clone when shared project registration refuses it", async () => {
    const f = fixture({ testOnly: { allowFileUrls: true } });
    await f.service.create(input(f.folder("existing"), "Same"));
    const bare = join(f.root, "second.git");
    f.git("init", "--bare", bare);
    expect(await f.service.create(cloneInput(pathToFileURL(bare).href, "Same"))).toMatchObject({
      ok: false,
      failure: { code: "registration-failed" },
    });
    expect(existsSync(join(f.projectsRoot, "second"))).toBe(false);
    expect(listProjects(f.db)).toHaveLength(1);
  });

  it("preserves a replacement directory after the external clone removed its reserved destination", async () => {
    const f = fixture();
    const preserved = join(f.root, "reserved");
    const service = fakeGit(
      f,
      `for target do :; done\nmv "$target" '${preserved}'\nmkdir "$target"\nprintf keep > "$target/person-work"\nexit 1`,
    );
    expect(await service.create(cloneInput("https://example.com/repo.git"))).toMatchObject({
      ok: false,
      failure: { code: "clone-failed" },
    });
    expect(readFileSync(join(f.projectsRoot, "repo", "person-work"), "utf8")).toBe("keep");
    expect(existsSync(preserved)).toBe(true);
  });

  it("keeps a fixed failure if the external clone already removed its reservation", async () => {
    const f = fixture();
    const service = fakeGit(f, 'for target do :; done\nrmdir "$target"\nexit 1');
    expect(await service.create(cloneInput("https://example.com/repo.git"))).toMatchObject({
      ok: false,
      failure: { code: "clone-failed" },
    });
    expect(existsSync(join(f.projectsRoot, "repo"))).toBe(false);
  });

  it("refuses a nonabsolute root and reports filesystem failures with fixed text", async () => {
    const f = fixture();
    const service = createHostWorkspaces({ ...f.options, projectsRoot: "relative" });
    cleanups.push(() => service.close());
    expect(await service.create(cloneInput("https://example.com/repo.git"))).toMatchObject({
      ok: false,
      failure: { code: "invalid-source" },
    });
    const notDirectory = join(f.root, "not-directory");
    writeFileSync(notDirectory, "x");
    const broken = createHostWorkspaces({ ...f.options, projectsRoot: notDirectory });
    cleanups.push(() => broken.close());
    expect(await broken.create(cloneInput("https://example.com/repo.git"))).toMatchObject({
      ok: false,
      failure: { code: "clone-failed" },
    });
    const system = fakeGit(f, "exit 1", { userInstall: false });
    expect(await system.create(cloneInput("https://example.com/repo.git"))).toMatchObject({
      ok: false,
      failure: { code: "clone-failed" },
    });
    expect(statSync(f.projectsRoot).mode & 0o777).toBe(0o755);
  });

  it("reports an unwritable reservation without deleting another directory", async () => {
    const f = fixture();
    mkdirSync(f.projectsRoot);
    chmodSync(f.projectsRoot, 0o500);
    try {
      // This is a real service-account permission check, not a scripted filesystem.
      if (process.getuid?.() === 0) return;
      expect(await f.service.create(cloneInput("https://example.com/repo.git"))).toMatchObject({
        ok: false,
        failure: { code: "clone-failed" },
      });
      expect(existsSync(f.projectsRoot)).toBe(true);
      expect(existsSync(join(f.projectsRoot, "repo"))).toBe(false);
    } finally {
      chmodSync(f.projectsRoot, 0o700);
    }
  });

  it("rejects an unrepresentable existing registration instead of producing an invalid wire row", async () => {
    const f = fixture();
    const path = f.folder();
    insertProject(f.db, testProject({ id: "unrepresentable-id", path }));
    expect(await f.service.create(input(path))).toMatchObject({
      ok: false,
      failure: { code: "registration-failed" },
    });
    expect(listProjects(f.db)).toHaveLength(1);
  });

  it("ignores invalid branch names returned by the external git process", async () => {
    const f = fixture();
    const path = f.folder();
    const service = fakeGit(f, "printf 'not a branch\\n'");
    expect(await service.create(input(path))).toMatchObject({ ok: true });
    expect(listProjects(f.db)[0]?.baseBranch).toBeNull();
  });

  it("reports unexpected database registration failures without raw error text", async () => {
    const f = fixture();
    const path = f.folder();
    f.db.close();
    expect(await f.service.create(input(path))).toMatchObject({
      ok: false,
      failure: { code: "registration-failed" },
    });
  });

  it("does not change permissions on an existing projects root", async () => {
    const f = fixture();
    mkdirSync(f.projectsRoot, { mode: 0o755 });
    chmodSync(f.projectsRoot, 0o755);
    const service = fakeGit(f, "exit 1");
    await service.create(cloneInput("https://example.com/repo.git"));
    expect(statSync(f.projectsRoot).mode & 0o777).toBe(0o755);
  });
});

describe("bounded host catalog", () => {
  it("skips a slow filesystem row softly, finishes other rows and fences late work", async () => {
    const f = fixture({ testOnly: { rowTimeoutMs: 1000, catalogTimeoutMs: 3000 } });
    const slow = f.folder("slow");
    const good = f.folder("good");
    insertProject(f.db, testProject({ id: randomUUID(), path: slow, sortOrder: 0 }));
    insertProject(f.db, testProject({ id: randomUUID(), path: good, sortOrder: 1 }));
    let release!: (path: string) => void;
    vi.spyOn(files, "realpath").mockImplementationOnce(
      () =>
        new Promise<string>((done) => {
          release = done;
        }),
    );
    const spawn = vi.spyOn(processes, "spawn");
    expect(await f.service.list()).toMatchObject({ omitted: 1, workspaces: [{ path: good }] });
    const count = spawn.mock.calls.length;
    release(slow);
    await Promise.resolve();
    await Promise.resolve();
    expect(spawn).toHaveBeenCalledTimes(count);
  });

  it("bounds the whole catalog even when every filesystem read stalls", async () => {
    const f = fixture({ testOnly: { rowTimeoutMs: 30, catalogTimeoutMs: 40 } });
    for (let i = 0; i < 4; i++)
      insertProject(
        f.db,
        testProject({ id: randomUUID(), path: f.folder(`slow-${i}`), sortOrder: i }),
      );
    vi.spyOn(files, "realpath").mockImplementation(() => new Promise<string>(() => {}));
    const started = Date.now();
    expect(await f.service.list()).toEqual({ workspaces: [], omitted: 4 });
    expect(Date.now() - started).toBeLessThan(500);
    await f.service.close();
  });

  it("softly skips a timed-out Git row", async () => {
    const f = fixture();
    insertProject(f.db, testProject({ id: randomUUID(), path: f.folder() }));
    const service = fakeGit(f, "exec sleep 60", { testOnly: { rowTimeoutMs: 30 } });
    const spawn = vi.spyOn(processes, "spawn");
    expect(await service.list()).toEqual({ workspaces: [], omitted: 1 });
    // Let the child reach its own timeout rather than changing it to shutdown.
    await vi.waitFor(() => expect(spawn.mock.results[0]!.value.signalCode).not.toBeNull());
    await service.close();
  });

  it("uses UTF-8 JSON bytes and keeps complete rows when the byte budget fills", async () => {
    const f = fixture({ testOnly: { catalogBytes: 240 } });
    for (let i = 0; i < 3; i++)
      insertProject(
        f.db,
        testProject({
          id: randomUUID(),
          name: "界".repeat(30),
          path: f.folder(`byte-${i}`),
          sortOrder: i,
        }),
      );
    const result = await f.service.list();
    expect(result.workspaces).toHaveLength(0);
    expect(result.omitted).toBe(3);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(240);
  });

  it("breaks sort-order ties by creation time and then identity", async () => {
    const f = fixture();
    const a = "00000000-0000-4000-8000-000000000001";
    const b = "00000000-0000-4000-8000-000000000002";
    const c = "00000000-0000-4000-8000-000000000003";
    for (const [id, createdAt] of [
      [b, 2],
      [c, 1],
      [a, 2],
    ] as const)
      insertProject(f.db, testProject({ id, path: f.folder(id), sortOrder: 0, createdAt }));
    expect((await f.service.list()).workspaces.map((row) => row.id)).toEqual([c, a, b]);
  });
  it("scrubs origin credentials and omits unrepresentable paths rather than clipping them", async () => {
    const f = fixture();
    const path = f.folder();
    f.git("init", path);
    f.git(
      "-C",
      path,
      "remote",
      "add",
      "origin",
      "https://user:password@example.com/team/repo.git?token=secret#secret",
    );
    insertProject(f.db, testProject({ id: randomUUID(), name: "x".repeat(700), path }));
    insertProject(
      f.db,
      testProject({ id: randomUUID(), path: `/${"x".repeat(4097)}`, sortOrder: 1 }),
    );
    insertProject(f.db, testProject({ id: randomUUID(), path: "relative", sortOrder: 2 }));
    insertProject(
      f.db,
      testProject({ id: randomUUID(), path: join(f.root, "gone"), sortOrder: 3 }),
    );
    const result = await f.service.list();
    expect(result.omitted).toBe(3);
    expect(result.workspaces).toHaveLength(1);
    expect(result.workspaces[0]?.name).toHaveLength(512);
    expect(result.workspaces[0]?.gitRemoteUrl).toBe("https://example.com/team/repo.git");
    for (const url of [
      "git@example.com:team/repo.git",
      "ssh://git:password@example.com/team/repo.git?secret#secret",
      "https://example.com/" + "x".repeat(2100),
      "not-a-url",
      "file:///private/folder",
    ]) {
      f.git("-C", path, "remote", "set-url", "origin", url);
      const row = (await f.service.list()).workspaces[0]!;
      expect(row.gitRemoteUrl).toBe(
        url.startsWith("git@") || url.startsWith("ssh:") ? "ssh://example.com/team/repo.git" : null,
      );
    }
  });

  it("omits control characters in names and canonical paths", async () => {
    const f = fixture();
    for (const name of ["x\ny", "x\u2028y", "x\u2029y"])
      insertProject(f.db, testProject({ id: randomUUID(), name, path: f.folder(randomUUID()) }));
    const unsafe = f.folder("unsafe");
    insertProject(f.db, testProject({ id: randomUUID(), path: unsafe }));
    const realpath = files.realpath;
    vi.spyOn(files, "realpath").mockImplementation((path) =>
      String(path) === unsafe ? Promise.resolve(`${unsafe}\n`) : realpath(path),
    );
    expect(await f.service.list()).toEqual({ workspaces: [], omitted: 4 });
  });

  it("omits invalid identities and empty names, and hides credential-looking origin path segments", async () => {
    const f = fixture();
    const path = f.folder();
    f.git("init", path);
    f.git(
      "-C",
      path,
      "remote",
      "add",
      "origin",
      `https://example.com/ghp_${"a".repeat(36)}/repo.git`,
    );
    insertProject(f.db, testProject({ id: randomUUID(), path }));
    insertProject(f.db, testProject({ id: "not-a-uuid", path: f.folder("bad-id"), sortOrder: 1 }));
    insertProject(
      f.db,
      testProject({ id: randomUUID(), name: "", path: f.folder("empty-name"), sortOrder: 2 }),
    );
    insertProject(
      f.db,
      testProject({ id: randomUUID(), path: `${f.root}/nul\0path`, sortOrder: 3 }),
    );
    const catalog = await f.service.list();
    expect(catalog.omitted).toBe(3);
    expect(catalog.workspaces).toHaveLength(1);
    expect(catalog.workspaces[0]?.gitRemoteUrl).toBeNull();
  });

  it("close interrupts a catalog's owned git child", async () => {
    const f = fixture();
    const path = f.folder();
    insertProject(f.db, testProject({ id: randomUUID(), path }));
    const marker = join(f.root, "listing");
    const service = fakeGit(f, `touch '${marker}'\nexec sleep 60`, {
      testOnly: { rowTimeoutMs: 10_000 },
    });
    const list = service.list();
    // Capture rejection before shutdown, so it never becomes an unhandled promise.
    const outcome = list.then(
      () => "success",
      () => "interrupted",
    );
    await vi.waitFor(() => expect(existsSync(marker)).toBe(true), { timeout: 5000 });
    await service.close();
    expect(await outcome).toBe("interrupted");
  }, 10_000);

  it("limits rows to 500 and counts every omitted project", async () => {
    const f = fixture();
    // Isolate the row-count policy from 500 external process start times.
    vi.spyOn(processes, "spawn").mockImplementation(() => {
      throw new Error("No origin");
    });
    for (let i = 0; i < 502; i++)
      insertProject(
        f.db,
        testProject({ id: randomUUID(), path: f.folder(`row-${i}`), sortOrder: i }),
      );
    const result = await f.service.list();
    expect(result.workspaces).toHaveLength(500);
    expect(result.omitted).toBe(2);
  }, 20_000);
});
