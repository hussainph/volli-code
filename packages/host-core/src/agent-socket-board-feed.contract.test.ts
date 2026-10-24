/**
 * The agent socket's ticket writes on the Workspace change feed (VC-794).
 *
 * `volli ticket create`, `update` and `comment` are projections of the
 * board's own handlers, so what they commit reaches a Client the way a
 * person's edit does: as the committed row, inlined on the feed, never as a
 * rowless "re-read this" stamp. One real host handler map over a test
 * database, with a real board change feed that the map's commands stamp and
 * the host's event bus feeds through `noteDataChanged` (as main and hostd
 * wire it), served on the real agent socket to a real authenticated Session.
 * Each write is receipted under a command id the door minted for it.
 */
import { connect } from "node:net";
import { dirname, join } from "node:path";

import type Database from "better-sqlite3";
import type { AgentRequest, AgentResponse, BoardChange, DataChangeScope } from "@volli/shared";
import { afterEach, expect, it } from "vite-plus/test";

import { createAgentCommandService } from "./agent-commands";
import { startAgentSocket, type AgentSocketServer } from "./agent-socket";
import { createBoardChangeFeed, type BoardFeedBatch } from "./board/change-feed";
import { listComments } from "./db/comments-repo";
import { insertProject } from "./db/projects-repo";
import { openTestDb, testProject, testSession, type TestDb } from "./db/test-helpers";
import { getTicket, getTicketRow, listTicketsByProject } from "./db/tickets-repo";
import { insertSession } from "./session-control/test-support";
import { createSessionTokenRegistry } from "./session-tokens";
import { testHostHandlers } from "./testing/host-handlers";
import { createTestSessionEngine } from "./testing/session-engine";

const PROJECT = "project-one";
const SESSION = "abcdef12-3456-7890-abcd-ef1234567890";

let ctx: TestDb | undefined;
let server: AgentSocketServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
  ctx?.cleanup();
  ctx = undefined;
});

function roundTrip(socketPath: string, request: AgentRequest): Promise<AgentResponse> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let response = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.end(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk: string) => {
      response += chunk;
    });
    socket.on("error", reject);
    socket.on("end", () => {
      try {
        resolve(JSON.parse(response.trim()) as AgentResponse);
      } catch (error) {
        reject(error);
      }
    });
  });
}

/** Every board command receipt the host recorded. */
function receipts(db: Database.Database): { command_id: string; operation: string }[] {
  return db
    .prepare("SELECT command_id, operation FROM board_command_receipts ORDER BY rowid")
    .all() as { command_id: string; operation: string }[];
}

/** A host as main and hostd compose one, serving its agent socket to one Session. */
async function openHost() {
  const db = (ctx = openTestDb()).db;
  insertProject(db, testProject({ id: PROJECT, path: "/repo/volli", ticketPrefix: "VC" }));
  insertSession(db, testSession(PROJECT, null, { id: SESSION, cwd: "/repo/volli" }));
  const feed = createBoardChangeFeed({
    projectOfTicket: (ticketId) => getTicketRow(db, ticketId)?.project_id,
    workspaces: () => [PROJECT],
  });
  // Every `data-changed` the host's bus carries taps the feed, as each host
  // wires it: a writer that stamped no rows is stamped rowless here.
  const tapped: DataChangeScope[] = [];
  const dataChanged = (scope: DataChangeScope) => {
    tapped.push(scope);
    feed.noteDataChanged(scope);
  };
  let clock = 1_000;
  const now = () => (clock += 1);
  const handlers = testHostHandlers({ db, now, boardFeed: feed, onMutation: dataChanged });
  const tokens = createSessionTokenRegistry();
  const service = createAgentCommandService({
    handlers,
    db,
    sessionEngine: createTestSessionEngine(db),
    appVersion: "1.2.3",
    now,
    // The same bus: a verb with no map entry still announces through it.
    onMutation: dataChanged,
    verifySessionToken: tokens.verify,
  });
  const socketPath = join(dirname(ctx.dbPath), "volli.sock");
  server = await startAgentSocket({ socketPath, execute: (request) => service.execute(request) });
  const env = { session: SESSION, token: tokens.mint({ sessionId: SESSION, attachmentId: "a-1" }) };
  // A Client following the Workspace from a snapshot read now.
  const batches: BoardFeedBatch[] = [];
  feed.subscribe(PROJECT, null, (batch) => batches.push(batch));
  const take = (): BoardChange[] => batches.splice(0).flatMap((batch) => batch.changes);
  const run = async (cmd: AgentRequest["cmd"], args: Record<string, unknown>) => {
    const response = await roundTrip(socketPath, {
      v: 1,
      cmd,
      args,
      ctx: { cwd: "/repo/volli", env },
    });
    expect(response, cmd).toMatchObject({ ok: true });
    return response as { ok: true; data: Record<string, unknown> };
  };
  return { db, tapped, take, run };
}

it("stamps a socket create, update and comment with the rows they committed, none rowless", async () => {
  const { db, tapped, take, run } = await openHost();

  // `volli ticket create`: the ticket's row (without its body), its labels and its history.
  await run("ticket.create", { title: "From an agent", body: "Its body.", labels: ["api"] });
  const [created] = listTicketsByProject(db, PROJECT);
  const { body: _body, ...summary } = created!;
  const onCreate = take();
  // The door minted the write's command id: its receipt, and every row it stamped, name it.
  const createId = onCreate[0]!.commandId!;
  expect(receipts(db)).toEqual([{ command_id: createId, operation: "board.createTicket" }]);
  expect(onCreate).toEqual([
    {
      kind: "label",
      op: "upsert",
      id: expect.any(String),
      projectId: PROJECT,
      label: expect.objectContaining({ name: "api" }),
      commandId: createId,
    },
    {
      kind: "ticket",
      op: "upsert",
      id: created!.id,
      projectId: PROJECT,
      ticket: summary,
      commandId: createId,
    },
    {
      kind: "ticketEvent",
      op: "upsert",
      id: created!.id,
      projectId: PROJECT,
      ticketId: created!.id,
      commandId: createId,
    },
  ]);

  // `volli ticket update --append … --priority … --label …`: one command, one row.
  await run("ticket.update", {
    id: "VC-1",
    bodyMutation: { mode: "append", text: "More." },
    priority: "high",
    addLabels: ["ui"],
  });
  const updated = getTicket(db, created!.id)!;
  expect(updated).toMatchObject({ body: "Its body.\n\nMore.", priority: "high" });
  const { body: _updatedBody, ...updatedSummary } = updated;
  const onUpdate = take();
  const updateId = onUpdate[0]!.commandId!;
  expect(updateId).not.toBe(createId);
  expect(onUpdate.every((change) => change.commandId === updateId)).toBe(true);
  expect(onUpdate.filter(({ kind }) => kind === "ticket")).toEqual([
    {
      kind: "ticket",
      op: "upsert",
      id: created!.id,
      projectId: PROJECT,
      ticket: updatedSummary,
      commandId: updateId,
    },
  ]);
  expect(onUpdate.filter(({ kind }) => kind === "label")).toHaveLength(2);

  // `volli ticket comment`: the comment's row, authored by the Session, and its ticket's history.
  await run("ticket.comment", { id: "VC-1", message: "Working on it" });
  const [comment] = listComments(db, created!.id);
  expect(comment).toMatchObject({ actor: "session", sessionId: SESSION, body: "Working on it" });
  const onComment = take();
  const commentId = onComment[0]!.commandId!;
  expect(onComment).toEqual([
    {
      kind: "comment",
      op: "upsert",
      id: comment!.id,
      projectId: PROJECT,
      ticketId: created!.id,
      comment,
      commandId: commentId,
    },
    {
      kind: "ticketEvent",
      op: "upsert",
      id: created!.id,
      projectId: PROJECT,
      ticketId: created!.id,
      commandId: commentId,
    },
  ]);
  expect(receipts(db)).toEqual(
    expect.arrayContaining([
      { command_id: updateId, operation: "board.updateTicket" },
      { command_id: commentId, operation: "board.createComment" },
    ]),
  );
  expect(receipts(db)).toHaveLength(3);

  // The flag-off windows still heard each write once, and the tap stamped none of them.
  expect(tapped).toEqual([
    { ticketId: created!.id, projectId: PROJECT, kind: "ticket" },
    { ticketId: created!.id, projectId: PROJECT, kind: "ticket" },
    { ticketId: created!.id, projectId: PROJECT, kind: "comment" },
  ]);
});

it("still stamps a writer with no map entry rowless: `volli ticket signal`", async () => {
  const { take, run } = await openHost();
  await run("ticket.create", { title: "Signalled" });
  take();
  await run("ticket.signal", { id: "VC-1", kind: "implement", verdict: "pass" });
  expect(take()).toEqual([
    { kind: "ticket", op: "upsert", id: expect.any(String), projectId: PROJECT },
  ]);
});
