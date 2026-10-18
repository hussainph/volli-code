/**
 * VC-659, end to end below the tool door: a Ticket Session started on a ticket
 * whose worktree was left on another branch. The real start operation, the
 * real Sessions facade, the real Session Runtime, the real location resolver
 * and the real `ensure` pipeline against a real repository — only the executor
 * is a stand-in, since what is under test is whether it is ever reached.
 *
 * VC-627's follow-up Sessions failed four times as a bare "needs recovery"
 * because its worktree sat on the stacked branch `volli/VC-627c-…` its
 * previous Session had cut. That branch is the ticket's own work and must be
 * attached on; a branch that is not the ticket's must refuse with a reason the
 * starting caller can act on.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createInMemorySessionLedger,
  createInMemoryTranscriptArtifactStore,
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

/**
 * VC-627 as it was found: its worktree materialized on the ticket's branch,
 * then moved by the previous Session onto `checkout`, with one commit there.
 */
function ticketLeftOn(checkout: string) {
  ctx = openTestDb();
  const projectPath = tempDir("stacked-repo");
  git(projectPath, ["init", "-b", "main"]);
  writeFileSync(join(projectPath, "README.md"), "# repo\n");
  git(projectPath, ["add", "README.md"]);
  git(projectPath, ["commit", "-m", "initial"]);
  const worktreePath = join(tempDir("stacked-home"), "VC-627-hostd-venue");
  git(projectPath, ["worktree", "add", "-b", TICKET_BRANCH, worktreePath, "main"]);
  git(worktreePath, ["switch", "-c", checkout]);
  writeFileSync(join(worktreePath, "venue.txt"), "stacked slice\n");
  git(worktreePath, ["add", "venue.txt"]);
  git(worktreePath, ["commit", "-m", "stacked slice"]);

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
    executor,
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
    readModelAnchor: async () => ({ selection: MODEL, tier: null }),
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
  const kickoffs: { sessionId: string; text: string }[] = [];
  const kickoffSent = Promise.withResolvers<void>();
  const db = ctx.db;
  const start = () =>
    startSessionOperation(
      {
        db,
        projects: [project],
        sessions,
        submitSessionMessage: async (input) => {
          kickoffs.push({ sessionId: input.sessionId, text: input.text });
          kickoffSent.resolve();
        },
        now,
      },
      {
        operationId: "caller:tc-1",
        project,
        ticket,
        message: "Continue the stacked venue work",
        actor: { kind: "session", sessionId: "caller", ticketId: null },
      },
      { defaultKickoff: DEFAULT_KICKOFF_MESSAGE, autoTitle: autoTitleFromKickoff },
    );
  return { worktreePath, executor, kickoffs, kickoffSent: kickoffSent.promise, start };
}

describe("starting a Session on a ticket whose worktree is on another branch (VC-659)", () => {
  it("attaches on a stacked branch of the same ticket and submits the kickoff", async () => {
    const stacked = "volli/VC-627c-hostd-stable-venue";
    const world = ticketLeftOn(stacked);

    const started = await world.start();
    await world.kickoffSent;

    expect(started).toMatchObject({ ticketDisplayId: "VC-627", state: "ready" });
    // The executor runs in the ticket's worktree, which was left exactly where
    // the previous Session put it: adopted, never switched.
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
    // Nothing ran, nothing was sent, and the checkout was not touched.
    expect(world.executor.directories).toEqual([]);
    expect(world.kickoffs).toEqual([]);
    expect(git(world.worktreePath, ["branch", "--show-current"])).toBe(
      "volli/VC-6270-someone-elses",
    );
    expect(getTicketRow(ctx!.db, "ticket-1")?.branch).toBe(TICKET_BRANCH);
  });
});
