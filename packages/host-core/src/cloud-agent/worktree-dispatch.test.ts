import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { AgentRequest } from "@volli/shared";
import { createAgentCommandService } from "../agent-commands";
import { createRunnerPathRegistry } from "../cloud-store/paths";
import { insertProject } from "../db/projects-repo";
import { insertTicket } from "../db/tickets-repo";
import { openTestDb, testProject, testSession, testTicket, type TestDb } from "../db/test-helpers";
import { insertSession } from "../session-control/test-support";
import { testHostHandlers } from "../testing/host-handlers";
import { createTestSessionEngine } from "../testing/session-engine";
import type { AgentBackend } from "./agent-backend";
import { CloudFunctionError, CloudOfflineError } from "./functions-client";
import { createCloudWorktreeTickets } from "./worktree-tickets";
import { scanCollisions } from "../worktree/collisions";

const PROJECT = "a0000000-0000-4000-8000-000000000001";
const TICKET = "b0000000-0000-4000-8000-000000000001";
const SECOND = "b0000000-0000-4000-8000-000000000002";
const SESSION = "c0000000-0000-4000-8000-000000000001";
let db: TestDb;
afterEach(() => db?.cleanup());

const request = (
  cmd: AgentRequest["cmd"],
  args: AgentRequest["args"] = {},
  env: AgentRequest["ctx"]["env"] = { session: SESSION, token: "token" },
): AgentRequest => ({ v: 1, cmd, args, ctx: { cwd: "/unrelated", env } });

function world() {
  db = openTestDb();
  const project = testProject({ id: PROJECT, path: "/frozen", ticketPrefix: "OLD" });
  insertProject(db.db, project);
  insertTicket(
    db.db,
    testTicket(PROJECT, {
      id: TICKET,
      worktreePath: "/frozen-copy",
      branch: "frozen",
      baseBranch: "frozen-base",
    }),
  );
  db.db
    .prepare(
      "INSERT INTO cloud_shadow_rows(kind,id,owner_user_id) VALUES ('project',?,'owner'),('ticket',?,'owner')",
    )
    .run(PROJECT, TICKET);
  insertSession(db.db, testSession(PROJECT, TICKET, { id: SESSION }));
  const frozen = db.db.prepare("SELECT * FROM tickets").all();
  const registry = createRunnerPathRegistry(db.db, { runnerId: "runner" });
  registry.checkouts.register({ projectId: PROJECT, projectRepoId: "repo", absPath: "/checkout" });
  for (const [id, number] of [
    [TICKET, 1],
    [SECOND, 2],
  ] as const) {
    registry.workingCopies.register({
      ticketId: id,
      projectRepoId: "repo",
      absPath: `/copies/${number}`,
      branch: `cloud-${number}`,
      baseBranch: "main",
    });
  }
  const tickets: {
    id: string;
    projectId: string;
    number: number;
    status: string;
    archivedAt: number | null;
  }[] = [
    { id: TICKET, projectId: PROJECT, number: 1, status: "doing", archivedAt: null },
    { id: SECOND, projectId: PROJECT, number: 2, status: "todo", archivedAt: null },
  ];
  const cloudProject = { id: PROJECT, name: "Cloud project", ticketPrefix: "AV" };
  let fault: Error | undefined;
  let faultPath: string | undefined;
  let onQuery: ((path: string) => void) | undefined;
  let hasRegistry = true;
  const query = vi.fn(async (_session: string, path: string, args: Record<string, unknown>) => {
    if (fault && (faultPath === undefined || path === faultPath)) throw fault;
    onQuery?.(path);
    if (path === "board:resolveTicketKey") {
      const ticket = tickets.find((t) => `AV-${t.number}` === args["key"]);
      if (!ticket) throw new CloudFunctionError("not_found", "No such key");
      return { ticketId: ticket.id };
    }
    if (path === "board:getTicket") {
      const ticket = tickets.find((t) => t.id === args["ticketId"]);
      if (!ticket) throw new CloudFunctionError("not_found", "No such ticket");
      return { ticket };
    }
    if (path === "projects:get") return cloudProject;
    if (path === "projects:listForActor") return { projects: [cloudProject], current: PROJECT };
    if (path === "board:roster") return { tickets: tickets.filter((t) => t.archivedAt === null) };
    throw new Error(`Unexpected read ${path}`);
  });
  const backend: AgentBackend = {
    query,
    action: async () => {
      throw new Error("no action");
    },
    mutation: async () => {
      throw new Error("no backend write");
    },
    forget() {},
  };
  const cloudWorktreeTickets = createCloudWorktreeTickets({
    backend,
    registry: () => (hasRegistry ? registry : null),
    ticketDisplayIdOf: () => null,
  });
  const gitCalls: { args: readonly string[]; cwd: string }[] = [];
  let checkedOut = "cloud-1";
  const gitAsync = async (raw: readonly string[], cwd: string) => {
    const args = raw[0] === "--no-optional-locks" ? raw.slice(1) : raw;
    gitCalls.push({ args, cwd });
    if (args[0] === "branch") return checkedOut;
    if (args.includes("MERGE_HEAD")) throw new Error("no merge");
    if (args[0] === "rev-parse") return "head\n";
    if (args[0] === "rev-list") return args.includes("--left-right") ? "0\t0\n" : "0\n";
    if (args[0] === "merge-base") return "base\n";
    if (args[0] === "status") return args.includes("--porcelain=v2") ? "? src/shared.ts\0" : "";
    if (args[0] === "diff") return args.includes("--numstat") ? "1\t0\tsrc/shared.ts\0" : "";
    return "";
  };
  const exists = vi.fn(() => true);
  const service = createAgentCommandService({
    db: db.db,
    appVersion: "test",
    sessionEngine: createTestSessionEngine(db.db),
    handlers: testHostHandlers({ db: db.db }),
    verifySessionToken: (t) => (t === "token" ? SESSION : null),
    projects: () => [{ ...project, path: "/checkout" }],
    cloudWorktreeTickets,
    gitAsync,
    worktreeExists: exists,
  });
  return {
    service,
    request,
    query,
    gitCalls,
    exists,
    tickets,
    registry,
    cloudWorktreeTickets,
    frozen,
    fault: (error: Error, path?: string) => {
      fault = error;
      faultPath = path;
    },
    checkedOut: (branch: string) => {
      checkedOut = branch;
    },
    noRegistry: () => {
      hasRegistry = false;
    },
    onQuery: (callback: (path: string) => void) => {
      onQuery = callback;
    },
  };
}

describe("Cloud worktree verbs through the admitted dispatch", () => {
  it("resolves the caller UUID before env/cwd and explicit display selectors before the caller", async () => {
    const w = world();
    expect(
      await w.service.execute(
        w.request("worktree.status", {}, { session: SESSION, token: "token", ticket: "AV-2" }),
      ),
    ).toMatchObject({
      ok: true,
      data: {
        ticket: "AV-1",
        project: "Cloud project",
        worktreePath: "/copies/1",
        branch: "cloud-1",
      },
    });
    expect(w.query.mock.calls.some(([, path]) => path === "board:resolveTicketKey")).toBe(false);
    expect(
      await w.service.execute(w.request("worktree.diff", { id: "AV-2", workingTree: true })),
    ).toMatchObject({ ok: true, data: { ticket: "AV-2", mode: "working-tree", totalFiles: 1 } });
    expect(w.gitCalls.every(({ cwd }) => cwd.startsWith("/copies/"))).toBe(true);
    expect(db.db.prepare("SELECT * FROM tickets").all()).toEqual(w.frozen);
  });

  it("preserves sync branch checks, previews, abort checks and machine-only merges", async () => {
    const w = world();
    w.checkedOut("wrong");
    expect(await w.service.execute(w.request("worktree.sync"))).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST", message: expect.stringContaining("not cloud-1") },
    });
    expect(w.gitCalls.some(({ args }) => args[0] === "merge")).toBe(false);
    w.checkedOut("cloud-1");
    expect(await w.service.execute(w.request("worktree.sync", { dryRun: true }))).toMatchObject({
      ok: true,
      data: { dryRun: true },
    });
    expect(w.gitCalls.some(({ args }) => args[0] === "merge")).toBe(false);
    expect(await w.service.execute(w.request("worktree.sync"))).toMatchObject({
      ok: true,
      data: { ticket: "AV-1", branch: "cloud-1", status: "already-up-to-date" },
    });
    expect(await w.service.execute(w.request("worktree.sync", { abort: true }))).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST" },
    });
    expect(w.gitCalls.some(({ args }) => ["fetch", "pull", "push"].includes(args[0]!))).toBe(false);
    expect(db.db.prepare("SELECT * FROM tickets").all()).toEqual(w.frozen);
  });

  it("scans Cloud scheduling facts against registry copies, not shadow or frozen rosters", async () => {
    const w = world();
    expect(await w.service.execute(w.request("conflicts", { project: "AV" }))).toMatchObject({
      ok: true,
      data: { scanned: 2, overlaps: [{ path: "src/shared.ts", tickets: ["AV-1", "AV-2"] }] },
    });
    w.tickets[1]!.status = "done";
    expect(await w.service.execute(w.request("conflicts"))).toMatchObject({
      ok: true,
      data: { scanned: 1 },
    });
    expect(w.gitCalls.every(({ cwd }) => cwd.startsWith("/copies/"))).toBe(true);
  });

  it("reads archived explicit targets but excludes them from scheduling", async () => {
    const w = world();
    w.tickets[1]!.archivedAt = 10;
    expect(await w.service.execute(w.request("worktree.status", { id: "AV-2" }))).toMatchObject({
      ok: true,
      data: { ticket: "AV-2" },
    });
    expect(await w.service.execute(w.request("conflicts"))).toMatchObject({
      ok: true,
      data: { scanned: 1 },
    });
  });

  it("names missing disk copies and refuses unavailable registries or main-checkout copies", async () => {
    const w = world();
    w.exists.mockReturnValue(false);
    expect(await w.service.execute(w.request("worktree.diff"))).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST", message: expect.stringContaining("missing") },
    });
    expect(await w.service.execute(w.request("conflicts"))).toMatchObject({
      ok: true,
      data: { scanned: 0, skipped: [{ ticket: "AV-1" }, { ticket: "AV-2" }] },
    });
    w.registry.workingCopies.register({
      ticketId: TICKET,
      projectRepoId: "repo",
      absPath: "/checkout",
      kind: "main_checkout",
    });
    expect(await w.service.execute(w.request("worktree.sync"))).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST", message: expect.stringContaining("main checkout") },
    });
    w.noRegistry();
    expect(await w.service.execute(w.request("conflicts"))).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST" },
    });
    expect(await w.service.execute(w.request("worktree.status"))).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST" },
    });
    expect(w.gitCalls).toEqual([]);
  });

  it.each(["worktree.status", "worktree.diff", "worktree.sync", "conflicts"] as const)(
    "%s fails typed without git when Cloud identity reads are offline or forbidden",
    async (cmd) => {
      const w = world();
      w.fault(
        new CloudOfflineError("link_down", "offline", "not_sent"),
        cmd === "conflicts" ? "board:roster" : undefined,
      );
      expect(await w.service.execute(w.request(cmd))).toMatchObject({
        ok: false,
        error: { code: "OFFLINE" },
      });
      w.fault(
        new CloudFunctionError("forbidden", "access lost"),
        cmd === "conflicts" ? "board:roster" : undefined,
      );
      expect(await w.service.execute(w.request(cmd))).toMatchObject({
        ok: false,
        error: { code: "FORBIDDEN_ACTOR" },
      });
      expect(w.gitCalls).toEqual([]);
    },
  );

  it("distinguishes missing projects from missing tickets, without scanning", async () => {
    const w = world();
    w.fault(new CloudFunctionError("not_found", "Project absent"), "board:roster");
    expect(await w.service.execute(w.request("conflicts"))).toMatchObject({
      ok: false,
      error: { code: "PROJECT_NOT_FOUND" },
    });
    w.fault(new CloudFunctionError("not_found", "Project absent"), "projects:get");
    expect(await w.service.execute(w.request("worktree.status"))).toMatchObject({
      ok: false,
      error: { code: "PROJECT_NOT_FOUND" },
    });
    w.fault(new CloudFunctionError("not_found", "Ticket absent"), "board:getTicket");
    expect(await w.service.execute(w.request("worktree.status"))).toMatchObject({
      ok: false,
      error: { code: "TICKET_NOT_FOUND" },
    });
    expect(w.gitCalls).toEqual([]);
  });

  it("refuses explicitly when the registry disappears while reading the roster", async () => {
    const w = world();
    w.onQuery((path) => {
      if (path === "board:roster") w.noRegistry();
    });
    expect(await w.service.execute(w.request("conflicts"))).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST" },
    });
    expect(w.gitCalls).toEqual([]);
  });

  it("names copies lost after the roster read and copies beyond the shared command deadline", async () => {
    const w = world();
    const scope = await w.cloudWorktreeTickets.roster({
      sessionId: SESSION,
      request: w.request("conflicts"),
    });
    expect(scope.ok).toBe(true);
    if (!scope.ok) return;
    const deps = {
      db: db.db,
      tickets: scope.tickets,
      machinePaths: w.cloudWorktreeTickets.machinePaths,
      gitAsync: async () => {
        throw new Error("must not run git");
      },
    };
    const expired = await scanCollisions({ ...deps, deadline: Date.now() - 1 }, scope.projects);
    expect(expired.worktrees).toEqual([]);
    expect(expired.skipped).toHaveLength(2);
    w.noRegistry();
    const lost = await scanCollisions(deps, scope.projects);
    expect(lost.worktrees).toEqual([]);
    expect(lost.skipped).toEqual([
      { ticket: "AV-1", reason: expect.stringContaining("no longer available") },
      { ticket: "AV-2", reason: expect.stringContaining("no longer available") },
    ]);
  });

  it("does not borrow a claimed Session's Agent token, including read-only scans", async () => {
    const w = world();
    for (const cmd of ["worktree.status", "worktree.diff", "worktree.sync", "conflicts"] as const) {
      expect(
        await w.service.execute(w.request(cmd, { id: "AV-1" }, { session: SESSION })),
      ).toMatchObject({
        ok: false,
        error: { code: cmd === "worktree.sync" ? "FORBIDDEN_ACTOR" : "SIGN_IN_REQUIRED" },
      });
    }
    expect(w.query).not.toHaveBeenCalled();
    expect(w.gitCalls).toEqual([]);
  });
});
