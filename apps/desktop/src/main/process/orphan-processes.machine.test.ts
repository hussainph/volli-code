/**
 * The acceptance cases that can only be proven against the real machine
 * (VC-341): a process that actually double-forked out of Volli's reach, found
 * by the real `ps` and the real `lsof`, listed under the right Ticket, and
 * reaped.
 *
 * FIXTURES ONLY. The worktree these processes stand in is a temp directory this
 * suite created, and the classification is scoped to it — nothing here reads or
 * signals anything under the real `~/.volli/worktrees`.
 *
 * macOS only. `ps`'s `lstart` column and `lsof -d cwd` are BSD conventions, and
 * this app ships on macOS; on any other platform the suite skips rather than
 * asserting against output the parsers were never written for.
 */
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { realpathSync } from "node:fs";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vite-plus/test";
import type { WorktreeRef } from "@volli/shared";

import { readProcessInventory } from "./inventory";
import { OrphanProcessService } from "./orphan-processes";

const run = promisify(execFile);
const onMac = process.platform === "darwin";

const directories: string[] = [];
const spawnedPids: number[] = [];

function fixtureWorktree(): WorktreeRef {
  // realpath: macOS puts temp dirs under a `/var` symlink to `/private/var`,
  // and `lsof` reports the resolved path a process is actually standing in.
  const path = realpathSync(mkdtempSync(join(tmpdir(), "volli-orphan-fixture-")));
  directories.push(path);
  return {
    path,
    ticketId: "ticket-341",
    ticketDisplayId: "VC-341",
    projectId: "project-1",
  };
}

/**
 * Starts a sleeper that has left its parent's process group behind, the way a
 * daemonising tool does. `bash -c "... &"` returns immediately, the child is
 * reparented to launchd, and `disown` detaches it from the shell's job table —
 * which is the shape VC-336's group kill cannot reach and this sweep must.
 */
async function doubleForkedSleeper(cwd: string): Promise<number> {
  // The redirections matter as much as the `&`: a background child that keeps
  // the shell's stdout open holds this very call open too, which is the same
  // property that makes these processes hard to notice in the first place.
  const { stdout } = await run(
    "/bin/bash",
    ["-c", "sleep 120 >/dev/null 2>&1 </dev/null & disown; echo $!"],
    { cwd },
  );
  const pid = Number(stdout.trim());
  spawnedPids.push(pid);
  return pid;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

afterEach(() => {
  for (const pid of spawnedPids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already reaped, which is what most of these tests are about.
    }
  }
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe.skipIf(!onMac)("the sweep against the real machine", () => {
  it("finds a double-forked orphan by its working directory and reaps it", async () => {
    const worktree = fixtureWorktree();
    const pid = await doubleForkedSleeper(worktree.path);
    const service = new OrphanProcessService({
      ledger: { listOpen: () => [], markExited: () => {}, prune: () => 0 },
      worktrees: () => [worktree],
      liveSessionIds: () => [],
      liveWorktreePaths: () => [],
      openTerminalCwds: () => [],
      inventory: () => readProcessInventory(),
      killGraceMs: 250,
    });

    const inventory = await service.scan();
    const candidate = inventory.candidates.find((entry) => entry.pid === pid);

    // It is there, it is attributed to the Ticket by path, and it carries the
    // evidence a person judges it on.
    expect(candidate).toBeDefined();
    expect(candidate).toMatchObject({
      source: "cwd",
      stance: "reapable",
      ticketDisplayId: "VC-341",
      worktreePath: worktree.path,
      cwd: worktree.path,
    });
    expect(candidate?.command).toContain("sleep 120");
    expect(candidate?.rssBytes).toBeGreaterThan(0);

    const report = await service.reap({
      scanRevision: inventory.revision,
      itemIds: [candidate!.itemId],
    });

    expect(report.reapedCount).toBe(1);
    expect(alive(pid)).toBe(false);
  }, 30_000);

  it("says nothing about that same process while a live Session holds its worktree", async () => {
    const worktree = fixtureWorktree();
    const pid = await doubleForkedSleeper(worktree.path);
    const service = new OrphanProcessService({
      ledger: { listOpen: () => [], markExited: () => {}, prune: () => 0 },
      worktrees: () => [worktree],
      liveSessionIds: () => [],
      liveWorktreePaths: () => [worktree.path],
      openTerminalCwds: () => [],
      inventory: () => readProcessInventory(),
    });

    const inventory = await service.scan();

    expect(inventory.candidates.find((entry) => entry.pid === pid)).toBeUndefined();
    expect(alive(pid)).toBe(true);
  }, 30_000);

  it("lists a process with a terminal of its own as not Volli's, and offers no Reap", async () => {
    // A person's own shell, standing in the checkout: no ledger row, and a
    // controlling TTY. It is reported — it explains what is holding the
    // worktree — and it is not something this app may kill.
    const worktree = fixtureWorktree();
    const service = new OrphanProcessService({
      ledger: { listOpen: () => [], markExited: () => {}, prune: () => 0 },
      worktrees: () => [worktree],
      liveSessionIds: () => [],
      liveWorktreePaths: () => [],
      openTerminalCwds: () => [],
      // The one fact a headless test cannot produce is a controlling terminal,
      // so the process table is the real one with a tty stamped on this row.
      inventory: async () => {
        const facts = await readProcessInventory();
        for (const fact of facts) {
          if (fact.cwd === worktree.path) fact.tty = "s004";
        }
        return facts;
      },
      killGraceMs: 250,
    });
    const pid = await doubleForkedSleeper(worktree.path);

    const inventory = await service.scan();
    const candidate = inventory.candidates.find((entry) => entry.pid === pid);

    expect(candidate).toMatchObject({ stance: "not-volli", tty: "s004" });
    expect(inventory.reapableCount).toBe(0);

    const report = await service.reap({
      scanRevision: inventory.revision,
      itemIds: [candidate!.itemId],
    });
    expect(report.reapedCount).toBe(0);
    expect(report.kept[0]?.reason).toContain("Not Volli's");
    expect(alive(pid)).toBe(true);
  }, 30_000);

  it("attributes a ledger-owned process to its Session even outside any worktree", async () => {
    // The Board Session case: a process standing in the project root, where cwd
    // attribution alone could not tell Volli's process from the user's own.
    const worktree = fixtureWorktree();
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "volli-board-fixture-")));
    directories.push(outside);
    const pid = await doubleForkedSleeper(outside);
    const started = (await readProcessInventory()).find((fact) => fact.pid === pid)?.startedAt;
    const service = new OrphanProcessService({
      ledger: {
        listOpen: () => [
          {
            id: "row-1",
            sessionId: "session-that-ended",
            ticketId: null,
            projectId: "project-1",
            kind: "shell",
            pid,
            pgid: pid,
            startedAt: started!,
            cwd: outside,
            command: "sleep 120",
          },
        ],
        markExited: () => {},
        prune: () => 0,
      },
      worktrees: () => [worktree],
      liveSessionIds: () => [],
      liveWorktreePaths: () => [],
      openTerminalCwds: () => [],
      inventory: () => readProcessInventory(),
      killGraceMs: 250,
    });

    const inventory = await service.scan();
    const candidate = inventory.candidates.find((entry) => entry.pid === pid);

    expect(candidate).toMatchObject({ source: "ledger", sessionId: "session-that-ended" });
    expect(candidate?.worktreePath).toBeNull();
    // And the fixture path never leaked into the attribution.
    expect(candidate?.cwd?.startsWith(`${worktree.path}${sep}`)).toBe(false);
  }, 30_000);
});
