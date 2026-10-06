import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { openTestDb, testProject, testTicket, type TestDb } from "@volli/host-core/db/test-helpers";
import { insertProject } from "@volli/host-core/db/projects-repo";
import { insertTicket, updateTicketFields } from "@volli/host-core/db/tickets-repo";
import { BackgroundShellHost } from "@volli/host-core/shell/background-shell-host";
import {
  busySiteWithin,
  runGitCapturing,
  runGitCapturingAsync,
  trimFinishedWorktree,
  type AgentSiteRuntime,
} from "@volli/host-core/worktree";
import { createDesktopBusyWorktreeSites } from "./worktree-activity";

const owner = {
  sessionId: "session-1",
  attachmentId: "attachment-1",
  projectId: "p1",
  ticketId: "t1",
};
const hosts: BackgroundShellHost[] = [];
const roots: string[] = [];
const databases: TestDb[] = [];

afterEach(async () => {
  if (vi.isFakeTimers()) await vi.runOnlyPendingTimersAsync();
  vi.useRealTimers();
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  for (const db of databases.splice(0)) db.cleanup();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function supplier(overrides: Partial<Parameters<typeof createDesktopBusyWorktreeSites>[0]> = {}) {
  return createDesktopBusyWorktreeSites({
    terminalCwds: () => [],
    shells: { liveCwds: () => [] },
    runtime: () => null,
    onUnreadable: vi.fn(),
    ...overrides,
  });
}

function runtimeAt(directory: string, turnActive: boolean) {
  return {
    openNativeBindings: () => [
      {
        sessionId: owner.sessionId,
        attachmentId: owner.attachmentId,
        directory,
        lastProgressAt: 0,
        inFlightTools: [],
      },
    ],
    projection: vi.fn(async () => ({ projection: { turnActive } })),
  } satisfies Pick<AgentSiteRuntime, "openNativeBindings" | "projection">;
}

function trimFixture() {
  const root = mkdtempSync(join(process.cwd(), ".busy-worktree-"));
  roots.push(root);
  const git = (args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Volli Test",
        GIT_AUTHOR_EMAIL: "test@volli.local",
        GIT_COMMITTER_NAME: "Volli Test",
        GIT_COMMITTER_EMAIL: "test@volli.local",
      },
    });
  git(["init", "-q"]);
  writeFileSync(join(root, ".gitignore"), "node_modules/\n");
  git(["add", ".gitignore"]);
  git(["commit", "-q", "-m", "fixture"]);
  const artifact = join(root, "node_modules");
  mkdirSync(artifact);
  writeFileSync(join(artifact, "build.js"), "generated\n");
  const ctx = openTestDb();
  databases.push(ctx);
  insertProject(ctx.db, testProject({ id: "p1", path: root }));
  insertTicket(ctx.db, testTicket("p1", { id: "t1", status: "done" }));
  updateTicketFields(
    ctx.db,
    "t1",
    { worktreePath: root, branch: "volli/VC-1-test", baseBranch: "main" },
    1,
  );
  const host = new BackgroundShellHost({
    publishState: () => {},
    publishRemoved: () => {},
    settleMs: 100,
    killGraceMs: 200,
  });
  hosts.push(host);
  const busySites = supplier({ shells: host, runtime: () => runtimeAt(root, false) });
  return {
    root,
    artifact,
    host,
    busySites,
    trim: () =>
      trimFinishedWorktree(
        {
          worktree: {
            db: ctx.db,
            git: runGitCapturing,
            gitAsync: runGitCapturingAsync,
            blobsRoot: "unused",
          },
          now: () => 1,
          busySites,
        },
        "t1",
      ),
    start: (command: string) =>
      host.start(owner, {
        command,
        cwd: artifact,
        title: null,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      }),
  };
}

const busyReason = {
  kind: "skipped",
  reason: "A terminal is still running in this worktree. Close it first.",
};

describe("desktop busy worktree supplier", () => {
  it("reads terminals and shells afresh even without a Session runtime", async () => {
    const terminals = ["/work/terminal"];
    const shells = ["/work/shell"];
    const busy = supplier({ terminalCwds: () => terminals, shells: { liveCwds: () => shells } });
    expect(await busy("/work")).toEqual([
      { directory: terminals[0], surface: "terminal" },
      { directory: shells[0], surface: "terminal" },
    ]);
    terminals.length = 0;
    shells.length = 0;
    expect(await busy("/work")).toEqual([]);
  });

  it("keeps idle bindings non-busy and scopes active-turn reads to the target", async () => {
    const runtime = runtimeAt("/work/ticket/src", false);
    const busy = supplier({ runtime: () => runtime });
    expect(await busy("/work/ticket")).toEqual([]);
    runtime.projection.mockResolvedValue({ projection: { turnActive: true } });
    expect(await busy("/work/ticket")).toEqual([{ directory: "/work/ticket", surface: "agent" }]);
    runtime.projection.mockClear();
    expect(await busy("/work/other")).toEqual([]);
    expect(runtime.projection).not.toHaveBeenCalled();
  });

  it("preserves fail-open agent reads without losing shell evidence", async () => {
    const runtime = runtimeAt("/work/ticket", true);
    const error = new Error("unreadable history");
    runtime.projection.mockRejectedValue(error);
    const onUnreadable = vi.fn();
    const busy = supplier({
      runtime: () => runtime,
      onUnreadable,
      shells: { liveCwds: () => ["/work/ticket/src"] },
    });
    expect(await busy("/work/ticket")).toEqual([
      { directory: "/work/ticket/src", surface: "terminal" },
    ]);
    expect(onUnreadable).toHaveBeenCalledWith(owner.sessionId, error);
  });

  it("does not block another worktree just because a shell is live elsewhere", async () => {
    const sites = await supplier({ shells: { liveCwds: () => ["/work/ticket-other"] } })(
      "/work/ticket",
    );
    expect(busySiteWithin("/work/ticket", sites)).toBeNull();
  });

  it("refuses Done trim between turns while a shell runs, then trims after exit", async () => {
    const f = trimFixture();
    const started = await f.start("while [ ! -f stop ]; do sleep 0.05; done");
    expect(started.shell.state).toBe("running");
    expect(await f.trim()).toEqual(busyReason);
    expect(existsSync(f.artifact)).toBe(true);
    writeFileSync(join(f.artifact, "stop"), "");
    await vi.waitFor(() => expect(f.host.listAll()[0]?.state).toBe("exited"), { timeout: 10_000 });
    // Retained output is not a live process and must not hold the worktree busy.
    expect(f.host.listAll()[0]?.state).toBe("exited");
    expect(await f.busySites(f.root)).toEqual([]);
    expect((await f.trim()).kind).toBe("trimmed");
    expect(existsSync(f.artifact)).toBe(false);
  }, 30_000);

  it("still refuses while a disposed shell is terminating, until its process exits", async () => {
    const f = trimFixture();
    const started = await f.start("trap '' TERM; printf ready; sleep 60");
    await vi.waitFor(
      () => expect(f.host.tailOf(started.shell.shellId)?.output).toContain("ready"),
      { timeout: 10_000 },
    );
    // Hold the SIGKILL grace deterministically: an overloaded CI worker must
    // not make the process exit before the terminating-shell assertion.
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    f.host.disposeSession(owner.sessionId);
    expect(f.host.listAll()).toEqual([]);
    expect(await f.trim()).toEqual(busyReason);
    expect(existsSync(f.artifact)).toBe(true);
    const closed = f.host.close();
    await vi.advanceTimersByTimeAsync(200);
    await closed;
    vi.useRealTimers();
    expect(await f.busySites(f.root)).toEqual([]);
    expect((await f.trim()).kind).toBe("trimmed");
    expect(existsSync(f.artifact)).toBe(false);
  }, 30_000);
});
