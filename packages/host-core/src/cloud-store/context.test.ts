import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { LOCAL_RUNNER } from "@volli/shared";
import { openTestDb, testProject, testTicket, type TestDb } from "../db/test-helpers";
import { insertProject, listProjects } from "../db/projects-repo";
import { insertTicket, listTicketsByProject } from "../db/tickets-repo";
import { createTestSessionEngine } from "../testing/session-engine";
import { createCloudContext, type CloudRunnerContext } from "./context";
import { createRunnerPathRegistry } from "./paths";
import type { CloudLocationRequest } from "./location";

let opened: TestDb | undefined;
afterEach(() => {
  opened?.cleanup();
  opened = undefined;
});
const provenance = {
  source: { kind: "system", id: "test", detail: null },
  venue: LOCAL_RUNNER,
} as const;

function fixture() {
  opened = openTestDb();
  const { db } = opened;
  const engine = createTestSessionEngine(db);
  const registry = createRunnerPathRegistry(db, { runnerId: "runner-a" });
  const facts: CloudRunnerContext = {
    sessionId: "s",
    ownerUserId: "a",
    project: { id: "p", name: "Cloud project name" },
    ticketPrefix: "VC",
    primaryRepo: { id: "repo", projectId: "p", baseBranch: "main" },
    ticket: {
      id: "t",
      projectId: "p",
      number: 42,
      title: "Cloud ticket title",
      checkoutMode: "worktree",
      branch: "volli/VC-42-cloud",
      baseBranch: "main",
      retentionKeep: false,
      status: "doing",
    },
    body: "Private cloud prose, not a board cache",
  };
  const query = vi.fn(async (input: CloudLocationRequest): Promise<CloudRunnerContext> => ({
    ...facts,
    sessionId: input.sessionId,
  }));
  const makeContext = () =>
    createCloudContext({ db, ownerUserId: "a", engine, registry: () => registry, query });
  const context = makeContext();
  const birth = async (sessionId = "s") => {
    await context.beforeCreate({ projectId: "p", ticketId: "t", requestedSessionId: sessionId });
    return (
      await engine.createSession({
        commandId: `birth-${sessionId}`,
        requestedSessionId: sessionId,
        projectId: "p",
        ticketId: "t",
        role: "ticket",
        parentSessionId: null,
        title: null,
        provenance,
        onCreated: context.created,
      })
    ).session;
  };
  return { db, engine, registry, facts, query, context, makeContext, birth };
}

function chooseFolder(f: ReturnType<typeof fixture>) {
  f.registry.checkouts.register({
    projectId: "p",
    projectRepoId: "repo",
    absPath: "/repo/cloud-context-test",
  });
}

describe("cloud runner context", () => {
  it("keeps offline birth durable and refuses only the new ticket's first attach", async () => {
    const f = fixture();
    chooseFolder(f);
    f.query.mockRejectedValueOnce(
      new Error("Volli Cloud is unreachable; this ticket's brief can't be read."),
    );
    const session = await f.birth();
    expect(f.query).not.toHaveBeenCalled();
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 1 });
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM cloud_shadow_rows").get()).toEqual({ n: 2 });
    await expect(f.context.brief(session)).rejects.toThrow("Volli Cloud is unreachable");
    expect(await f.context.brief(session)).toContain("VC-42");
    expect(f.query).toHaveBeenCalledTimes(2);
  });

  it("keeps an unlocated identity inert until first attach chooses a registered folder", async () => {
    const f = fixture();
    const session = await f.birth();
    expect(f.query).not.toHaveBeenCalled();
    await expect(f.context.brief(session)).rejects.toThrow(
      "Choose the folder for Cloud project name on this Mac.",
    );
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 1 });
    chooseFolder(f);
    expect(await f.context.brief(session)).toContain("VC-42");
    expect(f.query).toHaveBeenCalledTimes(1);
  });

  it.each(["owner", "project", "ticket", "repo"] as const)(
    "rejects mismatched %s on first attach without mirroring any cloud prose",
    async (mismatch) => {
      const f = fixture();
      chooseFolder(f);
      const session = await f.birth();
      if (mismatch === "owner") f.facts.ownerUserId = "b";
      if (mismatch === "project") f.facts.project = { ...f.facts.project, id: "other-project" };
      if (mismatch === "ticket") f.facts.ticket = { ...f.facts.ticket!, id: "other-ticket" };
      if (mismatch === "repo")
        f.facts.primaryRepo = { ...f.facts.primaryRepo, projectId: "other-project" };
      await expect(f.context.brief(session)).rejects.toThrow("another owner's Session context");
      expect(f.db.prepare("SELECT body FROM tickets WHERE id='t'").get()).toEqual({ body: "" });
    },
  );

  it("stores only machine hints and hidden FK identities; prose exists only in the brief", async () => {
    const f = fixture();
    chooseFolder(f);
    const session = await f.birth();
    const brief = await f.context.brief(session);
    expect(f.context.ticketDisplayIdOf("t")).toBe("VC-42");
    expect(brief).toContain(f.facts.ticket!.title);
    expect(brief).toContain(f.facts.body);
    expect(brief).toContain("VC-42");
    expect(f.query).toHaveBeenCalledTimes(1);
    expect(f.db.prepare("SELECT name,path FROM projects WHERE id='p'").get()).toEqual({
      name: "Volli Cloud project",
      path: "/repo/cloud-context-test",
    });
    expect(f.db.prepare("SELECT title,body,status FROM tickets WHERE id='t'").get()).toEqual({
      title: "Volli Cloud ticket",
      body: "",
      status: "backlog",
    });
    expect(listProjects(f.db)).toEqual([]);
    expect(listTicketsByProject(f.db, "p")).toEqual([]);
    const hints = f.db
      .prepare("SELECT key,value FROM app_state WHERE key LIKE 'volli:runner-site:%'")
      .all();
    expect(hints).toEqual([{ key: "volli:runner-site:a:s", value: expect.any(String) }]);
    const serialized = JSON.stringify(hints);
    expect(serialized).not.toContain(f.facts.body);
    expect(serialized).not.toContain(f.facts.ticket!.title);
    expect(serialized).not.toContain(f.facts.project.name);
    expect(serialized).not.toContain("retentionKeep");
    expect(serialized).not.toContain("status");
  });

  it("uses durable site hints after recreation while housekeeping reads current board facts", async () => {
    const f = fixture();
    chooseFolder(f);
    const born = await f.birth();
    await f.context.brief(born);
    const recreated = f.makeContext();
    f.query.mockRejectedValue(new Error("offline"));
    const input = { sessionId: "s", projectId: "p", ticketId: "t" };
    expect(await recreated.site(input)).toMatchObject({
      primaryRepo: { id: "repo" },
      ticket: { number: 42, branch: "volli/VC-42-cloud", baseBranch: "main" },
    });
    expect(f.query).toHaveBeenCalledTimes(1);
    await expect(recreated.currentSite(input)).rejects.toThrow("offline");
    expect(f.query).toHaveBeenCalledTimes(2);
    f.query.mockResolvedValue({
      ...f.facts,
      ticket: { ...f.facts.ticket!, retentionKeep: true, status: "done" },
    });
    expect(await recreated.currentSite(input)).toMatchObject({
      ticket: { retentionKeep: true, status: "done" },
    });
    await expect(recreated.site({ ...input, ticketId: "other" })).rejects.toThrow(
      "runner-local location is corrupt",
    );
  });

  it("inherits a parent's prepared identity for delegation and skips reads for a requested-id replay", async () => {
    const f = fixture();
    chooseFolder(f);
    const parent = await f.birth();
    await f.context.brief(parent);
    f.query.mockRejectedValue(new Error("offline"));
    await f.context.beforeCreate({
      projectId: "p",
      ticketId: "t",
      parentSessionId: parent.id,
      requestedSessionId: "child",
    });
    const child = (
      await f.engine.createSession({
        commandId: "child-birth",
        requestedSessionId: "child",
        projectId: "p",
        ticketId: "t",
        role: "subagent",
        parentSessionId: parent.id,
        title: null,
        provenance,
        onCreated: f.context.created,
      })
    ).session;
    expect(await f.context.brief(child)).toContain("This is a Subagent Session");
    const recreated = f.makeContext();
    await recreated.beforeCreate({ projectId: "p", ticketId: "t", requestedSessionId: parent.id });
    // Even a cold child can inherit its parent's machine hints, without board prose.
    await recreated.beforeCreate({
      projectId: "p",
      ticketId: "t",
      parentSessionId: parent.id,
      requestedSessionId: "cold-child",
    });
    expect(f.query).toHaveBeenCalledTimes(1);
  });
});

it("allocates machine shadow numbers without colliding with diverged frozen display numbers", async () => {
  const f = fixture();
  chooseFolder(f);
  insertProject(
    f.db,
    testProject({ id: "p", path: "/repo/cloud-context-test", ticketPrefix: "VC" }),
  );
  insertTicket(
    f.db,
    testTicket("p", { id: "local-ticket", ticketNumber: 42, title: "Local board item" }),
  );
  const frozen = f.db.prepare("SELECT * FROM tickets WHERE id='local-ticket'").get();
  const session = await f.birth();
  expect(f.db.prepare("SELECT ticket_number FROM tickets WHERE id='t'").get()).toEqual({
    ticket_number: -1,
  });
  expect(await f.context.brief(session)).toContain("VC-42");
  expect(f.context.ticketDisplayIdOf("t")).toBe("VC-42");
  expect(f.makeContext().ticketDisplayIdOf("t")).toBe("VC-42");
  expect(f.db.prepare("SELECT * FROM tickets WHERE id='local-ticket'").get()).toEqual(frozen);
});
