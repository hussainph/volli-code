import { createWorkspacesRouter } from "./workspaces-router";
/**
 * The board router (VC-565) through the real catalog builders, driven with a
 * handler map that records what reaches it: who is admitted, which Workspace
 * check runs before the handler, what a write must carry and answer, how
 * `board.changes` maps the host's feed onto tracked frames, and what the
 * board publishes. The transport is `board-contract.test.ts`'s; the host's
 * handlers are host-core's.
 */
import { tracked, type TRPCError } from "@trpc/server";
import { HOST_FEATURE_OPERATIONS } from "@volli/host-protocol";
import {
  BOARD_CHANGE_KINDS,
  BOARD_ENTRIES,
  COMMAND_INTENT_CONFLICT,
  FEED_RESNAPSHOT_REQUIRED,
  FeedResnapshotRequiredError,
  OperationUnavailableError,
  type ArchivedTicket,
  type BoardChange,
  type HandlerCall,
  type Label,
  type LatestSessionSignal,
  type Project,
  type Ticket,
  type TicketComment,
  type TicketEvent,
  type TicketStatusEntry,
} from "@volli/shared";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import {
  boardProcedureSchemas,
  COMMENT_RESOURCE,
  createBoardRouter,
  LABEL_RESOURCE,
  TICKET_RESOURCE,
  type BoardFeedEmission,
} from "./board-router";
import { boardChangeSchema, receiptSchema } from "./board-schema";
import {
  catalogErrorFormatter,
  hostErrorOf,
  LOCAL_DESKTOP_CALLER,
  PROJECT_RESOURCE,
  WORKSPACE_UNKNOWN_MESSAGE,
  type RouterCaller,
  type RouterTransport,
  type WorkspaceResource,
} from "./catalog";
import { createHostRouter } from "./host-router";
import { createSessionRouter, RpcDiagnosticLog } from "./index";
import { SESSION_RESOURCE } from "./session-catalog";

const WORKSPACE = "9f6a2d4e-0b7c-4c1e-8a35-2f6d9e0c7b14";
const OTHER = "1b2c3d4e-5f60-4718-9a2b-3c4d5e6f7081";
const ABSENT = "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a";
const DEVICE = "3c1d8e2a-6f4b-4a9e-b7d0-1e5c9a2f8b36";
const COMMAND = "0f8fad5b-d9cb-469f-a165-70867728950e";

const device: RouterCaller = {
  actor: { kind: "device", deviceId: DEVICE, workspaceId: WORKSPACE },
  current: () => true,
};
const agent: RouterCaller = {
  actor: { kind: "session", sessionId: "session-1", workspaceId: WORKSPACE },
  current: () => true,
};
const PERSON: HandlerCall = { actor: { kind: "user" } };

type BoardPath = (typeof BOARD_ENTRIES)[number]["key"];
const PATHS = BOARD_ENTRIES.map((entry) => entry.key) as BoardPath[];
/** The writes that carry a `commandId`: `board.write` less the column-only `ticket.move`. */
const COMMAND_PATHS = HOST_FEATURE_OPERATIONS["board.write"].filter(
  (path) => path !== "ticket.move",
);
const UNARY_PATHS = PATHS.filter((path) => path !== "board.changes");

// ---------------------------------------------------------------- fixtures

const project: Project = {
  id: WORKSPACE,
  name: "Board",
  path: "/work/board",
  ticketPrefix: "VC",
  baseBranch: "main",
  setupCommand: "pnpm install",
  themeOverride: { terminalThemeName: "Dracula" },
  themeCanvas: null,
  themeAppearance: "dark",
  skillModes: { "code-review": "manual", deploy: "off" },
  sessionModel: { providerId: "anthropic", modelId: "model-a", reasoningLevel: "high" },
  decisionModel: { kind: "none" },
  authorityPolicy: { budgets: {} } as Project["authorityPolicy"],
  colorIndex: 3,
  sortOrder: 1,
  createdAt: 10,
  updatedAt: 20,
};
const ticket: Ticket = {
  id: "ticket-1",
  projectId: WORKSPACE,
  ticketNumber: 1,
  title: "First",
  body: "The body, which a roster never carries.",
  status: "todo",
  priority: "high",
  labels: ["ui"],
  usesWorktree: true,
  preferredHarnessId: "claude-code",
  order: 0,
  worktreePath: "/work/board/.worktrees/vc-1",
  branch: "volli/VC-1-first",
  baseBranch: "main",
  prUrl: null,
  createdAt: 30,
  updatedAt: 40,
};
const { body: _body, ...summary } = ticket;
const second: Ticket = { ...ticket, id: "ticket-2", ticketNumber: 2, order: 1 };
const archived: ArchivedTicket = { ...ticket, id: "ticket-9", archivedAt: 50 };
const label: Label = { id: "label-1", projectId: WORKSPACE, name: "ui", color: "#123456" };
const comment: TicketComment = {
  id: "comment-1",
  ticketId: "ticket-1",
  sessionId: null,
  actor: "user",
  body: "Looks right.",
  createdAt: 60,
  updatedAt: 60,
};
const event: TicketEvent = {
  id: "event-1",
  ticketId: "ticket-1",
  actor: "session",
  actorContext: { sessionId: "session-1", ticketId: "ticket-1" },
  createdAt: 70,
  payload: { kind: "labels_changed", added: ["ui"], removed: [] },
};
const signal: LatestSessionSignal = {
  ticketId: "ticket-1",
  sessionId: "session-1",
  signal: "blocked",
  reason: "Needs a key",
  createdAt: 80,
};
const entry: TicketStatusEntry = { ticketId: "ticket-1", status: "todo", enteredAt: 30 };
const receipt = { commandId: COMMAND, status: "completed" as const, replayed: false };
/** A write's answer besides its row: its receipt and the feed cursor it is stamped through. */
const written = { receipt, throughCursor: "0:feed:1" };

interface Names {
  projectId: string;
  ticketId: string;
  commentId: string;
  labelId: string;
  sessionId: string;
}
const OWNED: Names = {
  projectId: WORKSPACE,
  ticketId: "ticket-1",
  commentId: "comment-1",
  labelId: "label-1",
  sessionId: "session-1",
};
const FOREIGN: Names = {
  projectId: OTHER,
  ticketId: "ticket-x",
  commentId: "comment-x",
  labelId: "label-x",
  sessionId: "session-x",
};
const MISSING: Names = {
  projectId: ABSENT,
  ticketId: "ticket-gone",
  commentId: "comment-gone",
  labelId: "label-gone",
  sessionId: "session-gone",
};

/** Where each resource the context's port answers lives; anything else is absent. */
const WORKSPACE_OF: Readonly<Record<string, string>> = {
  [`${TICKET_RESOURCE}:ticket-1`]: WORKSPACE,
  [`${TICKET_RESOURCE}:ticket-2`]: WORKSPACE,
  [`${COMMENT_RESOURCE}:comment-1`]: WORKSPACE,
  [`${LABEL_RESOURCE}:label-1`]: WORKSPACE,
  [`${TICKET_RESOURCE}:ticket-x`]: OTHER,
  [`${COMMENT_RESOURCE}:comment-x`]: OTHER,
  [`${LABEL_RESOURCE}:label-x`]: OTHER,
  [`${SESSION_RESOURCE}:session-1`]: WORKSPACE,
  [`${SESSION_RESOURCE}:session-x`]: OTHER,
};

/** One valid input per board path, naming `names`' resources. */
function inputs({
  projectId,
  ticketId,
  commentId,
  labelId,
  sessionId,
}: Names): Record<BoardPath, unknown> {
  return {
    "ticket.move": { projectId, ticketId, toStatus: "done" },
    "board.snapshot": { projectId },
    "board.roster": { projectId },
    "board.changes": { projectId },
    "board.projectFolder": { projectId },
    "board.ticketBody": { ticketId },
    "board.archivedTickets": { projectId },
    "board.ticketEvents": { ticketId },
    "board.latestSignals": { projectId },
    "board.statusEntries": { projectId },
    "board.comments": { ticketId },
    "board.updateProject": { commandId: COMMAND, projectId, baseBranch: "trunk" },
    "board.setSkillModes": { commandId: COMMAND, projectId, modes: { deploy: "auto" } },
    "board.setSessionDefaults": { commandId: COMMAND, projectId, model: null },
    "board.createTicket": { commandId: COMMAND, projectId, status: "todo", title: "New" },
    "board.moveTickets": {
      commandId: COMMAND,
      projectId,
      ticketIds: [ticketId],
      toStatus: "done",
      toIndex: 0,
    },
    "board.setPriority": { commandId: COMMAND, ticketId, priority: "low" },
    "board.updateTicket": { commandId: COMMAND, ticketId, title: "Renamed" },
    "board.setLabels": { commandId: COMMAND, ticketId, labels: ["ui"] },
    "board.archiveTicket": { commandId: COMMAND, ticketId },
    "board.unarchiveTicket": { commandId: COMMAND, ticketId },
    "board.deleteTicket": { commandId: COMMAND, ticketId },
    "board.createComment": { commandId: COMMAND, ticketId, body: "Hi", sessionId },
    "board.updateComment": { commandId: COMMAND, commentId, body: "Edited" },
    "board.removeComment": { commandId: COMMAND, commentId },
    "board.setLabelColor": { commandId: COMMAND, labelId, color: null },
  };
}

/** What each handler answers, and what the router answers for it. */
const ANSWERS: Record<Exclude<BoardPath, "board.changes">, { handler: unknown; wire: unknown }> = {
  "ticket.move": {
    handler: [second, { ...ticket, status: "done", order: 4 }],
    wire: { ticket: { id: "ticket-1", status: "done", order: 4 } },
  },
  "board.snapshot": same({ project, tickets: [ticket], labels: [label], cursor: "c-1" }),
  "board.roster": same({ tickets: [summary], labels: [label], cursor: "c-1" }),
  "board.projectFolder": same({ path: "/work/board", state: "missing" }),
  "board.ticketBody": same({ body: ticket.body }),
  "board.archivedTickets": same([archived]),
  "board.ticketEvents": same([event]),
  "board.latestSignals": same([signal]),
  "board.statusEntries": same([entry]),
  "board.comments": same([comment]),
  "board.updateProject": same({ ...written, project }),
  "board.setSkillModes": same({ ...written, project }),
  "board.setSessionDefaults": same({ ...written, project }),
  "board.createTicket": same({ ...written, ticket }),
  "board.moveTickets": {
    handler: { ...written, tickets: [ticket] },
    wire: { ...written, tickets: [summary] },
  },
  "board.setPriority": same({ ...written, ticket }),
  "board.updateTicket": same({ ...written, ticket }),
  "board.setLabels": same({ ...written, ticket }),
  "board.archiveTicket": same({ ...written }),
  "board.unarchiveTicket": same({ ...written, ticket }),
  "board.deleteTicket": same({ ...written }),
  "board.createComment": same({ ...written, comment }),
  "board.updateComment": same({ ...written, comment }),
  "board.removeComment": same({ ...written }),
  "board.setLabelColor": same({ ...written, label }),
};

function same(value: unknown) {
  return { handler: value, wire: value };
}

/** Every property name ending `Id`/`Ids` anywhere in a JSON schema. */
function idFieldsOf(schema: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(schema)) {
    for (const item of schema) idFieldsOf(item, into);
  } else if (schema !== null && typeof schema === "object") {
    for (const [key, value] of Object.entries(schema)) {
      if (key === "properties") {
        for (const field of Object.keys(value as object)) {
          if (/Ids?$/.test(field)) into.add(field);
        }
      }
      idFieldsOf(value, into);
    }
  }
  return into;
}

// ------------------------------------------------------------------ harness

type Handler = (input: never, call: HandlerCall, sink: never) => unknown;

interface BoardHarness {
  caller: ReturnType<ReturnType<typeof createBoardRouter>["createCaller"]>;
  calls: { key: string; input: unknown; call: HandlerCall }[];
  asked: WorkspaceResource[];
}

/** The board router over a map that records every call and answers from `answers`. */
function boardHarness(
  options: {
    caller?: RouterCaller;
    answers?: Partial<Record<string, Handler>>;
    transport?: RouterTransport;
    port?: boolean;
    signal?: AbortSignal;
  } = {},
): BoardHarness {
  const calls: BoardHarness["calls"] = [];
  const asked: WorkspaceResource[] = [];
  const answers = options.answers ?? {};
  const handlers = new Proxy(
    {},
    {
      get(_target, key: string) {
        return (input: never, call: HandlerCall, sink: never) => {
          calls.push({ key, input, call });
          const answer = answers[key];
          if (answer === undefined) throw new Error(`No answer for ${key}`);
          return answer(input, call, sink);
        };
      },
    },
  );
  const caller = createBoardRouter().createCaller(
    {
      caller: options.caller ?? device,
      diagnostics: new RpcDiagnosticLog(),
      handlers: handlers as never,
      ...(options.transport === undefined ? {} : { transport: options.transport }),
      ...(options.port === false
        ? {}
        : {
            resourceWorkspace: (resource: WorkspaceResource) => {
              asked.push(resource);
              return WORKSPACE_OF[`${resource.kind}:${resource.id}`] ?? null;
            },
          }),
    },
    options.signal === undefined ? undefined : { signal: options.signal },
  );
  return { caller, calls, asked };
}

const cannedAnswers = (): Partial<Record<string, Handler>> =>
  Object.fromEntries(
    Object.entries(ANSWERS).map(([key, { handler }]) => [key, () => structuredClone(handler)]),
  );

type Procedure = (input?: unknown) => Promise<unknown>;

function procedureAt(caller: object, path: string): Procedure {
  const [namespace, name] = path.split(".") as [string, string];
  return (caller as Record<string, Record<string, Procedure>>)[namespace]![name]!;
}

/** Opens a call (and a stream's first read), and answers the error it ended with. */
async function refusal(
  procedure: (input: never) => Promise<unknown>,
  input: unknown,
): Promise<TRPCError> {
  try {
    const result = await procedure(input as never);
    if (result !== null && typeof result === "object" && Symbol.asyncIterator in result) {
      const iterator = (result as AsyncIterable<unknown>)[Symbol.asyncIterator]();
      try {
        await iterator.next();
      } finally {
        await iterator.return?.();
      }
    }
  } catch (error) {
    return error as TRPCError;
  }
  throw new Error("Expected a refusal, and the call answered");
}

const reasonOf = (error: unknown) => ({ ...hostErrorOf(error) });

// ------------------------------------------------------------------- cases

describe("a paired device in its own Workspace", () => {
  it.each(UNARY_PATHS)("%s reaches its own handler as the person's, and answers", async (path) => {
    const board = boardHarness({ answers: cannedAnswers() });
    const input = inputs(OWNED)[path];
    const answer = await procedureAt(board.caller, path)(input);
    expect(answer).toStrictEqual(ANSWERS[path as keyof typeof ANSWERS].wire);
    expect(board.calls).toHaveLength(1);
    expect(board.calls[0]).toMatchObject({ key: path, call: PERSON });
  });

  it("refuses a credential that is no longer current, before anything else", async () => {
    const board = boardHarness({
      caller: { ...device, current: () => false },
      answers: cannedAnswers(),
    });
    expect(
      reasonOf(await refusal(board.caller.board.snapshot, { projectId: WORKSPACE })),
    ).toMatchObject({ code: "UNAUTHORIZED", reason: "credential-invalid" });
    expect([...board.calls, ...board.asked]).toEqual([]);
  });
});

describe("another Workspace's board answers exactly as an absent one", () => {
  it.each(PATHS)(
    "%s refuses foreign and absent resources alike, before the handler",
    async (path) => {
      const board = boardHarness({ answers: cannedAnswers() });
      const procedure = procedureAt(board.caller, path);
      const foreign = reasonOf(await refusal(procedure, inputs(FOREIGN)[path]));
      const absent = reasonOf(await refusal(procedure, inputs(MISSING)[path]));
      expect(foreign).toEqual({
        code: "NOT_FOUND",
        reason: "workspace-unknown",
        message: WORKSPACE_UNKNOWN_MESSAGE,
      });
      expect(absent).toEqual(foreign);
      expect(board.calls).toEqual([]);
    },
  );

  it("asks the context's port for a ticket, a comment and a label, and answers a project itself", async () => {
    const board = boardHarness({ answers: cannedAnswers() });
    await refusal(board.caller.board.ticketBody, { ticketId: "ticket-x" });
    await refusal(board.caller.board.removeComment, { commandId: COMMAND, commentId: "comment-x" });
    await refusal(board.caller.board.setLabelColor, {
      commandId: COMMAND,
      labelId: "label-x",
      color: null,
    });
    await refusal(board.caller.board.snapshot, { projectId: OTHER });
    expect(board.asked).toEqual([
      { kind: TICKET_RESOURCE, id: "ticket-x" },
      { kind: COMMENT_RESOURCE, id: "comment-x" },
      { kind: LABEL_RESOURCE, id: "label-x" },
    ]);
    expect(board.calls).toEqual([]);
  });

  it("checks the board a move lands on, and every ticket it moves", async () => {
    const board = boardHarness({ answers: cannedAnswers() });
    // The ticket is this Workspace's; the board it names is not.
    expect(
      reasonOf(
        await refusal(board.caller.ticket.move, {
          projectId: OTHER,
          ticketId: "ticket-1",
          toStatus: "done",
        }),
      ),
    ).toMatchObject({ reason: "workspace-unknown" });
    // One foreign ticket among the selection refuses the whole move.
    expect(
      reasonOf(
        await refusal(board.caller.board.moveTickets, {
          ...(inputs(OWNED)["board.moveTickets"] as object),
          ticketIds: ["ticket-1", "ticket-x"],
        }),
      ),
    ).toMatchObject({ reason: "workspace-unknown" });
    expect(board.calls).toEqual([]);
  });

  /**
   * Every id an input names, by field: the resource the router authorizes it
   * as, or why it is none. A new id field fails here until it is classified,
   * so no operation can grow an unauthorized reference unnoticed.
   */
  const ID_FIELDS: Record<string, string | null> = {
    projectId: PROJECT_RESOURCE,
    ticketId: TICKET_RESOURCE,
    ticketIds: TICKET_RESOURCE,
    commentId: COMMENT_RESOURCE,
    labelId: LABEL_RESOURCE,
    sessionId: SESSION_RESOURCE,
    // The Client's idempotency key, scoped by the receipt's Workspace.
    commandId: null,
    // An Option-drag's pick: the host looks it up only among the Automations
    // of the board the move lands on, so a foreign id picks nothing.
    automationId: null,
    // The feed's own cursor, minted for this Workspace's feed and refused
    // (resnapshot) from any other.
    lastEventId: null,
    // Host-wide catalogs (models, harnesses), not anything a Workspace owns.
    providerId: null,
    modelId: null,
    preferredHarnessId: null,
  };

  it("classifies every id every board input names", () => {
    const unclassified = Object.entries(boardProcedureSchemas()).flatMap(([path, schema]) =>
      [...idFieldsOf(z.toJSONSchema(schema.input, { io: "input" }))]
        .filter((field) => !(field in ID_FIELDS))
        .map((field) => `${path}.${field}`),
    );
    expect(unclassified).toEqual([]);
  });

  it.each(
    PATHS.flatMap((path) =>
      Object.keys(inputs(OWNED)[path] as object)
        .filter((field) => ID_FIELDS[field] !== null && field in ID_FIELDS)
        .map((field) => [path, field] as const),
    ),
  )("%s refuses a foreign or absent %s, even beside resources it owns", async (path, field) => {
    const board = boardHarness({ answers: cannedAnswers() });
    const procedure = procedureAt(board.caller, path);
    const naming = (names: Names) => {
      const named = names[(field === "ticketIds" ? "ticketId" : field) as keyof Names];
      return {
        ...(inputs(OWNED)[path] as object),
        [field]: field === "ticketIds" ? [named] : named,
      };
    };
    const foreign = reasonOf(await refusal(procedure, naming(FOREIGN)));
    expect(foreign).toEqual({
      code: "NOT_FOUND",
      reason: "workspace-unknown",
      message: WORKSPACE_UNKNOWN_MESSAGE,
    });
    expect(reasonOf(await refusal(procedure, naming(MISSING)))).toEqual(foreign);
    expect(board.calls).toEqual([]);
  });

  it("asks for the Session a comment links to as a reference, and serves it in the Workspace", async () => {
    const board = boardHarness({ answers: cannedAnswers() });
    await board.caller.board.createComment(inputs(OWNED)["board.createComment"] as never);
    expect(board.asked).toEqual([
      { kind: TICKET_RESOURCE, id: "ticket-1" },
      { kind: SESSION_RESOURCE, id: "session-1", relation: "reference" },
    ]);
    // No Session named, nothing more to ask.
    board.asked.length = 0;
    for (const sessionId of [null, undefined]) {
      await board.caller.board.createComment({
        commandId: COMMAND,
        ticketId: "ticket-1",
        body: "Hi",
        ...(sessionId === undefined ? {} : { sessionId }),
      });
    }
    expect(board.asked).toEqual([
      { kind: TICKET_RESOURCE, id: "ticket-1" },
      { kind: TICKET_RESOURCE, id: "ticket-1" },
    ]);
    expect(board.calls).toHaveLength(3);
  });

  it("refuses every ticket, comment and label without a port, and still serves its board", async () => {
    const board = boardHarness({ answers: cannedAnswers(), port: false });
    for (const path of ["board.ticketBody", "board.updateComment", "board.setLabelColor"]) {
      expect(
        reasonOf(await refusal(procedureAt(board.caller, path), inputs(OWNED)[path as BoardPath])),
      ).toMatchObject({ code: "NOT_FOUND", reason: "workspace-unknown" });
    }
    await expect(board.caller.board.roster({ projectId: WORKSPACE })).resolves.toBeDefined();
    expect(board.calls.map(({ key }) => key)).toEqual(["board.roster"]);
  });
});

describe("a Session", () => {
  it.each(PATHS)("is refused %s: the board router's actor is the person", async (path) => {
    const board = boardHarness({ caller: agent, answers: cannedAnswers() });
    const procedure = procedureAt(board.caller, path);
    for (const input of [inputs(OWNED)[path], { malformed: true }]) {
      expect(reasonOf(await refusal(procedure, input))).toMatchObject({
        code: "FORBIDDEN",
        reason: "verb-refused",
      });
    }
    // Refused at admission: no resource was resolved, no handler reached.
    expect([...board.calls, ...board.asked]).toEqual([]);
  });
});

describe("a board write's commandId", () => {
  it.each(COMMAND_PATHS)("%s refuses a missing or non-UUID commandId", async (path) => {
    const board = boardHarness({ answers: cannedAnswers() });
    const { commandId: _commandId, ...rest } = inputs(OWNED)[path] as { commandId: string };
    for (const input of [rest, { ...rest, commandId: "command-1" }]) {
      expect(reasonOf(await refusal(procedureAt(board.caller, path), input))).toMatchObject({
        code: "BAD_REQUEST",
      });
    }
    expect(board.calls).toEqual([]);
  });

  it.each(COMMAND_PATHS)(
    "%s answers a reused id's other intent CONFLICT / command-conflict",
    async (path) => {
      const conflict = Object.assign(new Error(`Command ${COMMAND} carries another intent`), {
        [COMMAND_INTENT_CONFLICT]: true as const,
      });
      const board = boardHarness({
        answers: {
          [path]: () => {
            throw conflict;
          },
        },
      });
      expect(reasonOf(await refusal(procedureAt(board.caller, path), inputs(OWNED)[path]))).toEqual(
        {
          code: "CONFLICT",
          reason: "command-conflict",
          message: `Command ${COMMAND} carries another intent`,
        },
      );
    },
  );

  it("keeps any other handler failure what it was, and never answers a write without its receipt", async () => {
    const board = boardHarness({
      answers: {
        "board.createTicket": () => {
          throw new Error("disk full");
        },
        "board.archiveTicket": () => ({ receipt: null, throughCursor: "0:feed:1" }),
        "board.setPriority": () => {
          throw new OperationUnavailableError("No board on this host");
        },
      },
    });
    const failed = reasonOf(
      await refusal(board.caller.board.createTicket, inputs(OWNED)["board.createTicket"]),
    );
    expect(failed).toEqual({ code: "INTERNAL_SERVER_ERROR", message: "disk full" });
    expect(
      reasonOf(
        await refusal(board.caller.board.archiveTicket, inputs(OWNED)["board.archiveTicket"]),
      ),
    ).toEqual({
      code: "INTERNAL_SERVER_ERROR",
      message: "A board command answered without its receipt",
    });
    expect(
      reasonOf(await refusal(board.caller.board.setPriority, inputs(OWNED)["board.setPriority"])),
    ).toMatchObject({ code: "NOT_IMPLEMENTED", reason: "operation-unavailable" });
  });
});

describe("board.moveTickets", () => {
  const move = (ticketIds: string[]) => ({
    commandId: COMMAND,
    projectId: WORKSPACE,
    ticketIds,
    toStatus: "doing",
    toIndex: 2,
    choice: { kind: "automation", automationId: "automation-1" },
  });

  it("hands the handler one card as ticketId, and a selection as ticketIds", async () => {
    const board = boardHarness({
      answers: { "board.moveTickets": () => ({ ...written, tickets: [ticket, second] }) },
    });
    await board.caller.board.moveTickets(move(["ticket-1"]) as never);
    await board.caller.board.moveTickets(move(["ticket-1", "ticket-2"]) as never);
    const [one, several] = board.calls.map(({ input }) => input);
    const common = {
      commandId: COMMAND,
      projectId: WORKSPACE,
      toStatus: "doing",
      toIndex: 2,
      choice: { kind: "automation", automationId: "automation-1" },
    };
    expect(one).toStrictEqual({ ...common, ticketId: "ticket-1" });
    expect(several).toStrictEqual({ ...common, ticketIds: ["ticket-1", "ticket-2"] });
    // Each moved ticket is checked, and the board they land on is the caller's own.
    expect(board.asked.map(({ id }) => id)).toEqual(["ticket-1", "ticket-1", "ticket-2"]);
  });

  it("answers summaries, never bodies", async () => {
    const board = boardHarness({
      answers: { "board.moveTickets": () => ({ ...written, tickets: [ticket, second] }) },
    });
    const answer = await board.caller.board.moveTickets(move(["ticket-1", "ticket-2"]) as never);
    expect(answer.tickets).toHaveLength(2);
    for (const moved of answer.tickets) expect(moved).not.toHaveProperty("body");
    expect(answer).toStrictEqual({
      ...written,
      tickets: [summary, { ...summary, id: "ticket-2", ticketNumber: 2, order: 1 }],
    });
  });

  it("refuses an empty selection and a negative index", async () => {
    const board = boardHarness();
    for (const input of [move([]), { ...move(["ticket-1"]), toIndex: -1 }]) {
      expect(reasonOf(await refusal(board.caller.board.moveTickets, input))).toMatchObject({
        code: "BAD_REQUEST",
      });
    }
    expect(board.calls).toEqual([]);
  });
});

describe("board.updateTicket", () => {
  it("takes no worktreePath: a host path is the host's to stamp", async () => {
    const board = boardHarness({
      answers: { "board.updateTicket": () => ({ ...written, ticket }) },
    });
    await board.caller.board.updateTicket({
      commandId: COMMAND,
      ticketId: "ticket-1",
      title: "Renamed",
      worktreePath: "/etc",
      prUrl: "https://example.invalid/pr/1",
    } as never);
    expect(board.calls[0]!.input).toStrictEqual({
      commandId: COMMAND,
      ticketId: "ticket-1",
      title: "Renamed",
    });
    const published = z.toJSONSchema(boardProcedureSchemas()["board.updateTicket"]!.input, {
      io: "input",
    }) as { properties: Record<string, unknown> };
    expect(Object.keys(published.properties).toSorted()).toEqual(
      ["commandId", "ticketId", "title", "body", "branch", "baseBranch", "usesWorktree"].toSorted(),
    );
  });
});

describe("output validation on a network caller", () => {
  it("keeps every project preference, event context and payload field it carries", async () => {
    const board = boardHarness({
      transport: "websocket",
      answers: {
        "board.snapshot": () => ({ project, tickets: [ticket], labels: [label], cursor: "c-9" }),
        "board.setSkillModes": () => ({ ...written, project }),
        "board.ticketEvents": () => [event],
      },
    });
    const snapshot = await board.caller.board.snapshot({ projectId: WORKSPACE });
    expect(snapshot.project).toStrictEqual(project);
    expect(snapshot.project).toMatchObject({
      skillModes: { "code-review": "manual", deploy: "off" },
      sessionModel: { providerId: "anthropic", modelId: "model-a", reasoningLevel: "high" },
      authorityPolicy: { budgets: {} },
      themeOverride: { terminalThemeName: "Dracula" },
      decisionModel: { kind: "none" },
    });
    expect(snapshot.tickets).toStrictEqual([ticket]);
    expect(
      await board.caller.board.setSkillModes({
        commandId: COMMAND,
        projectId: WORKSPACE,
        modes: { deploy: "off" },
      }),
    ).toStrictEqual({ ...written, project });
    expect(await board.caller.board.ticketEvents({ ticketId: "ticket-1" })).toStrictEqual([event]);
  });

  it("validates what it answers: an invalid row fails, an undeclared key is dropped", async () => {
    const board = boardHarness({
      transport: "websocket",
      answers: {
        "board.createTicket": () => ({ ...written, ticket: { ...ticket, title: undefined } }),
        "board.setLabelColor": () => ({ ...written, label: { ...label, secret: "host-only" } }),
      },
    });
    expect(
      reasonOf(await refusal(board.caller.board.createTicket, inputs(OWNED)["board.createTicket"])),
    ).toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    expect(
      await board.caller.board.setLabelColor({
        commandId: COMMAND,
        labelId: "label-1",
        color: null,
      }),
    ).toStrictEqual({ ...written, label });
  });

  it("is skipped only for the desktop's own window over in-process IPC", async () => {
    const extra = { ...written, label: { ...label, secret: "host-only" } };
    const local = boardHarness({
      caller: LOCAL_DESKTOP_CALLER,
      transport: "electron-ipc",
      answers: { "board.setLabelColor": () => extra },
    });
    const input = { commandId: COMMAND, labelId: "label-1", color: null };
    expect(await local.caller.board.setLabelColor(input)).toStrictEqual(extra);
    const network = boardHarness({
      transport: "electron-ipc",
      answers: { "board.setLabelColor": () => extra },
    });
    expect(await network.caller.board.setLabelColor(input)).toStrictEqual({ ...written, label });
  });
});

describe("board.changes", () => {
  const change: BoardChange = {
    kind: "ticket",
    op: "upsert",
    id: "ticket-1",
    projectId: WORKSPACE,
    commandId: COMMAND,
    ticket: summary,
  };
  const batch = (cursor: string): BoardFeedEmission => ({ cursor, changes: [change] });

  type Sink = { emit(batch: BoardFeedEmission): void; fail(error: unknown): void };

  /** A feed whose sink the test holds, and whose unsubscribe it counts. */
  function feed(open: (sink: Sink) => void = () => {}) {
    const state = { sink: null as Sink | null, unsubscribed: 0, inputs: [] as unknown[] };
    const answers = {
      "board.changes": (input: unknown, _call: HandlerCall, sink: Sink) => {
        state.inputs.push(input);
        state.sink = sink;
        open(sink);
        return () => {
          state.unsubscribed += 1;
        };
      },
    } as Partial<Record<string, Handler>>;
    return { state, answers };
  }

  it("yields each batch as a tracked frame whose id is its cursor, resuming after lastEventId", async () => {
    const { state, answers } = feed();
    const board = boardHarness({ answers });
    const stream = await board.caller.board.changes({ projectId: WORKSPACE, lastEventId: "c-4" });
    const iterator = stream[Symbol.asyncIterator]();
    const first = iterator.next();
    await vi.waitFor(() => expect(state.sink).not.toBeNull());
    state.sink!.emit(batch("c-5"));
    state.sink!.emit(batch("c-6"));
    expect(await first).toEqual({ done: false, value: tracked("c-5", batch("c-5")) });
    expect(await iterator.next()).toEqual({ done: false, value: tracked("c-6", batch("c-6")) });
    expect(state.inputs).toEqual([{ projectId: WORKSPACE, after: "c-4" }]);
    expect(board.calls[0]!.call).toEqual(PERSON);
    // Stopping the stream unsubscribes the host's feed, once.
    await iterator.return?.();
    expect(state.unsubscribed).toBe(1);
  });

  it("opens from the head when it names no cursor, and unsubscribes when the caller aborts", async () => {
    const { state, answers } = feed();
    const controller = new AbortController();
    const board = boardHarness({ answers, signal: controller.signal });
    const stream = await board.caller.board.changes({ projectId: WORKSPACE });
    const iterator = stream[Symbol.asyncIterator]();
    const next = iterator.next();
    await vi.waitFor(() => expect(state.sink).not.toBeNull());
    controller.abort();
    expect(await next).toEqual({ done: true, value: undefined });
    expect(state.inputs).toEqual([{ projectId: WORKSPACE, after: null }]);
    expect(state.unsubscribed).toBe(1);
  });

  it("opens nothing for a caller that has already gone", async () => {
    const { state, answers } = feed();
    const controller = new AbortController();
    controller.abort();
    const board = boardHarness({ answers, signal: controller.signal });
    const stream = await board.caller.board.changes({ projectId: WORKSPACE });
    expect(await stream[Symbol.asyncIterator]().next()).toEqual({ done: true, value: undefined });
    expect(state.inputs).toEqual([]);
  });

  it.each([
    ["the shared error", new FeedResnapshotRequiredError()],
    ["the brand alone", { [FEED_RESNAPSHOT_REQUIRED]: true }],
  ])(
    "answers a cursor that cannot resume (%s) PRECONDITION_FAILED / subscription-resnapshot-required",
    async (_name, thrown) => {
      const board = boardHarness({
        answers: {
          "board.changes": () => {
            throw thrown;
          },
        },
      });
      expect(
        reasonOf(
          await refusal(board.caller.board.changes, { projectId: WORKSPACE, lastEventId: "old" }),
        ),
      ).toMatchObject({ code: "PRECONDITION_FAILED", reason: "subscription-resnapshot-required" });
    },
  );

  it("answers an unavailable feed operation-unavailable, and passes any other failure through", async () => {
    const unavailable = boardHarness({
      answers: {
        "board.changes": () => {
          throw new OperationUnavailableError("No feed here");
        },
      },
    });
    expect(
      reasonOf(await refusal(unavailable.caller.board.changes, { projectId: WORKSPACE })),
    ).toMatchObject({ code: "NOT_IMPLEMENTED", reason: "operation-unavailable" });
    const broken = new Error("feed exploded");
    const failing = boardHarness({
      answers: {
        "board.changes": () => {
          throw broken;
        },
      },
    });
    expect(await refusal(failing.caller.board.changes, { projectId: WORKSPACE })).toBe(broken);
  });

  it("drains what it holds, then ends subscription-overflow when its consumer falls behind", async () => {
    // 1,024 frames fit the queue; the 1,025th overflows it.
    const { state, answers } = feed((sink) => {
      for (let index = 1; index <= 1_025; index++) sink.emit(batch(`c-${index}`));
    });
    const board = boardHarness({ answers });
    const stream = await board.caller.board.changes({ projectId: WORKSPACE });
    const ids: string[] = [];
    const ended = await (async () => {
      try {
        for await (const frame of stream) ids.push((frame as unknown as [string])[0]);
      } catch (error) {
        return error;
      }
      return null;
    })();
    expect(ids).toHaveLength(1_024);
    expect(ids.at(-1)).toBe("c-1024");
    expect(reasonOf(ended)).toMatchObject({
      code: "TOO_MANY_REQUESTS",
      reason: "subscription-overflow",
    });
    expect(state.unsubscribed).toBe(1);
  });

  it("drains what it holds, then ends subscription-source-failed when the feed fails", async () => {
    const { state, answers } = feed((sink) => {
      sink.emit(batch("c-1"));
      sink.fail(new Error("the store went away"));
    });
    const board = boardHarness({ answers });
    const iterator = (await board.caller.board.changes({ projectId: WORKSPACE }))[
      Symbol.asyncIterator
    ]();
    expect(await iterator.next()).toEqual({ done: false, value: tracked("c-1", batch("c-1")) });
    const error = await iterator.next().catch((caught: unknown) => caught);
    expect(reasonOf(error)).toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      reason: "subscription-source-failed",
    });
    expect(state.unsubscribed).toBe(1);
  });

  it("drains what it holds, then ends subscription-resnapshot-required when the feed ends under it", async () => {
    const { state, answers } = feed((sink) => {
      sink.emit(batch("c-1"));
      // The Workspace's epoch changed, or it was removed.
      sink.fail(new FeedResnapshotRequiredError());
    });
    const board = boardHarness({ answers });
    const iterator = (await board.caller.board.changes({ projectId: WORKSPACE }))[
      Symbol.asyncIterator
    ]();
    expect(await iterator.next()).toEqual({ done: false, value: tracked("c-1", batch("c-1")) });
    const error = await iterator.next().catch((caught: unknown) => caught);
    expect(reasonOf(error)).toMatchObject({
      code: "PRECONDITION_FAILED",
      reason: "subscription-resnapshot-required",
    });
    expect(state.unsubscribed).toBe(1);
  });
});

describe("the composed host router", () => {
  /* oxlint-disable no-underscore-dangle -- tRPC's router introspection door. */
  it("serves both families' procedures, each once, under the one error envelope", () => {
    const session = Object.keys(createSessionRouter()._def.procedures);
    const board = Object.keys(createBoardRouter()._def.procedures);
    const workspaces = Object.keys(createWorkspacesRouter()._def.procedures);
    const host = createHostRouter();
    expect(session.filter((path) => board.includes(path))).toEqual([]);
    expect(Object.keys(host._def.procedures).toSorted()).toEqual(
      [...session, ...board, ...workspaces].toSorted(),
    );
    expect(board.toSorted()).toEqual([...PATHS].toSorted());
    for (const router of [
      host,
      createBoardRouter(),
      createSessionRouter(),
      createWorkspacesRouter(),
    ]) {
      expect(router._def._config.errorFormatter).toBe(catalogErrorFormatter);
    }
  });
  /* oxlint-enable no-underscore-dangle */

  it("answers a board call through its board family's policy", async () => {
    const calls: string[] = [];
    const host = createHostRouter().createCaller({
      caller: device,
      diagnostics: new RpcDiagnosticLog(),
      resourceWorkspace: () => null,
      handlers: {
        "board.roster": () => {
          calls.push("board.roster");
          return { tickets: [summary], labels: [], cursor: "c-1" };
        },
      } as never,
    });
    await expect(host.board.roster({ projectId: WORKSPACE })).resolves.toStrictEqual({
      tickets: [summary],
      labels: [],
      cursor: "c-1",
    });
    // A Session-family Workspace read is judged by its own family the same way.
    const board = await host.board.ticketBody({ ticketId: "ticket-1" }).catch(hostErrorOf);
    const sessions = await host.session
      .list({ projectId: OTHER })
      .catch((error: unknown) => hostErrorOf(error));
    expect(board).toEqual(sessions);
    expect(sessions).toMatchObject({ code: "NOT_FOUND", reason: "workspace-unknown" });
    expect(calls).toEqual(["board.roster"]);
  });

  it("refuses at construction a family that reuses another's namespace", async () => {
    vi.resetModules();
    vi.doMock("./board-router", async (importOriginal) => ({
      ...(await importOriginal<object>()),
      createBoardRouter: () => ({ _def: { record: { session: {} } } }),
    }));
    try {
      const { createHostRouter: compose } = await import("./host-router");
      expect(() => compose()).toThrow("Router namespace session belongs to two families");
    } finally {
      vi.doUnmock("./board-router");
      vi.resetModules();
    }
  });
  it("refuses a project family that shadows either existing family", async () => {
    for (const namespace of ["session", "board"]) {
      vi.resetModules();
      vi.doMock("./workspaces-router", () => ({
        createWorkspacesRouter: () => ({ _def: { record: { [namespace]: {} } } }),
      }));
      try {
        const { createHostRouter: compose } = await import("./host-router");
        expect(() => compose()).toThrow(`Router namespace ${namespace} belongs to two families`);
      } finally {
        vi.doUnmock("./workspaces-router");
        vi.resetModules();
      }
    }
  });
});

// ------------------------------------------------- published open unions

const marker = "x-volli-open-union";
type Node = Record<string, unknown>;
function markedUnions(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(markedUnions);
  if (value === null || typeof value !== "object") return [];
  const node = value as Node;
  return [...(marker in node ? [node] : []), ...Object.values(node).flatMap(markedUnions)];
}
function vocabulary(node: Node): string {
  const discriminator = node[marker] as string;
  expect(node.oneOf).toBeInstanceOf(Array);
  const values = (node.oneOf as Node[]).flatMap((variant) => {
    const field = (variant.properties as Record<string, Node>)[discriminator]!;
    expect(variant.required).toContain(discriminator);
    return "const" in field ? [field.const] : (field.enum as unknown[]);
  });
  expect(new Set(values).size).toBe(values.length);
  return JSON.stringify([discriminator, values.toSorted()]);
}

describe("the board's published grammar", () => {
  const CHANGE_VOCABULARY = JSON.stringify(["kind", [...BOARD_CHANGE_KINDS].toSorted()]);

  it("marks the change feed's kind open, with exactly the board's change kinds", () => {
    const document = z.toJSONSchema(boardChangeSchema);
    expect(document[marker]).toBe("kind");
    expect(vocabulary(document)).toBe(CHANGE_VOCABULARY);
    // A receipt's status is closed: an unknown one could be misread as success.
    expect(markedUnions(z.toJSONSchema(receiptSchema))).toEqual([]);
  });

  it("publishes that one vocabulary on board.changes alone, and never an open input", () => {
    const schemas = boardProcedureSchemas();
    expect(Object.keys(schemas).toSorted()).toEqual([...PATHS].toSorted());
    const found: string[] = [];
    for (const [path, procedure] of Object.entries(schemas)) {
      expect(markedUnions(z.toJSONSchema(procedure.input, { io: "input" }))).toEqual([]);
      for (const union of markedUnions(z.toJSONSchema(procedure.output))) {
        found.push(`${path} ${vocabulary(union)}`);
      }
      expect(procedure.outputValidation).toBe(
        path === "board.changes" ? "documented-yield" : "network-and-tests",
      );
    }
    expect(found).toEqual([`board.changes ${CHANGE_VOCABULARY}`]);
  });
});
