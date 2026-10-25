/**
 * The socket dispatch with a cloud board composed (VC-894): a `cloud-board`
 * verb reaches the cloud verb after the same identity and admission as
 * today, acting for the Session the door VERIFIED; every other verb, and a
 * dispatch with no cloud board, is untouched.
 */
import { afterEach, describe, expect, it } from "vite-plus/test";

import { AGENT_COMMAND_BINDINGS, type AgentRequest, type AgentResponse } from "@volli/shared";

import { createAgentCommandService } from "../agent-commands";
import { insertProject } from "../db/projects-repo";
import { listTicketsByProject } from "../db/tickets-repo";
import { openTestDb, testProject, testSession, type TestDb } from "../db/test-helpers";
import { insertSession } from "../session-control/test-support";
import { createSessionTokenRegistry } from "../session-tokens";
import { testHostHandlers } from "../testing/host-handlers";
import { createTestSessionEngine } from "../testing/session-engine";
import { cloudBoardVerbOf, type CloudBoardVerbs, type CloudVerbCall } from "./board-verbs";
import { agentDoorKeyOf, CLOUD_AGENT_ROUTES, type CloudBoardKey } from "./routes";

const SESSION = "5eeded00-0000-4000-8000-0000000000aa";

let ctx: TestDb;
afterEach(() => ctx.cleanup());

function world(cloud: boolean) {
  ctx = openTestDb();
  const project = testProject({
    id: "project-1",
    name: "Volli Code",
    path: "/repo",
    ticketPrefix: "VC",
  });
  insertProject(ctx.db, project);
  insertSession(ctx.db, testSession(project.id, null, { id: SESSION, cwd: "/repo" }));
  const tokens = createSessionTokenRegistry();
  const token = tokens.mint({ sessionId: SESSION, attachmentId: "attachment" });
  const calls: { key: CloudBoardKey; call: CloudVerbCall }[] = [];
  const verbs = Object.fromEntries(
    (Object.keys(CLOUD_AGENT_ROUTES) as (keyof typeof CLOUD_AGENT_ROUTES)[])
      .filter((key) => CLOUD_AGENT_ROUTES[key].route === "cloud-board")
      .map((key) => [
        key,
        async (call: CloudVerbCall): Promise<AgentResponse> => {
          calls.push({ key: key as CloudBoardKey, call });
          return { v: 1, ok: true, data: { from: "cloud" } };
        },
      ]),
  ) as unknown as CloudBoardVerbs;
  const service = createAgentCommandService({
    db: ctx.db,
    appVersion: "1.2.3",
    handlers: testHostHandlers({ db: ctx.db }),
    sessionEngine: createTestSessionEngine(ctx.db),
    verifySessionToken: tokens.verify,
    ...(cloud ? { cloudBoardVerbs: verbs } : {}),
  });
  const asSession: AgentRequest["ctx"]["env"] = { session: SESSION, token };
  return { service, calls, asSession, projectId: project.id };
}

function request(
  cmd: AgentRequest["cmd"],
  args: Record<string, unknown>,
  env: AgentRequest["ctx"]["env"] = {},
): AgentRequest {
  return { v: 1, cmd, args, ctx: { cwd: "/repo", env } };
}

describe("the dispatch's cloud board", () => {
  it("sends a board write to the cloud as the verified Session, and writes nothing here", async () => {
    const { service, calls, asSession, projectId } = world(true);
    const create = request("ticket.create", { title: "Cloud ticket" }, asSession);
    await expect(service.execute(create)).resolves.toEqual({
      v: 1,
      ok: true,
      data: { from: "cloud" },
    });
    expect(calls).toEqual([
      { key: "board.createTicket", call: { sessionId: SESSION, request: create } },
    ]);
    expect(listTicketsByProject(ctx.db, projectId)).toEqual([]);

    await service.execute(request("ticket.comment", { id: "VC-1", message: "x" }, asSession));
    await service.execute(request("label.merge", { from: "a", into: "b" }, asSession));
    expect(calls.map(({ key }) => key)).toEqual([
      "board.createTicket",
      "board.createComment",
      "label.merge",
    ]);
  });

  it("a read with no Session evidence reaches the cloud verb with no Session, to refuse", async () => {
    const { service, calls } = world(true);
    await service.execute(request("board", {}));
    expect(calls).toEqual([
      { key: "board", call: { sessionId: null, request: request("board", {}) } },
    ]);
    // A claimed Session without its token is not that Session.
    await service.execute(request("ticket.list", {}, { session: SESSION }));
    expect(calls[1]!.call.sessionId).toBeNull();
  });

  it("admission still judges first: an unauthenticated write is refused before the cloud", async () => {
    const { service, calls } = world(true);
    await expect(service.execute(request("ticket.create", { title: "x" }))).resolves.toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN_ACTOR" },
    });
    expect(calls).toEqual([]);
  });

  it("machine and Session verbs are not the cloud board's", async () => {
    const { service, calls, asSession } = world(true);
    await service.execute(request("identify", {}, asSession));
    await service.execute(request("session.list", {}, asSession));
    expect(calls).toEqual([]);
  });

  it("with no cloud board composed, the board is this host's", async () => {
    const { service, calls, asSession, projectId } = world(false);
    await expect(
      service.execute(request("ticket.create", { title: "Local ticket" }, asSession)),
    ).resolves.toMatchObject({ ok: true, data: { ticket: { id: "VC-1", title: "Local ticket" } } });
    expect(calls).toEqual([]);
    expect(listTicketsByProject(ctx.db, projectId)).toHaveLength(1);
  });
});

const verb = async (): Promise<AgentResponse> => ({ v: 1, ok: true, data: null });

describe("cloudBoardVerbOf", () => {
  it("answers nothing for any verb without a cloud board, and only cloud-board verbs with one", () => {
    const verbs = new Proxy({}, { get: () => verb }) as CloudBoardVerbs;
    for (const binding of Object.values(AGENT_COMMAND_BINDINGS)) {
      expect(cloudBoardVerbOf(undefined, binding)).toBeNull();
      const routed = CLOUD_AGENT_ROUTES[agentDoorKeyOf(binding)].route === "cloud-board";
      expect(cloudBoardVerbOf(verbs, binding)).toBe(routed ? verb : null);
    }
  });
});
