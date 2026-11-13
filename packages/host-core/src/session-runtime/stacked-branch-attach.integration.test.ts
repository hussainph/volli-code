/**
 * VC-659, end to end below the tool door: a Ticket Session started on a ticket
 * whose worktree was left on another branch. The real start operation, the
 * real Sessions facade, the real Session Runtime, the real location resolver
 * and the real `ensure` pipeline against a real repository — only the executor
 * is a stand-in, since what is under test is whether it is ever reached.
 *
 * A ticket's worktree on a stacked-PR branch of the same ticket
 * (`volli/VC-627c-…`) is the ticket's own work: the start attaches there and
 * submits its kickoff. A branch that is not the ticket's refuses, and the
 * start's result carries a reason naming the branch, the uncommitted work and
 * the branch the ticket expects (VC-659).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSessionExecutorSlot,
  createSessionEngine,
  createSessionRuntime,
  type BindingHandle,
  type NativeHarnessAdapter,
} from "@volli/session-engine";
import { autoTitleFromKickoff, DEFAULT_KICKOFF_MESSAGE, type ModelSelection } from "@volli/shared";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { insertProject } from "../db/projects-repo";
import { openTestDb, testProject, testTicket, type TestDb } from "../db/test-helpers";
import { getTicketRow, insertTicket } from "../db/tickets-repo";
import { resetDeletionLeasesForTest } from "../worktree/deletion-lease";
import { resetPhasesForTest } from "../worktree/phase";
import { createSessionLocationResolver } from "./location";
import { createSessions } from "./sessions";
import { startSessionOperation } from "./start-session";
import {
  createInMemorySessionLedger,
  createInMemoryTranscriptArtifactStore,
} from "@volli/session-engine/testing";

const MODEL: ModelSelection = {
  providerId: "openai-codex",
  modelId: "gpt-5.6-sol",
  reasoningLevel: "high",
};
const TICKET_BRANCH = "volli/VC-627-hostd-venue";

let ctx: TestDb | undefined;
let dirs: string[] = [];

afterEach(() => {
  ctx?.cleanup();
  ctx = undefined;
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
  resetPhasesForTest();
  resetDeletionLeasesForTest();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `volli-${prefix}-`));
  dirs.push(dir);
  return dir;
}

/** Real git, identity pinned so a bare CI checkout can commit. */
function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Volli Test",
      GIT_AUTHOR_EMAIL: "test@volli.local",
      GIT_COMMITTER_NAME: "Volli Test",
      GIT_COMMITTER_EMAIL: "test@volli.local",
    },
  }).trim();
}

/** An executor that attaches anywhere and remembers where it was asked to. */
class Executor implements NativeHarnessAdapter {
  readonly id = "pi";
  readonly durableIdNamespace = "pi";
  readonly adapterVersion = "1.0.0";
  readonly runtime = { path: "/pi", version: "1.0.0", fingerprint: "sha256:pi" };
  readonly directories: string[] = [];

  async attach(spec: Parameters<NativeHarnessAdapter["attach"]>[0]): Promise<BindingHandle> {
    this.directories.push(spec.directory);
    return {
      native: { id: "native-1", detail: null },
      dispatch: async (command) => ({
        commandId: command.commandId,
        status: "accepted" as const,
        acceptedAt: 1,
        native: { id: command.commandId, detail: null },
      }),
      reconcile: async () => ({ cursor: null, observations: [], receipts: [] }),
      acknowledgeReconciliation: async () => undefined,
      release: async () => undefined,
    };
  }
}

/** Moves a worktree onto `checkout`, with one commit there. */
function switchWorktree(worktreePath: string, checkout: string): void {
  git(worktreePath, ["switch", "-c", checkout]);
  writeFileSync(join(worktreePath, "venue.txt"), "stacked slice\n");
  git(worktreePath, ["add", "venue.txt"]);
  git(worktreePath, ["commit", "-m", "stacked slice"]);
}

/**
 * A VC-627 ticket whose worktree was materialized on the ticket's branch and
 * then moved onto `checkout`, with one commit there. No `checkout` leaves it on
 * the ticket's own branch, for a test to move later.
 */
function ticketLeftOn(checkout?: string) {
  ctx = openTestDb();
  const projectPath = tempDir("stacked-repo");
  git(projectPath, ["init", "-b", "main"]);
  writeFileSync(join(projectPath, "README.md"), "# repo\n");
  git(projectPath, ["add", "README.md"]);
  git(projectPath, ["commit", "-m", "initial"]);
  const worktreePath = join(tempDir("stacked-home"), "VC-627-hostd-venue");
  git(projectPath, ["worktree", "add", "-b", TICKET_BRANCH, worktreePath, "main"]);
  if (checkout !== undefined) switchWorktree(worktreePath, checkout);

  const project = testProject({
    id: "project-1",
    path: projectPath,
    ticketPrefix: "VC",
    baseBranch: "main",
  });
  const ticket = testTicket(project.id, {
    id: "ticket-1",
    ticketNumber: 627,
    title: "Hostd venue",
    usesWorktree: true,
    worktreePath,
    branch: TICKET_BRANCH,
    baseBranch: "main",
  });
  insertProject(ctx.db, project);
  insertTicket(ctx.db, ticket);

  let clock = 100;
  const now = () => clock++;
  const executor = new Executor();
  const runtime = createSessionRuntime({
    engine: createSessionEngine({
      ledger: createInMemorySessionLedger(),
      clock: { now },
      ids: { next: (kind) => `${kind}-${now()}` },
    }),
    executors: createSessionExecutorSlot(executor),
    artifacts: createInMemoryTranscriptArtifactStore(),
    locations: createSessionLocationResolver(
      ctx.db,
      { events: { publish: () => undefined } },
      { dataDir: tempDir("stacked-data") },
    ),
    clock: { now },
    ids: { next: (kind) => `runtime-${kind}-${now()}` },
  });
  const sessions = createSessions({
    runtime,
    readDefaultModel: async () => MODEL,
    // No anchor: a subagent then runs on the default, like its parent, and
    // model inheritance is not what this suite is about.
    readModelAnchor: async () => ({ selection: null, tier: null }),
    ticketBelongsToProject: () => true,
    skills: { resolve: async () => [], index: async () => null, record: async () => undefined },
    toolSurface: {
      resolve: () => ["read", "edit", "write", "execute"],
      recorded: async () => null,
      record: async () => undefined,
    },
    grants: {
      resolveBirth: () => ({ grants: [], delegation: null, parentSessionId: null }),
      recordBirth: () => undefined,
    },
  });
  const kickoffs: { sessionId: string; text: string; delivery?: "queue" }[] = [];
  const kickoffSent = Promise.withResolvers<void>();
  const db = ctx.db;
  const start = (operationId = "caller:tc-1") =>
    startSessionOperation(
      {
        db,
        projects: [project],
        sessions,
        submitSessionMessage: async (input) => {
          kickoffs.push({
            sessionId: input.sessionId,
            text: input.text,
            ...(input.delivery === undefined ? {} : { delivery: input.delivery }),
          });
          kickoffSent.resolve();
        },
        now,
      },
      {
        operationId,
        project,
        ticket,
        message: "Continue the stacked venue work",
        actor: { kind: "session", sessionId: "caller", ticketId: null },
      },
      { defaultKickoff: DEFAULT_KICKOFF_MESSAGE, autoTitle: autoTitleFromKickoff },
    );
  /** What `session_delegate` mints: a Subagent Session of `parentSessionId`, on its Ticket. */
  const delegate = (parentSessionId: string) =>
    sessions.start({
      operationId: `${parentSessionId}:tc-delegate`,
      projectId: project.id,
      ticketId: ticket.id,
      role: "subagent",
      parentSessionId,
      title: "Review the venue diff",
      actor: { kind: "session", sessionId: parentSessionId, ticketId: ticket.id },
    });
  return {
    worktreePath,
    executor,
    kickoffs,
    kickoffSent: kickoffSent.promise,
    start,
    delegate,
    runtime,
  };
}

describe("starting a Session on a ticket whose worktree is on another branch (VC-659)", () => {
  it("attaches on a stacked branch of the same ticket and submits the kickoff", async () => {
    const stacked = "volli/VC-627c-hostd-stable-venue";
    const world = ticketLeftOn(stacked);

    const started = await world.start();
    await world.kickoffSent;

    expect(started).toMatchObject({ ticketDisplayId: "VC-627", state: "ready" });
    // The executor runs in the ticket's worktree, on the branch it was found
    // on: adopted, never switched.
    expect(world.executor.directories).toEqual([world.worktreePath]);
    expect(git(world.worktreePath, ["branch", "--show-current"])).toBe(stacked);
    expect(getTicketRow(ctx!.db, "ticket-1")?.branch).toBe(stacked);
    expect(world.kickoffs).toEqual([
      { sessionId: started.sessionId, text: "Continue the stacked venue work" },
    ]);
  });

  it("refuses another ticket's dirty branch with a reason the caller can act on", async () => {
    const world = ticketLeftOn("volli/VC-6270-someone-elses");
    writeFileSync(join(world.worktreePath, "venue.txt"), "edited, not committed\n");

    const started = await world.start();

    expect(started.state).toBe("needs-recovery");
    if (started.state !== "needs-recovery") throw new Error("attached");
    expect(started.attachFailure).toBe(
      `Couldn't prepare the worktree at ${world.worktreePath} — A worktree already exists at ` +
        `${world.worktreePath} on branch volli/VC-6270-someone-elses with uncommitted changes; ` +
        `this ticket's branch is ${TICKET_BRANCH}. Commit or stash those changes, check out ` +
        `${TICKET_BRANCH} there (or remove the worktree), then retry.`,
    );
    // Nothing ran and the checkout was not touched; the kickoff is held in the
    // Session's queue for the Retry (VC-799), not sent.
    expect(world.executor.directories).toEqual([]);
    expect(started.kickoff).toBe("held");
    expect(world.kickoffs).toEqual([
      { sessionId: started.sessionId, text: "Continue the stacked venue work", delivery: "queue" },
    ]);
    expect(git(world.worktreePath, ["branch", "--show-current"])).toBe(
      "volli/VC-6270-someone-elses",
    );
    expect(getTicketRow(ctx!.db, "ticket-1")?.branch).toBe(TICKET_BRANCH);
  });
});

describe("a subagent runs where its parent runs (VC-1015)", () => {
  const elsewhere = "volli/VC-6270-someone-elses";

  /** A Ticket Session bound to its worktree, which it then moves to another ticket's branch. */
  async function parentThatSwitched() {
    const world = ticketLeftOn();
    const parent = await world.start();
    await world.kickoffSent;
    expect(parent.state).toBe("ready");
    switchWorktree(world.worktreePath, elsewhere);
    writeFileSync(join(world.worktreePath, "venue.txt"), "edited, not committed\n");
    return { world, parent };
  }

  it("attaches a subagent in its parent's directory on the branch checked out there", async () => {
    const { world, parent } = await parentThatSwitched();

    const child = await world.delegate(parent.sessionId);

    expect(child.state).toBe("ready");
    // The parent's own directory, as it stands: not re-prepared, not switched.
    expect(world.executor.directories).toEqual([world.worktreePath, world.worktreePath]);
    expect(git(world.worktreePath, ["branch", "--show-current"])).toBe(elsewhere);
    expect(getTicketRow(ctx!.db, "ticket-1")?.branch).toBe(TICKET_BRANCH);
  });

  it("still refuses an ordinary Ticket Session there, with the reason on its receipt", async () => {
    const { world } = await parentThatSwitched();

    const started = await world.start("caller:tc-2");

    expect(started.state).toBe("needs-recovery");
    if (started.state !== "needs-recovery") throw new Error("attached");
    expect(started.attachFailure).toContain(`on branch ${elsewhere} with uncommitted changes`);
    expect(started.attachFailure).toContain(`this ticket's branch is ${TICKET_BRANCH}`);
    // The Session's Attention keeps the kind every build clears on attach,
    // and carries the same reason for the app to show.
    const { projection } = await world.runtime.projection({ sessionId: started.sessionId });
    expect(projection.attention.active).toEqual([
      expect.objectContaining({
        kind: "configuration_invalid",
        detail: started.attachFailure,
      }),
    ]);
    expect(world.executor.directories).toEqual([world.worktreePath]);
  });

  it("takes the ordinary preparation when the parent's directory is gone", async () => {
    const world = ticketLeftOn();
    const parent = await world.start();
    await world.kickoffSent;
    rmSync(world.worktreePath, { recursive: true, force: true });

    const child = await world.delegate(parent.sessionId);

    // What the parent's own next turn would do: the Ticket's worktree is made
    // again at the same path, on the Ticket's branch, and the child runs there.
    expect(child.state).toBe("ready");
    expect(world.executor.directories).toEqual([world.worktreePath, world.worktreePath]);
    expect(git(world.worktreePath, ["branch", "--show-current"])).toBe(TICKET_BRANCH);
  });
});
