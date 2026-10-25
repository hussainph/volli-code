import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { roleImpliedByTicket } from "@volli/shared";
import type { Session } from "@volli/shared";
import { detachProject, insertProject, reattachProject } from "../db/projects-repo";
import { insertTicket } from "../db/tickets-repo";
import { openTestDb, testProject, testTicket, type TestDb } from "../db/test-helpers";

// Only `ensure` is stood in for, so `prepare` can be asked the one question no
// return value answers: whether a ticketless Session touches git at all.
const { ensureWorktree, worktreeHome } = vi.hoisted(() => ({
  ensureWorktree: vi.fn(),
  // The `~` the worktree deps resolve, where a pending setup run is recorded.
  worktreeHome: { current: "/volli-location-test-home" },
}));
vi.mock("../worktree", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../worktree")>();
  return { ...actual, ensure: ensureWorktree };
});
vi.mock("../worktree-runtime", () => ({
  worktreeDeps: (db: unknown) => ({ db, home: worktreeHome.current }),
}));
// Spied rather than fanned out, so a suite can say which prepares told the
// ticket's surfaces their identity moved.
const dataChanged = vi.fn();
const ports = { events: { publish: dataChanged } };
const options = { dataDir: "/profile" };

import { createSessionLocationResolver } from "./location";
import { listTicketEvents } from "../db/events-repo";
import { markFirstRunPending } from "../worktree/first-run";
import { resetResumeEpochForTest } from "../worktree/resume-exec";
import { startWorktreeSetupAnyway } from "../worktree/setup-gate";
import {
  acquireDeletionLease,
  acquireWorktreeStartLease,
  resetDeletionLeasesForTest,
  UNDER_DELETION_REFUSAL,
} from "../worktree/deletion-lease";

let testDb: TestDb | undefined;
let scratchRoot: string | undefined;

afterEach(() => {
  resetDeletionLeasesForTest();
  testDb?.cleanup();
  testDb = undefined;
  if (scratchRoot !== undefined) rmSync(scratchRoot, { recursive: true, force: true });
  scratchRoot = undefined;
  ensureWorktree.mockReset();
  dataChanged.mockReset();
});

/** A real directory to delete out from under a Session — `reaffirm`'s only input. */
function scratch(): string {
  scratchRoot = mkdtempSync(join(tmpdir(), "volli-location-"));
  return scratchRoot;
}

function ticketSession(projectId: string, ticketId: string): Session {
  return {
    id: "ticket-session",
    projectId,
    ticketId,
    role: "ticket",
    parentSessionId: null,
    title: null,
    createdAt: 0,
  };
}

describe("desktop Session location resolver", () => {
  it("uses the host venue for resolution and preparation", async () => {
    testDb = openTestDb();
    const project = testProject({ id: "p", path: "/repo" });
    insertProject(testDb.db, project);
    const resolver = createSessionLocationResolver(testDb.db, ports, {
      ...options,
      venue: { id: "hostd", kind: "remote" },
    });
    const session = { ...ticketSession("p", "unused"), role: "project" as const, ticketId: null };
    expect(await resolver.resolve(session)).toEqual({
      directory: "/repo",
      venue: { id: "hostd", kind: "remote" },
    });
    expect(await resolver.prepare!(session)).toEqual({
      directory: "/repo",
      venue: { id: "hostd", kind: "remote" },
    });
  });
  it("routes Board Sessions to the Main checkout and ticket Sessions to their worktree", async () => {
    testDb = openTestDb();
    const project = testProject({ id: "project-1", path: "/repo/main" });
    const ticket = testTicket(project.id, {
      id: "ticket-1",
      worktreePath: "/repo/worktree",
    });
    insertProject(testDb.db, project);
    insertTicket(testDb.db, ticket);
    const resolver = createSessionLocationResolver(testDb.db, ports, options);

    await expect(
      resolver.resolve({
        id: "project-session",
        projectId: project.id,
        ticketId: null,
        role: "project",
        parentSessionId: null,
        title: null,
        createdAt: 0,
      }),
    ).resolves.toEqual({ directory: project.path, venue: { id: "local", kind: "local" } });
    await expect(
      resolver.resolve({
        id: "ticket-session",
        projectId: project.id,
        ticketId: ticket.id,
        role: roleImpliedByTicket(ticket.id),
        parentSessionId: null,
        title: null,
        createdAt: 0,
      }),
    ).resolves.toEqual({
      directory: ticket.worktreePath,
      venue: { id: "local", kind: "local" },
    });
  });

  it("falls back to Main without a worktree and rejects stale identity", async () => {
    testDb = openTestDb();
    const project = testProject({ id: "project-1", path: "/repo/main" });
    const ticket = testTicket(project.id, { id: "ticket-1", worktreePath: null });
    const otherProject = testProject({ id: "project-2", path: "/repo/other" });
    const foreignTicket = testTicket(otherProject.id, {
      id: "ticket-2",
      worktreePath: "/repo/other-worktree",
    });
    insertProject(testDb.db, project);
    insertTicket(testDb.db, ticket);
    insertProject(testDb.db, otherProject);
    insertTicket(testDb.db, foreignTicket);
    const resolver = createSessionLocationResolver(testDb.db, ports, options);

    await expect(
      resolver.resolve({
        id: "ticket-session",
        projectId: project.id,
        ticketId: ticket.id,
        role: roleImpliedByTicket(ticket.id),
        parentSessionId: null,
        title: null,
        createdAt: 0,
      }),
    ).resolves.toMatchObject({ directory: project.path });
    await expect(
      resolver.resolve({
        id: "missing-project-session",
        projectId: "missing",
        ticketId: null,
        role: "project",
        parentSessionId: null,
        title: null,
        createdAt: 0,
      }),
    ).rejects.toThrow("Project missing was not found");
    await expect(
      resolver.resolve({
        id: "missing-ticket-session",
        projectId: project.id,
        ticketId: "missing",
        role: "ticket",
        parentSessionId: null,
        title: null,
        createdAt: 0,
      }),
    ).rejects.toThrow("Ticket missing was not found");
    await expect(
      resolver.resolve({
        id: "cross-project-ticket-session",
        projectId: project.id,
        ticketId: foreignTicket.id,
        role: roleImpliedByTicket(foreignTicket.id),
        parentSessionId: null,
        title: null,
        createdAt: 0,
      }),
    ).rejects.toThrow(`Ticket ${foreignTicket.id} was not found in project ${project.id}`);
  });

  // A Board Session has no ticket and therefore no isolated checkout to
  // materialize — it runs in the project root. Pinned because `prepare` is the
  // attach path's only git seam, and a ticketless Session reaching `ensure`
  // would be asking for a worktree for a ticket that does not exist.
  it("prepares a ticketless Session in the project root without touching the worktree pipeline", async () => {
    testDb = openTestDb();
    const project = testProject({ id: "project-1", path: "/repo/main" });
    insertProject(testDb.db, project);
    const resolver = createSessionLocationResolver(testDb.db, ports, options);

    await expect(
      resolver.prepare({
        id: "project-session",
        projectId: project.id,
        ticketId: null,
        role: "project",
        parentSessionId: null,
        title: null,
        createdAt: 0,
      }),
    ).resolves.toEqual({ directory: project.path, venue: { id: "local", kind: "local" } });
    expect(ensureWorktree).not.toHaveBeenCalled();
  });

  it("prepares a ticket that opts out of worktrees in the project root too", async () => {
    testDb = openTestDb();
    const project = testProject({ id: "project-1", path: "/repo/main" });
    const ticket = testTicket(project.id, { id: "ticket-1", usesWorktree: false });
    insertProject(testDb.db, project);
    insertTicket(testDb.db, ticket);
    const resolver = createSessionLocationResolver(testDb.db, ports, options);

    await expect(
      resolver.prepare({
        id: "ticket-session",
        projectId: project.id,
        ticketId: ticket.id,
        role: roleImpliedByTicket(ticket.id),
        parentSessionId: null,
        title: null,
        createdAt: 0,
      }),
    ).resolves.toMatchObject({ directory: project.path });
    expect(ensureWorktree).not.toHaveBeenCalled();
  });

  // The bug this seam exists for: a worktree deleted out from under a Session
  // that is still bound to it. Every prompt afterwards died a second later,
  // inside the harness, on the harness's own name for a missing path.
  it("recreates a bound worktree that was deleted under the Session", async () => {
    testDb = openTestDb();
    const root = scratch();
    const worktreePath = join(root, "VC-3-doing");
    const project = testProject({ id: "project-1", path: join(root, "main") });
    const ticket = testTicket(project.id, { id: "ticket-1", worktreePath });
    insertProject(testDb.db, project);
    insertTicket(testDb.db, ticket);
    const resolver = createSessionLocationResolver(testDb.db, ports, options);
    const session = ticketSession(project.id, ticket.id);

    // Present: the check before a turn is one `existsSync` and no git at all.
    mkdirSync(worktreePath);
    await expect(resolver.reaffirm(session, worktreePath)).resolves.toBeUndefined();
    expect(ensureWorktree).not.toHaveBeenCalled();

    // Gone: `ensure` runs, and reconcile's prune-and-recreate puts the SAME
    // path back from the SAME branch — which is what the stand-in does here.
    rmSync(worktreePath, { recursive: true });
    ensureWorktree.mockImplementation(async () => {
      mkdirSync(worktreePath);
      return {
        ok: true,
        value: {
          identity: { worktreePath, branch: "volli/VC-3-doing", baseBranch: "main" },
          created: true,
          restamped: false,
        },
      };
    });
    await expect(resolver.reaffirm(session, worktreePath)).resolves.toBeUndefined();
    expect(ensureWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ db: testDb.db }),
      ticket.id,
    );
  });

  describe("the project's setup command (VC-835)", () => {
    function setupTicket(setupCommand: string) {
      testDb = openTestDb();
      const root = scratch();
      worktreeHome.current = join(root, "home");
      const worktreePath = join(root, "VC-3-doing");
      mkdirSync(worktreePath);
      const project = testProject({ id: "project-1", path: join(root, "main"), setupCommand });
      const ticket = testTicket(project.id, { id: "ticket-1", worktreePath: null });
      insertProject(testDb.db, project);
      insertTicket(testDb.db, ticket);
      // What `ensure` records before it creates the worktree.
      markFirstRunPending({ home: worktreeHome.current }, worktreePath, ticket.id, ["setup"]);
      ensureWorktree.mockResolvedValue({
        ok: true,
        value: {
          identity: { worktreePath, branch: "volli/VC-3-doing", baseBranch: "main" },
          created: true,
          restamped: true,
          setupPending: true,
        },
      });
      const resolver = createSessionLocationResolver(testDb.db, ports, {
        ...options,
        // A fixed shell, so the suite never runs the developer's own profile.
        setupEnvironment: async () => ({
          shellPath: "/bin/sh",
          env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
        }),
      });
      return { worktreePath, resolver, session: ticketSession(project.id, ticket.id) };
    }

    afterEach(() => {
      worktreeHome.current = "/volli-location-test-home";
    });

    it("holds a second start until the first one's setup finishes, though its ensure no longer sees it owed", async () => {
      const { worktreePath, resolver, session } = setupTicket("sleep 0.3; touch .setup-ran");
      ensureWorktree.mockReset();
      const outcome = (setupPending: boolean) => ({
        ok: true,
        value: {
          identity: { worktreePath, branch: "volli/VC-3-doing", baseBranch: "main" },
          created: setupPending,
          restamped: setupPending,
          setupPending,
        },
      });
      ensureWorktree.mockResolvedValueOnce(outcome(true)).mockResolvedValueOnce(outcome(false));

      const first = resolver.prepare(session);
      // Let the first start claim the run before the second asks.
      await new Promise((resolve) => setTimeout(resolve, 50));
      await resolver.prepare(session);

      expect(existsSync(join(worktreePath, ".setup-ran"))).toBe(true);
      await first;
    });

    it("runs it in a chat's new worktree before the location is handed to the binding", async () => {
      const { worktreePath, resolver, session } = setupTicket("touch .setup-ran");

      await expect(resolver.prepare(session)).resolves.toMatchObject({ directory: worktreePath });

      expect(existsSync(join(worktreePath, ".setup-ran"))).toBe(true);
      // A second Session in the same worktree: setup already ran.
      rmSync(join(worktreePath, ".setup-ran"));
      await expect(resolver.prepare(session)).resolves.toMatchObject({ directory: worktreePath });
      expect(existsSync(join(worktreePath, ".setup-ran"))).toBe(false);
    });

    it("fails the start with the exit code, and the Retry starts without running it again", async () => {
      const { worktreePath, resolver, session } = setupTicket("touch attempt-$$; exit 7");

      await expect(resolver.prepare(session)).rejects.toThrow(
        `Couldn't prepare the worktree at ${worktreePath} — The project's setup command exited with code 7.`,
      );
      expect(
        listTicketEvents(testDb!.db, "ticket-1").find((e) => e.payload.kind === "worktree_failed")
          ?.payload,
      ).toMatchObject({ stage: "setup" });

      await expect(resolver.prepare(session)).resolves.toMatchObject({ directory: worktreePath });
      const attempts = readdirSync(worktreePath).filter((name) => name.startsWith("attempt-"));
      expect(attempts).toHaveLength(1);
    });
  });

  // VC-584: with environment recipes on, the working copy's own
  // .agents/setup runs, a failed one keeps refusing starts until answered,
  // and .agents/resume runs once per runner epoch.
  describe("the environment recipe (VC-584)", () => {
    function recipeTicket(files: { setup?: string; resume?: string }) {
      testDb = openTestDb();
      const root = scratch();
      worktreeHome.current = join(root, "home");
      const worktreePath = join(root, "VC-3-doing");
      mkdirSync(join(worktreePath, ".agents"), { recursive: true });
      for (const [script, body] of Object.entries(files)) {
        writeFileSync(join(worktreePath, ".agents", script), body);
      }
      const project = testProject({
        id: "project-1",
        path: join(root, "main"),
        ticketPrefix: "VC",
      });
      const ticket = testTicket(project.id, {
        id: "ticket-1",
        ticketNumber: 3,
        worktreePath: null,
      });
      insertProject(testDb.db, project);
      insertTicket(testDb.db, ticket);
      markFirstRunPending({ home: worktreeHome.current }, worktreePath, ticket.id, ["setup"]);
      ensureWorktree.mockResolvedValue({
        ok: true,
        value: {
          identity: { worktreePath, branch: "volli/VC-3-doing", baseBranch: "main" },
          created: true,
          restamped: false,
          setupPending: true,
        },
      });
      const resolver = createSessionLocationResolver(testDb.db, ports, {
        ...options,
        setupEnvironment: async () => ({
          shellPath: "/bin/sh",
          env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
        }),
        environmentRecipes: () => true,
        power: { on: () => undefined, removeListener: () => undefined },
      });
      return { worktreePath, resolver, session: ticketSession(project.id, ticket.id) };
    }

    afterEach(() => {
      worktreeHome.current = "/volli-location-test-home";
      resetResumeEpochForTest();
    });

    it("runs .agents/setup then .agents/resume before the binding, telling them the ticket", async () => {
      const { worktreePath, resolver, session } = recipeTicket({
        setup: 'printf "%s" "$VOLLI_TICKET" > setup.txt\n',
        resume: 'printf "%s" "$VOLLI_RESUME_REASON" > resume.txt\n',
      });

      await expect(resolver.prepare(session)).resolves.toMatchObject({ directory: worktreePath });

      expect(readFileSync(join(worktreePath, "setup.txt"), "utf8")).toBe("VC-3");
      expect(readFileSync(join(worktreePath, "resume.txt"), "utf8")).toBe("runner-start");
    });

    it("refuses every start after a failed setup until a person answers it", async () => {
      const { worktreePath, resolver, session } = recipeTicket({ setup: "echo nope\nexit 1\n" });

      await expect(resolver.prepare(session)).rejects.toThrow(
        `Couldn't prepare the worktree at ${worktreePath} — .agents/setup exited with code 1: nope`,
      );
      await expect(resolver.prepare(session)).rejects.toThrow(
        "Environment setup failed: .agents/setup exited with code 1: nope. Retry setup, or start anyway.",
      );

      startWorktreeSetupAnyway({ home: worktreeHome.current }, worktreePath, "ticket-1", 1);
      await expect(resolver.prepare(session)).resolves.toMatchObject({ directory: worktreePath });
    });
  });

  // A reuse that adopted the same-ticket branch actually checked out changed
  // the ticket's recorded Branch without making a worktree; its rail must hear
  // about it the way it hears about a creation, and a reuse that changed
  // nothing must stay quiet.
  it("tells the ticket's surfaces when a reuse restamped its identity, and only then", async () => {
    testDb = openTestDb();
    const root = scratch();
    const worktreePath = join(root, "VC-3-doing");
    mkdirSync(worktreePath);
    const project = testProject({ id: "project-1", path: join(root, "main") });
    const ticket = testTicket(project.id, { id: "ticket-1", worktreePath });
    insertProject(testDb.db, project);
    insertTicket(testDb.db, ticket);
    const resolver = createSessionLocationResolver(testDb.db, ports, options);
    const session = ticketSession(project.id, ticket.id);
    const reuse = (restamped: boolean) => ({
      ok: true,
      value: {
        identity: { worktreePath, branch: "volli/VC-3-narrower", baseBranch: "main" },
        created: false,
        restamped,
      },
    });

    ensureWorktree.mockResolvedValueOnce(reuse(true));
    await expect(resolver.prepare(session)).resolves.toMatchObject({ directory: worktreePath });
    expect(dataChanged).toHaveBeenCalledTimes(1);
    expect(dataChanged).toHaveBeenCalledWith("data-changed", {
      ticketId: ticket.id,
      projectId: project.id,
      kind: "worktree",
    });

    ensureWorktree.mockResolvedValueOnce(reuse(false));
    await expect(resolver.prepare(session)).resolves.toMatchObject({ directory: worktreePath });
    expect(dataChanged).toHaveBeenCalledTimes(1);
  });

  it("names the path when the worktree cannot be put back", async () => {
    testDb = openTestDb();
    const root = scratch();
    const worktreePath = join(root, "VC-3-doing");
    const project = testProject({ id: "project-1", path: join(root, "main") });
    const ticket = testTicket(project.id, { id: "ticket-1", worktreePath });
    insertProject(testDb.db, project);
    insertTicket(testDb.db, ticket);
    const resolver = createSessionLocationResolver(testDb.db, ports, options);
    const session = ticketSession(project.id, ticket.id);

    // `ensure` refused: `prepare`'s own error already names the worktree and
    // carries git's reason, so it is what the user reads.
    ensureWorktree.mockResolvedValue({ ok: false, error: "fatal: invalid reference" });
    await expect(resolver.reaffirm(session, worktreePath)).rejects.toThrow(
      `Couldn't prepare the worktree at ${worktreePath} — fatal: invalid reference`,
    );

    // `ensure` claimed success and the bound directory is still not there —
    // Volli says so rather than handing the adapter a path that isn't real.
    ensureWorktree.mockResolvedValue({
      ok: true,
      value: {
        identity: { worktreePath, branch: "volli/VC-3-doing", baseBranch: "main" },
        created: false,
        restamped: false,
      },
    });
    await expect(resolver.reaffirm(session, worktreePath)).rejects.toThrow(
      `The Session's directory ${worktreePath} is gone and couldn't be recreated.`,
    );
  });

  // A Board Session runs in the project root, which no pipeline materializes.
  it("refuses a project root that is gone instead of pretending it is there", async () => {
    testDb = openTestDb();
    const root = scratch();
    const project = testProject({ id: "project-1", path: join(root, "main") });
    insertProject(testDb.db, project);
    const resolver = createSessionLocationResolver(testDb.db, ports, options);
    const session: Session = {
      id: "project-session",
      projectId: project.id,
      ticketId: null,
      role: "project",
      parentSessionId: null,
      title: null,
      createdAt: 0,
    };

    await expect(resolver.reaffirm(session, project.path)).rejects.toThrow(
      `The Session's directory ${project.path} is gone and couldn't be recreated.`,
    );
    expect(ensureWorktree).not.toHaveBeenCalled();
  });

  // VC-822: removal detaches a project and keeps its Sessions, so nothing may
  // start one there: not a new binding, and not a turn on a binding that
  // outlived the removal. Reading where it ran starts nothing and still works.
  it("refuses to start or reaffirm a Session of a removed project, until it is re-added", async () => {
    testDb = openTestDb();
    const root = scratch();
    const project = testProject({ id: "project-1", path: root });
    insertProject(testDb.db, project);
    const resolver = createSessionLocationResolver(testDb.db, ports, options);
    const session: Session = {
      id: "project-session",
      projectId: project.id,
      ticketId: null,
      role: "project",
      parentSessionId: null,
      title: null,
      createdAt: 0,
    };
    const removed =
      "This Session's project was removed from Volli. Add its folder again to use it.";

    detachProject(testDb.db, project.id, 1);

    await expect(resolver.prepare(session)).rejects.toThrow(removed);
    await expect(resolver.reaffirm(session, root)).rejects.toThrow(removed);
    await expect(resolver.resolve(session)).resolves.toMatchObject({ directory: root });

    reattachProject(testDb.db, project.id, 2);
    await expect(resolver.prepare(session)).resolves.toMatchObject({ directory: root });
    await expect(resolver.reaffirm(session, root)).resolves.toBeUndefined();
  });

  // VC-284. An agent start is the other side of the deletion
  // lease: a Session can still be bound to a directory this app now calls an
  // orphan (deleting a ticket only clears `sessions.ticket_id`), so "an agent is
  // about to work here" and "a cleanup is about to remove here" are two acts
  // over one directory. Both take the lease, so they cannot both proceed.
  describe("against a cleanup that is removing the directory", () => {
    it("refuses to materialize or reaffirm a directory under an active deletion", async () => {
      testDb = openTestDb();
      const root = scratch();
      const worktreePath = join(root, "VC-9-going");
      mkdirSync(worktreePath, { recursive: true });
      const project = testProject({ id: "project-1", path: join(root, "main") });
      const ticket = testTicket(project.id, { id: "ticket-1", worktreePath });
      insertProject(testDb.db, project);
      insertTicket(testDb.db, ticket);
      const resolver = createSessionLocationResolver(testDb.db, ports, options);
      const session = ticketSession(project.id, ticket.id);

      const removing = acquireDeletionLease(worktreePath);
      expect(removing).not.toBeNull();

      // The turn gate — the directory exists, so without the lease this would
      // have returned happily and the agent would have started writing into a
      // checkout being removed.
      await expect(resolver.reaffirm(session, worktreePath)).rejects.toThrow(
        UNDER_DELETION_REFUSAL,
      );
      await expect(resolver.prepare(session)).rejects.toThrow(UNDER_DELETION_REFUSAL);
      expect(ensureWorktree).not.toHaveBeenCalled();

      // Given back, both go through again.
      removing?.release();
      await expect(resolver.reaffirm(session, worktreePath)).resolves.toBeUndefined();
    });

    it("refuses a Board Session's project root under an active deletion", async () => {
      testDb = openTestDb();
      const root = scratch();
      const project = testProject({ id: "project-1", path: root });
      insertProject(testDb.db, project);
      const resolver = createSessionLocationResolver(testDb.db, ports, options);
      const session: Session = {
        id: "project-session",
        projectId: project.id,
        ticketId: null,
        role: "project",
        parentSessionId: null,
        title: null,
        createdAt: 0,
      };

      const removing = acquireDeletionLease(root);
      await expect(resolver.prepare(session)).rejects.toThrow(UNDER_DELETION_REFUSAL);
      removing?.release();
      await expect(resolver.prepare(session)).resolves.toEqual({
        directory: root,
        venue: { id: "local", kind: "local" },
      });
    });

    it("holds the directory while it materializes, so a cleanup cannot take it mid-prepare", async () => {
      testDb = openTestDb();
      const root = scratch();
      const worktreePath = join(root, "VC-10-starting");
      const project = testProject({ id: "project-1", path: join(root, "main") });
      const ticket = testTicket(project.id, { id: "ticket-1", worktreePath });
      insertProject(testDb.db, project);
      insertTicket(testDb.db, ticket);
      const resolver = createSessionLocationResolver(testDb.db, ports, options);
      const session = ticketSession(project.id, ticket.id);

      let leaseDuringEnsure: unknown = "unasked";
      ensureWorktree.mockImplementation(async () => {
        // `ensure` is git work plus a durable event: this is the window a
        // cleanup used to be able to acquire in.
        leaseDuringEnsure = acquireDeletionLease(worktreePath);
        return {
          ok: true,
          value: {
            identity: { worktreePath, branch: "volli/VC-10", baseBranch: "main" },
            created: false,
            restamped: false,
          },
        };
      });
      mkdirSync(worktreePath, { recursive: true });

      await expect(resolver.prepare(session)).resolves.toEqual({
        directory: worktreePath,
        venue: { id: "local", kind: "local" },
      });

      expect(leaseDuringEnsure).toBeNull();
      // And the start gives it back, so the cleanup can have it afterwards.
      const after = acquireDeletionLease(worktreePath);
      expect(after).not.toBeNull();
      after?.release();
    });

    it("lets two starts share a directory — they exclude deletion, not each other", () => {
      const root = scratch();
      const first = acquireWorktreeStartLease(root);
      const second = acquireWorktreeStartLease(join(root, "src"));
      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      // But neither of them may be deleted out from under.
      expect(acquireDeletionLease(root)).toBeNull();
      first?.release();
      second?.release();
      expect(acquireDeletionLease(root)).not.toBeNull();
    });
  });
});
