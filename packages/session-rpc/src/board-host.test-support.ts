/**
 * A deterministic in-memory board behind the board router's handler slice
 * (VC-565), for tests that drive the router through a real door
 * (`board-contract.test.ts`, `board-wire-compatibility.test.ts`).
 *
 * Not host-core: session-rpc cannot import it, and these tests prove the
 * router and the listener, not the host's handlers. What the fake keeps is the
 * contract a door relies on:
 *
 * - every write runs under its `commandId` through one receipt map: the same
 *   intent answers the recorded answer with `replayed: true` and no new
 *   effect; another intent throws an error branded `CommandIntentConflict`;
 * - every write that ran stamps its changes on the Workspace feed, naming the
 *   command; a feed cursor is `feed-a:<seq>`, and `board.changes` replays
 *   strictly after one this feed minted, then goes live, and throws
 *   `FeedResnapshotRequiredError` for any other;
 * - `resourceWorkspace` answers a ticket's, comment's and label's project,
 *   and a Session's: `session-a` and `session-b` work on this board,
 *   `session-x` in {@link OTHER_WORKSPACE}.
 *
 * Ids and clocks are counters, so two fakes driven alike answer byte-for-byte
 * alike.
 */
import {
  COMMAND_INTENT_CONFLICT,
  FeedResnapshotRequiredError,
  type ArchivedTicket,
  type BoardChange,
  type BoardCommandReceipt,
  type CommandIntentConflict,
  type HarnessId,
  type Label,
  type LatestSessionSignal,
  type Project,
  type Ticket,
  type TicketComment,
  type TicketEvent,
} from "@volli/shared";

import {
  COMMENT_RESOURCE,
  LABEL_RESOURCE,
  TICKET_RESOURCE,
  type BoardFeedEmission,
  type BoardRouterHandlers,
} from "./board-router";
import type { WorkspaceResource } from "./catalog";
import { SESSION_RESOURCE } from "./session-catalog";

export const BOARD_WORKSPACE = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";
export const OTHER_WORKSPACE = "0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d";
export const BOARD_HOST = "b7c1d2e3-4f50-4a6b-8c7d-9e0f1a2b3c4d";
export const BOARD_DEVICE = "7e8d9c0b-1a2f-4e3d-9c4b-5a6f7e8d9c0b";
/** The fake feed's instance: a cursor naming any other cannot resume here. */
export const FEED_INSTANCE = "feed-a";

/** The one conflict a client causes: a command id reused for another intent. */
export class FakeIntentConflictError extends Error implements CommandIntentConflict {
  readonly [COMMAND_INTENT_CONFLICT] = true as const;
}

type Row = Ticket & { archivedAt?: number };

export interface FakeBoard {
  readonly handlers: BoardRouterHandlers;
  resourceWorkspace(resource: WorkspaceResource): string | null;
  /** Every handler key reached, in order. */
  readonly reached: string[];
  /** Commands that ran (a replay or a conflict runs none). */
  readonly effects: string[];
  /** The `after` each `board.changes` subscription was opened with. */
  readonly afters: (string | null)[];
  /** Live feed subscribers right now. */
  listeners(): number;
}

function project(id: string, name: string, prefix: string): Project {
  return {
    id,
    name,
    path: `/work/${prefix.toLowerCase()}`,
    ticketPrefix: prefix,
    baseBranch: "main",
    setupCommand: null,
    themeAppearance: null,
    skillModes: { "code-review": "manual" },
    sessionModel: { providerId: "anthropic", modelId: "model-a", reasoningLevel: "high" },
    colorIndex: 2,
    sortOrder: 0,
    createdAt: 100,
    updatedAt: 100,
  };
}

function ticket(id: string, projectId: string, ticketNumber: number, title: string): Row {
  return {
    id,
    projectId,
    ticketNumber,
    title,
    body: `${title}, in Markdown.`,
    status: "todo",
    priority: "medium",
    labels: [],
    usesWorktree: true,
    preferredHarnessId: "claude-code",
    order: 0,
    worktreePath: null,
    branch: null,
    baseBranch: null,
    prUrl: null,
    createdAt: 200,
    updatedAt: 200,
  };
}

/** Writes the defined fields of `fields` onto `target`, the way a partial edit does. */
function patch<Target extends object>(target: Target, fields: Partial<Target>): Target {
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) Reflect.set(target, key, value);
  }
  return target;
}

function withoutArchive({ archivedAt: _archivedAt, ...row }: Row): Ticket {
  return row;
}

function summary({ body: _body, ...row }: Ticket) {
  return row;
}

/** The Sessions the fake knows, by Workspace. */
const SESSIONS: Readonly<Record<string, string>> = {
  "session-a": BOARD_WORKSPACE,
  "session-b": BOARD_WORKSPACE,
  "session-x": OTHER_WORKSPACE,
};

export function fakeBoard(): FakeBoard {
  let clock = 1_000;
  const now = (): number => (clock += 1);
  let nextId = 0;
  const mint = (kind: string): string => `${kind}-${(nextId += 1)}`;

  const projects = new Map<string, Project>([
    [BOARD_WORKSPACE, project(BOARD_WORKSPACE, "Board", "VC")],
    [OTHER_WORKSPACE, project(OTHER_WORKSPACE, "Elsewhere", "EL")],
  ]);
  const tickets = new Map<string, Row>();
  const first = ticket("ticket-a", BOARD_WORKSPACE, 1, "First card");
  first.labels = ["ui"];
  const second = patch(ticket("ticket-b", BOARD_WORKSPACE, 2, "Second card"), {
    status: "doing",
    priority: "high",
  });
  const shelved = patch(ticket("ticket-c", BOARD_WORKSPACE, 3, "Shelved card"), {
    status: "done",
    archivedAt: 300,
  });
  for (const row of [first, second, shelved, ticket("ticket-x", OTHER_WORKSPACE, 1, "Foreign")]) {
    tickets.set(row.id, row);
  }
  const labels = new Map<string, Label>([
    ["label-ui", { id: "label-ui", projectId: BOARD_WORKSPACE, name: "ui", color: null }],
    ["label-x", { id: "label-x", projectId: OTHER_WORKSPACE, name: "ui", color: "#fff" }],
  ]);
  const comments = new Map<string, TicketComment>(
    [
      ["comment-a", "ticket-a", "Looks right."],
      ["comment-x", "ticket-x", "Not yours."],
    ].map(([id, ticketId, body]) => [
      id!,
      {
        id: id!,
        ticketId: ticketId!,
        sessionId: null,
        actor: "user",
        body: body!,
        createdAt: 250,
        updatedAt: 250,
      },
    ]),
  );
  const events: TicketEvent[] = [
    {
      id: "event-a",
      ticketId: "ticket-a",
      actor: "user",
      createdAt: 200,
      payload: { kind: "created", status: "todo", title: "First card" },
    },
    {
      id: "event-b",
      ticketId: "ticket-a",
      actor: "session",
      actorContext: { sessionId: "session-a", ticketId: "ticket-a" },
      createdAt: 260,
      payload: { kind: "commented", commentId: "comment-a" },
    },
  ];
  const signals: LatestSessionSignal[] = [
    {
      ticketId: "ticket-b",
      sessionId: "session-b",
      signal: "blocked",
      reason: "Needs a key",
      createdAt: 270,
    },
  ];

  const reached: string[] = [];
  const effects: string[] = [];
  const afters: (string | null)[] = [];
  const receipts = new Map<
    string,
    { intent: string; answer: { receipt: BoardCommandReceipt; throughCursor: string } }
  >();
  const log: BoardFeedEmission[] = [];
  const listeners = new Set<(batch: BoardFeedEmission) => void | Promise<void>>();

  function stamp(changes: BoardChange[]): void {
    const batch = { cursor: `${FEED_INSTANCE}:${log.length + 1}`, changes };
    log.push(batch);
    for (const listener of listeners) void listener(batch);
  }

  /** A write under its command id: recorded once, replayed or refused after. */
  function command<Input extends { commandId?: string }, Answer extends object>(
    key: string,
    input: Input,
    run: (commandId: string) => Answer,
  ): { receipt: BoardCommandReceipt; throughCursor: string } & Answer {
    reached.push(key);
    const { commandId, ...rest } = input;
    const intent = JSON.stringify([key, rest]);
    const prior = receipts.get(commandId!);
    if (prior !== undefined) {
      if (prior.intent !== intent) {
        throw new FakeIntentConflictError(
          `Command ${commandId} was already used for another intent`,
        );
      }
      return {
        ...prior.answer,
        receipt: { ...prior.answer.receipt, replayed: true },
        throughCursor: cursor(),
      } as never;
    }
    effects.push(key);
    const ran = run(commandId!);
    const answer = {
      receipt: { commandId: commandId!, status: "completed" as const, replayed: false },
      // Through the stamp the write just made, as the host's handlers answer.
      throughCursor: cursor(),
      ...ran,
    };
    receipts.set(commandId!, { intent, answer });
    return answer;
  }

  const projectOf = (id: string): Project => projects.get(id)!;
  const rowOf = (id: string): Row => tickets.get(id)!;
  const board = (projectId: string): Row[] =>
    [...tickets.values()].filter(
      (row) => row.projectId === projectId && row.archivedAt === undefined,
    );
  const labelsOf = (projectId: string): Label[] =>
    [...labels.values()].filter((label) => label.projectId === projectId);
  const cursor = (): string => `${FEED_INSTANCE}:${log.length}`;

  function projectChange(id: string, commandId: string): BoardChange {
    return {
      kind: "project",
      op: "upsert",
      id,
      projectId: id,
      commandId,
      project: { ...projectOf(id) },
    };
  }
  function ticketChange(
    row: Row,
    commandId: string,
    op: "upsert" | "delete" = "upsert",
  ): BoardChange {
    return op === "delete"
      ? { kind: "ticket", op, id: row.id, projectId: row.projectId, commandId }
      : {
          kind: "ticket",
          op,
          id: row.id,
          projectId: row.projectId,
          commandId,
          ticket: summary(withoutArchive(row)),
        };
  }
  function commentChange(
    comment: TicketComment,
    commandId: string,
    op: "upsert" | "delete",
  ): BoardChange {
    return {
      kind: "comment",
      op,
      id: comment.id,
      projectId: rowOf(comment.ticketId).projectId,
      ticketId: comment.ticketId,
      commandId,
      ...(op === "upsert" ? { comment: { ...comment } } : {}),
    };
  }
  /** A ticket's label names, each made a label row the first time it is named. */
  function ensureLabels(projectId: string, names: string[], commandId: string): BoardChange[] {
    const changes: BoardChange[] = [];
    for (const name of names) {
      if (labelsOf(projectId).some((label) => label.name === name)) continue;
      const label = { id: mint("label"), projectId, name, color: null };
      labels.set(label.id, label);
      changes.push({ kind: "label", op: "upsert", id: label.id, projectId, commandId, label });
    }
    return changes;
  }
  function touch(row: Row, fields: Partial<Row>): Row {
    return patch(row, { ...fields, updatedAt: now() });
  }

  const handlers: BoardRouterHandlers = {
    "ticket.move": (input) => {
      reached.push("ticket.move");
      touch(rowOf(input.ticketId), { status: input.toStatus });
      return board(input.projectId).map(withoutArchive);
    },
    "board.snapshot": ({ projectId }) => {
      reached.push("board.snapshot");
      return {
        project: projectOf(projectId),
        tickets: board(projectId).map(withoutArchive),
        labels: labelsOf(projectId),
        cursor: cursor(),
      };
    },
    "board.roster": ({ projectId }) => {
      reached.push("board.roster");
      return {
        tickets: board(projectId).map((row) => summary(withoutArchive(row))),
        labels: labelsOf(projectId),
        cursor: cursor(),
      };
    },
    "board.changes": async ({ after }, _call, sink) => {
      reached.push("board.changes");
      afters.push(after);
      const minted = [`${FEED_INSTANCE}:0`, ...log.map((batch) => batch.cursor)];
      const from = after === null ? log.length : minted.indexOf(after);
      // Not a cursor this feed minted: another instance's, or invented.
      if (from < 0) throw new FeedResnapshotRequiredError();
      for (const batch of log.slice(from)) await sink.emit(batch);
      const listener = (batch: BoardFeedEmission) => sink.emit(batch);
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    "board.projectFolder": ({ projectId }) => {
      reached.push("board.projectFolder");
      return { path: projectOf(projectId).path, state: "present" };
    },
    "board.ticketBody": ({ ticketId }) => {
      reached.push("board.ticketBody");
      return { body: rowOf(ticketId).body };
    },
    "board.archivedTickets": ({ projectId }) => {
      reached.push("board.archivedTickets");
      return [...tickets.values()].filter(
        (row): row is ArchivedTicket => row.projectId === projectId && row.archivedAt !== undefined,
      );
    },
    "board.ticketEvents": ({ ticketId }) => {
      reached.push("board.ticketEvents");
      return events.filter((event) => event.ticketId === ticketId);
    },
    "board.latestSignals": ({ projectId }) => {
      reached.push("board.latestSignals");
      return signals.filter((signal) => rowOf(signal.ticketId).projectId === projectId);
    },
    "board.statusEntries": ({ projectId }) => {
      reached.push("board.statusEntries");
      return board(projectId).map((row) => ({
        ticketId: row.id,
        status: row.status,
        enteredAt: row.updatedAt,
      }));
    },
    "board.comments": ({ ticketId }) => {
      reached.push("board.comments");
      return [...comments.values()].filter((comment) => comment.ticketId === ticketId);
    },

    "board.updateProject": (input) =>
      command("board.updateProject", input, (commandId) => {
        patch(projectOf(input.projectId), {
          baseBranch: input.baseBranch,
          setupCommand: input.setupCommand,
          updatedAt: now(),
        });
        stamp([projectChange(input.projectId, commandId)]);
        return { project: { ...projectOf(input.projectId) } };
      }),
    "board.setSkillModes": (input) =>
      command("board.setSkillModes", input, (commandId) => {
        patch(projectOf(input.projectId), {
          skillModes: input.modes as Project["skillModes"],
          updatedAt: now(),
        });
        stamp([projectChange(input.projectId, commandId)]);
        return { project: { ...projectOf(input.projectId) } };
      }),
    "board.setSessionDefaults": (input) =>
      command("board.setSessionDefaults", input, (commandId) => {
        patch(projectOf(input.projectId), { sessionModel: input.model, updatedAt: now() });
        stamp([projectChange(input.projectId, commandId)]);
        return { project: { ...projectOf(input.projectId) } };
      }),
    "board.createTicket": (input) =>
      command("board.createTicket", input, (commandId) => {
        const numbers = [...tickets.values()]
          .filter((row) => row.projectId === input.projectId)
          .map((row) => row.ticketNumber);
        const row = patch(
          ticket(mint("ticket"), input.projectId, Math.max(...numbers) + 1, input.title),
          {
            status: input.status,
            body: input.body,
            priority: input.priority,
            labels: input.labels,
            usesWorktree: input.usesWorktree,
            preferredHarnessId: input.preferredHarnessId as HarnessId | undefined,
            baseBranch: input.baseBranch,
            order: board(input.projectId).filter((other) => other.status === input.status).length,
            createdAt: clock + 1,
            updatedAt: now(),
          },
        );
        tickets.set(row.id, row);
        stamp([
          ...ensureLabels(row.projectId, row.labels, commandId),
          ticketChange(row, commandId),
        ]);
        return { ticket: withoutArchive(row) };
      }),
    "board.moveTickets": (input) =>
      command("board.moveTickets", input, (commandId) => {
        const ids = "ticketIds" in input ? input.ticketIds : [input.ticketId];
        const moved = ids.map((id, index) =>
          touch(rowOf(id), { status: input.toStatus, order: (input.toIndex as number) + index }),
        );
        stamp(moved.map((row) => ticketChange(row, commandId)));
        return { tickets: moved.map(withoutArchive) };
      }),
    "board.setPriority": (input) =>
      command("board.setPriority", input, (commandId) => {
        const row = touch(rowOf(input.ticketId), { priority: input.priority });
        stamp([ticketChange(row, commandId)]);
        return { ticket: withoutArchive(row) };
      }),
    "board.updateTicket": (input) =>
      command("board.updateTicket", input, (commandId) => {
        const { commandId: _commandId, ticketId, ...fields } = input;
        const row = touch(rowOf(ticketId), fields);
        stamp([ticketChange(row, commandId)]);
        return { ticket: withoutArchive(row) };
      }),
    "board.setLabels": (input) =>
      command("board.setLabels", input, (commandId) => {
        const row = touch(rowOf(input.ticketId), { labels: input.labels });
        stamp([
          ...ensureLabels(row.projectId, input.labels, commandId),
          ticketChange(row, commandId),
        ]);
        return { ticket: withoutArchive(row) };
      }),
    "board.archiveTicket": (input) =>
      command("board.archiveTicket", input, (commandId) => {
        const row = touch(rowOf(input.ticketId), { archivedAt: clock });
        stamp([ticketChange(row, commandId, "delete")]);
        return {};
      }),
    "board.unarchiveTicket": (input) =>
      command("board.unarchiveTicket", input, (commandId) => {
        const row = touch(rowOf(input.ticketId), {});
        delete row.archivedAt;
        stamp([ticketChange(row, commandId)]);
        return { ticket: withoutArchive(row) };
      }),
    "board.deleteTicket": (input) =>
      command("board.deleteTicket", input, (commandId) => {
        const row = rowOf(input.ticketId);
        tickets.delete(row.id);
        stamp([ticketChange(row, commandId, "delete")]);
        return {};
      }),
    "board.createComment": (input) =>
      command("board.createComment", input, (commandId) => {
        const at = now();
        const comment: TicketComment = {
          id: mint("comment"),
          ticketId: input.ticketId,
          sessionId: input.sessionId ?? null,
          actor: "user",
          body: input.body,
          createdAt: at,
          updatedAt: at,
        };
        comments.set(comment.id, comment);
        stamp([commentChange(comment, commandId, "upsert")]);
        return { comment: { ...comment } };
      }),
    "board.updateComment": (input) =>
      command("board.updateComment", input, (commandId) => {
        const comment = patch(comments.get(input.commentId)!, {
          body: input.body,
          updatedAt: now(),
        });
        stamp([commentChange(comment, commandId, "upsert")]);
        return { comment: { ...comment } };
      }),
    "board.removeComment": (input) =>
      command("board.removeComment", input, (commandId) => {
        const comment = comments.get(input.commentId)!;
        comments.delete(comment.id);
        stamp([commentChange(comment, commandId, "delete")]);
        return {};
      }),
    "board.setLabelColor": (input) =>
      command("board.setLabelColor", input, (commandId) => {
        const label = labels.get(input.labelId)!;
        label.color = input.color;
        stamp([
          {
            kind: "label",
            op: "upsert",
            id: label.id,
            projectId: label.projectId,
            commandId,
            label: { ...label },
          },
        ]);
        return { label: { ...label } };
      }),
  };

  return {
    handlers,
    reached,
    effects,
    afters,
    listeners: () => listeners.size,
    resourceWorkspace(resource) {
      switch (resource.kind) {
        case TICKET_RESOURCE:
          return tickets.get(resource.id)?.projectId ?? null;
        case COMMENT_RESOURCE: {
          const comment = comments.get(resource.id);
          return comment === undefined ? null : rowOf(comment.ticketId).projectId;
        }
        case LABEL_RESOURCE:
          return labels.get(resource.id)?.projectId ?? null;
        case SESSION_RESOURCE:
          return SESSIONS[resource.id] ?? null;
        default:
          return null;
      }
    },
  };
}
