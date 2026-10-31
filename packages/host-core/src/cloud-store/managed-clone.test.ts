/**
 * Runner-managed clones over real git: a box with no folder of the person's
 * clones the project from its recorded remote (a local bare repository here,
 * reached through an `insteadOf` rewrite of its https URL), and every
 * ticket's worktree shares that one clone's objects.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Session } from "@volli/shared";

import { openTestDb, type TestDb } from "../db/test-helpers";
import { runGitCapturingAsync } from "../worktree";
import {
  CloudFolderRequired,
  CloudRemoteRequired,
  createCloudSessionLocationResolver,
  readCheckoutRemote,
  type CloudLocationFacts,
} from "./location";
import {
  createManagedClones,
  createRunnerGit,
  ManagedCloneUnavailable,
  VOLLI_CO_AUTHOR_TRAILER,
  type ManagedCloneCredentials,
  type RunnerGit,
} from "./managed-clone";
import { managedCloneCredentials } from "./github-tokens";
import { createRunnerPathRegistry } from "./paths";

const PROJECT = "00000000-0000-4000-8000-000000000101";
const REPO = "00000000-0000-4000-8000-000000000103";
const SESSION = "00000000-0000-4000-8000-000000000104";
const TICKET_A = "00000000-0000-4000-8000-000000000105";
const TICKET_B = "00000000-0000-4000-8000-000000000106";
const REMOTE_URL = "https://git.example.test/acme/app.git";

let ctx: TestDb;
let root: string;
let remote: string;
let seed: string;

const IDENTITY = {
  GIT_AUTHOR_NAME: "Volli Test",
  GIT_AUTHOR_EMAIL: "test@volli.local",
  GIT_COMMITTER_NAME: "Volli Test",
  GIT_COMMITTER_EMAIL: "test@volli.local",
};

function git(cwd: string, args: readonly string[]) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...IDENTITY },
  }).trim();
}

/** Real git with the https remote rewritten to the local bare one, recording each call. */
function rewritingGit(calls: { args: readonly string[]; env: Record<string, string> }[] = []) {
  const real = createRunnerGit();
  const runner: RunnerGit = (args, options) => {
    calls.push({ args, env: { ...options.env } });
    const held = Number(options.env?.GIT_CONFIG_COUNT ?? "0");
    return real(args, {
      ...options,
      env: {
        ...options.env,
        GIT_CONFIG_COUNT: String(held + 1),
        [`GIT_CONFIG_KEY_${held}`]: `url.${remote}.insteadOf`,
        [`GIT_CONFIG_VALUE_${held}`]: REMOTE_URL,
      },
    });
  };
  return { runner, calls };
}

function ticketFacts(ticketId: string, number: number, title: string): CloudLocationFacts {
  return {
    project: { id: PROJECT, name: "Cloud project" },
    ticketPrefix: "VC",
    ticket: {
      id: ticketId,
      projectId: PROJECT,
      number,
      title,
      checkoutMode: "worktree",
      branch: null,
      baseBranch: null,
      retentionKeep: false,
      status: "doing",
      archivedAt: null,
    },
    primaryRepo: { id: REPO, projectId: PROJECT, baseBranch: null, remoteUrl: REMOTE_URL },
  };
}

function fixture(
  options: { credentials?: ManagedCloneCredentials; remoteUrl?: string | null } = {},
) {
  const registry = createRunnerPathRegistry(ctx.db, { runnerId: "runner-box" });
  const { runner, calls } = rewritingGit();
  const warnings: string[] = [];
  const managedClones = createManagedClones({
    root: join(root, "data", "repos"),
    git: runner,
    ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
    onWarning: (message) => warnings.push(message),
  });
  const byTicket = new Map<string, CloudLocationFacts>([
    [TICKET_A, ticketFacts(TICKET_A, 1, "First ticket")],
    [TICKET_B, ticketFacts(TICKET_B, 2, "Second ticket")],
  ]);
  const forSession = vi.fn(async (request: { ticketId: string | null }) => {
    const facts =
      request.ticketId === null
        ? { ...ticketFacts(TICKET_A, 1, "x"), ticket: null }
        : byTicket.get(request.ticketId)!;
    return options.remoteUrl === undefined
      ? facts
      : { ...facts, primaryRepo: { ...facts.primaryRepo, remoteUrl: options.remoteUrl } };
  });
  const reports = {
    checkout: vi.fn(async (_input: Record<string, unknown>) => undefined),
    workingCopy: vi.fn(async (input: { ticketId: string }) => ({
      workingCopyId: `copy-${input.ticketId}`,
    })),
  };
  const location = createCloudSessionLocationResolver({
    registry,
    forSession,
    reports,
    gitAsync: runGitCapturingAsync,
    home: join(root, "data"),
    managedClones,
  });
  return { registry, reports, location, calls, warnings, managedClones };
}

const sessionOn = (ticketId: string | null) =>
  ({ id: SESSION, projectId: PROJECT, ticketId }) as Session;

beforeEach(() => {
  // The machine's own git configuration (a global hooks path, signing) stays out.
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  ctx = openTestDb();
  root = realpathSync(mkdtempSync(join(tmpdir(), "volli-managed-clone-")));
  remote = join(root, "remote.git");
  seed = join(root, "seed");
  git(root, ["init", "--quiet", "--bare", "-b", "main", remote]);
  git(root, ["clone", "--quiet", remote, seed]);
  git(seed, ["checkout", "--quiet", "-b", "main"]);
  writeFileSync(join(seed, "README.md"), "v1\n");
  git(seed, ["add", "."]);
  git(seed, ["commit", "--quiet", "-m", "v1"]);
  git(seed, ["push", "--quiet", "origin", "main"]);
});
afterEach(() => {
  vi.unstubAllEnvs();
  ctx.cleanup();
  rmSync(root, { recursive: true, force: true });
});

describe("runner-managed clones", () => {
  it("clones once, then every ticket's worktree shares the clone's objects", async () => {
    const { registry, reports, location, calls } = fixture();
    const first = await location.prepare(sessionOn(TICKET_A));
    const repos = join(root, "data", "repos");
    const bare = join(repos, `${REPO}.git`);
    const main = join(repos, REPO);
    expect(git(bare, ["rev-parse", "--is-bare-repository"])).toBe("true");
    expect(git(first.directory, ["rev-parse", "--git-common-dir"])).toBe(bare);
    expect(git(first.directory, ["branch", "--show-current"])).toBe("volli/VC-1-first-ticket");
    expect(git(first.directory, ["rev-parse", "HEAD"])).toBe(git(seed, ["rev-parse", "HEAD"]));
    // No local branch shadows origin's, and nothing staged is left behind.
    expect(git(bare, ["for-each-ref", "--format=%(refname)", "refs/heads/"])).toBe(
      "refs/heads/volli/VC-1-first-ticket",
    );
    expect(readdirSync(repos).toSorted()).toEqual([REPO, `${REPO}.git`].toSorted());
    expect(registry.checkouts.get(PROJECT, REPO)).toMatchObject({
      absPath: main,
      kind: "managed_clone",
    });
    expect(reports.checkout).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "managed_clone", projectRepoId: REPO }),
    );
    expect(reports.checkout.mock.lastCall![0]).not.toHaveProperty("remoteUrl");

    // Origin moves on; the second ticket starts from what is pushed, from the same objects.
    writeFileSync(join(seed, "README.md"), "v2\n");
    git(seed, ["commit", "--quiet", "-am", "v2"]);
    git(seed, ["push", "--quiet", "origin", "main"]);
    const fetchesBefore = calls.filter((call) => call.args[0] === "fetch").length;
    const second = await location.prepare(sessionOn(TICKET_B));
    expect(calls.filter((call) => call.args[0] === "fetch").length).toBe(fetchesBefore + 1);
    expect(calls.some((call) => call.args[0] === "init" && calls.indexOf(call) > 4)).toBe(false);
    expect(git(second.directory, ["rev-parse", "--git-common-dir"])).toBe(bare);
    expect(git(second.directory, ["rev-parse", "HEAD"])).toBe(git(seed, ["rev-parse", "HEAD"]));
    // The clean, detached main worktree followed origin too.
    expect(git(main, ["rev-parse", "HEAD"])).toBe(git(seed, ["rev-parse", "HEAD"]));
    expect(git(bare, ["count-objects", "-v"])).toMatch(/count: \d+/u);
  });

  it("a ticket branch never tracks origin's default branch", async () => {
    const { location } = fixture();
    const { directory } = await location.prepare(sessionOn(TICKET_A));
    expect(() => git(directory, ["rev-parse", "--abbrev-ref", "@{upstream}"])).toThrow();
  });

  it("a refresh never drops a commit made in the main worktree, nor moves a dirty one", async () => {
    const { location } = fixture();
    const main = (await location.prepare(sessionOn(null))).directory;
    writeFileSync(join(main, "local.txt"), "made on the box\n");
    git(main, ["add", "."]);
    git(main, ["commit", "--quiet", "-m", "box-only"]);
    const boxOnly = git(main, ["rev-parse", "HEAD"]);
    writeFileSync(join(seed, "README.md"), "v2\n");
    git(seed, ["commit", "--quiet", "-am", "v2"]);
    git(seed, ["push", "--quiet", "origin", "main"]);
    await location.prepare(sessionOn(null));
    expect(git(main, ["rev-parse", "HEAD"])).toBe(boxOnly);

    git(main, ["checkout", "--quiet", "--detach", "refs/remotes/origin/main~1"]);
    writeFileSync(join(main, "README.md"), "edited\n");
    await location.prepare(sessionOn(null));
    expect(git(main, ["rev-parse", "HEAD"])).toBe(git(seed, ["rev-parse", "HEAD~1"]));
    git(main, ["checkout", "--quiet", "--", "README.md"]);
    await location.prepare(sessionOn(null));
    expect(git(main, ["rev-parse", "HEAD"])).toBe(git(seed, ["rev-parse", "HEAD"]));
  });

  it("recovers from a crashed first clone and an empty main worktree directory", async () => {
    const { location } = fixture();
    const repos = join(root, "data", "repos");
    mkdirSync(join(repos, `.${REPO}.crashed.tmp.git`), { recursive: true });
    await location.prepare(sessionOn(null));
    expect(readdirSync(repos).toSorted()).toEqual([REPO, `${REPO}.git`].toSorted());
    const main = join(repos, REPO);
    git(join(repos, `${REPO}.git`), ["worktree", "remove", "--force", main]);
    mkdirSync(main);
    await location.prepare(sessionOn(null));
    expect(existsSync(join(main, "README.md"))).toBe(true);
    rmSync(main, { recursive: true, force: true });
    mkdirSync(main);
    writeFileSync(join(main, "someone-elses.txt"), "x");
    await expect(location.prepare(sessionOn(null))).rejects.toThrow(/move it aside/u);
  });

  it("authenticates through the token adapter, and a refusal sends nothing", async () => {
    const identity = { name: "Dana Doe", email: "501+dana@users.noreply.github.com" };
    const answers = [
      {
        ok: true as const,
        grant: { token: "ghu_x", useUntil: 1, host: "git.example.test", login: "dana", identity },
      },
      {
        ok: false as const,
        error: { code: "github_not_connected" as const, message: "no", resetAt: null },
      },
    ];
    const credentials = managedCloneCredentials({ get: async () => answers.shift()! });
    const request = {
      remoteUrl: REMOTE_URL,
      projectRepoId: REPO,
      claim: { kind: "session" as const, sessionId: SESSION as never },
    };
    expect(await credentials.forRemote(request)).toEqual({
      host: "git.example.test",
      token: "ghu_x",
    });
    expect(await credentials.forRemote(request)).toBeNull();
  });

  it("a project Session works in the clone's main worktree", async () => {
    const { location } = fixture();
    const site = await location.prepare(sessionOn(null));
    expect(site.directory).toBe(join(root, "data", "repos", REPO));
    expect(git(site.directory, ["status", "--porcelain"])).toBe("");
  });

  it("commits made in a managed clone carry the Volli co-author trailer once", async () => {
    const { location } = fixture();
    const { directory } = await location.prepare(sessionOn(TICKET_A));
    writeFileSync(join(directory, "work.txt"), "work\n");
    git(directory, ["add", "."]);
    git(directory, ["commit", "--quiet", "-m", "Do the work"]);
    expect(git(directory, ["log", "-1", "--format=%(trailers:key=Co-authored-by,valueonly)"])).toBe(
      "Volli <noreply@volli.app>",
    );
    git(directory, [
      "commit",
      "--quiet",
      "--amend",
      "-m",
      `Do the work\n\n${VOLLI_CO_AUTHOR_TRAILER}`,
    ]);
    const message = git(directory, ["log", "-1", "--format=%B"]);
    expect(message.split(VOLLI_CO_AUTHOR_TRAILER)).toHaveLength(2);
  });

  it("authenticates its own fetches with the owner's token, for the remote's host only", async () => {
    const asked: unknown[] = [];
    const credentials: ManagedCloneCredentials = {
      async forRemote(input) {
        asked.push(input);
        return { host: "git.example.test", token: "ghu_secret" };
      },
    };
    const { location, calls } = fixture({ credentials });
    await location.prepare(sessionOn(TICKET_A));
    expect(asked[0]).toEqual({
      projectRepoId: REPO,
      remoteUrl: REMOTE_URL,
      claim: { kind: "session", sessionId: SESSION },
    });
    const fetch = calls.find((call) => call.args[0] === "fetch")!;
    expect(fetch.env).toMatchObject({
      GIT_CONFIG_KEY_0: "http.https://git.example.test/.extraHeader",
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from("x-access-token:ghu_secret").toString("base64")}`,
    });
    expect(calls.every((call) => !call.args.join(" ").includes("ghu_secret"))).toBe(true);
    // Nothing about the token is written into the clone's configuration.
    expect(
      execFileSync("git", ["config", "--list"], { cwd: join(root, "data", "repos", `${REPO}.git`) })
        .toString()
        .includes("ghu_secret"),
    ).toBe(false);
  });

  it("a token for another host, or none, sends no credentials", async () => {
    const elsewhere = fixture({
      credentials: { forRemote: async () => ({ host: "github.com", token: "ghu_x" }) },
    });
    await elsewhere.location.prepare(sessionOn(TICKET_A));
    const env = elsewhere.calls.find((call) => call.args[0] === "fetch")!.env;
    expect(env).toEqual({ GIT_SSH_COMMAND: "ssh -o BatchMode=yes" });
  });

  it("an inbox job's materialization asks for the job's claim", async () => {
    const asked: unknown[] = [];
    const { location } = fixture({
      credentials: {
        forRemote: async (input) => {
          asked.push(input.claim);
          return null;
        },
      },
    });
    const job = "00000000-0000-4000-8000-000000000199";
    await location.materialize({
      sessionId: job,
      jobId: job,
      projectId: PROJECT,
      ticketId: TICKET_A,
    });
    expect(asked).toEqual([{ kind: "job", jobId: job }]);
  });

  it("a failed refresh keeps working from what was fetched; a failed first clone leaves nothing", async () => {
    const { location, warnings, managedClones } = fixture();
    await location.prepare(sessionOn(TICKET_A));
    rmSync(remote, { recursive: true, force: true });
    const second = await location.prepare(sessionOn(TICKET_B));
    expect(existsSync(second.directory)).toBe(true);
    expect(warnings).toEqual(["Couldn't refresh a managed clone; using what was fetched last."]);

    const otherRepo = "00000000-0000-4000-8000-0000000001ff";
    await expect(
      managedClones.ensure({
        projectRepoId: otherRepo,
        remoteUrl: REMOTE_URL,
        claim: { kind: "session", sessionId: SESSION as never },
      }),
    ).rejects.toThrow(/git fetch failed/u);
    expect(readdirSync(join(root, "data", "repos")).some((name) => name.includes(otherRepo))).toBe(
      false,
    );
  });

  it("refuses without a remote, an unclonable remote, or an empty one", async () => {
    await expect(
      fixture({ remoteUrl: null }).location.prepare(sessionOn(TICKET_A)),
    ).rejects.toThrow(CloudRemoteRequired);
    await expect(
      fixture({ remoteUrl: "ext::sh -c id" }).location.prepare(sessionOn(TICKET_A)),
    ).rejects.toThrow(ManagedCloneUnavailable);
    const empty = join(root, "empty.git");
    git(root, ["init", "--quiet", "--bare", empty]);
    remote = empty;
    await expect(fixture().location.prepare(sessionOn(TICKET_A))).rejects.toThrow(
      /has no branches to work from yet/u,
    );
  });

  it("concurrent preparations of one repository clone it once", async () => {
    const { managedClones, calls } = fixture();
    const request = {
      projectRepoId: REPO,
      remoteUrl: REMOTE_URL,
      claim: { kind: "session" as const, sessionId: SESSION as never },
    };
    const [a, b] = await Promise.all([
      managedClones.ensure(request),
      managedClones.ensure(request),
    ]);
    expect(a).toEqual(b);
    expect(calls.filter((call) => call.args[0] === "init")).toHaveLength(1);
  });
});

describe("a main checkout's remote", () => {
  it("is reported from the person's folder, normalized; managed clones are off on a Mac", async () => {
    const checkout = join(root, "checkout");
    git(root, ["clone", "--quiet", remote, checkout]);
    git(checkout, ["remote", "set-url", "origin", "https://alice:pw@GitHub.com/acme/app"]);
    const registry = createRunnerPathRegistry(ctx.db, { runnerId: "runner-mac" });
    registry.checkouts.register({ projectId: PROJECT, projectRepoId: REPO, absPath: checkout });
    const reports = {
      checkout: vi.fn(async (_input: Record<string, unknown>) => undefined),
      workingCopy: vi.fn(async () => ({ workingCopyId: "copy-id" })),
    };
    const location = createCloudSessionLocationResolver({
      registry,
      forSession: async () => ({ ...ticketFacts(TICKET_A, 1, "x"), ticket: null }),
      reports,
      gitAsync: runGitCapturingAsync,
      home: join(root, "home"),
    });
    await location.prepare(sessionOn(null));
    expect(reports.checkout).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "main", remoteUrl: "https://github.com/acme/app.git" }),
    );
    expect(await readCheckoutRemote(createRunnerGit(), root)).toBeNull();
    const unregistered = createCloudSessionLocationResolver({
      registry: createRunnerPathRegistry(ctx.db, { runnerId: "runner-other" }),
      forSession: async () => ticketFacts(TICKET_A, 1, "x"),
      reports,
      gitAsync: runGitCapturingAsync,
    });
    await expect(unregistered.prepare(sessionOn(TICKET_A))).rejects.toThrow(CloudFolderRequired);
  });
});
