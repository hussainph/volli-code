import { randomUUID } from "node:crypto";
import { ipcMain } from "electron";
import type Database from "better-sqlite3";
import {
  createTicket,
  derivePrefix,
  errorMessage,
  isTicketPriority,
  isTicketStatus,
  LEGACY_BACKUP_APP_STATE_KEY,
  moveTicket,
  PROJECT_COLORS,
  sanitizeLegacyProjects,
} from "@volli/shared";
import type {
  AppStateSetResult,
  ArchivedTicketsResult,
  BootstrapPayload,
  BootstrapResult,
  Label,
  LabelResult,
  LegacyImportRequest,
  LegacyImportResult,
  Project,
  ProjectCreateResult,
  ProjectMutationResult,
  Result,
  Ticket,
  TicketPriority,
  TicketResult,
  TicketsResult,
  TicketStatus,
  VolliIpcChannel,
} from "@volli/shared";
import { getAllAppState, setAppState } from "./db/app-state-repo";
import { recordTicketEvent } from "./db/events-repo";
import {
  addTicketLabel,
  findLabelByName,
  getOrCreateLabel,
  listAllLabels,
  removeTicketLabel,
  setLabelColor,
} from "./db/labels-repo";
import {
  countProjects,
  deleteProject,
  findProjectByPath,
  insertProject,
  listProjects,
  nextSortOrder,
  reorderProjects,
} from "./db/projects-repo";
import {
  archiveTicket,
  bumpTicketVersion,
  deleteTicket,
  getTicket,
  getTicketLabelNames,
  getTicketRow,
  insertTicket,
  listAllTickets,
  listArchivedTicketsByProject,
  listTicketsByProject,
  nextPositionInStatus,
  nextTicketNumberForProject,
  unarchiveTicket,
  updateTicketFields,
  updateTicketPositionStatus,
  updateTicketPriority,
} from "./db/tickets-repo";
import type { TicketFieldUpdate } from "./db/tickets-repo";

/** The result of the main-process open+migrate attempt (`src/main/index.ts`), fed into {@link registerDataIpcHandlers}. */
export type DbHandle = { ok: true; db: Database.Database } | { ok: false; error: string };

/** Every channel this module owns — used to register the uniform degraded-DB failure path. */
const DATA_CHANNELS: readonly VolliIpcChannel[] = [
  "volli:data-bootstrap",
  "volli:legacy-import",
  "volli:project-create",
  "volli:project-remove",
  "volli:project-reorder",
  "volli:ticket-create",
  "volli:ticket-move",
  "volli:ticket-set-priority",
  "volli:ticket-update",
  "volli:ticket-set-labels",
  "volli:ticket-archive",
  "volli:ticket-unarchive",
  "volli:ticket-delete",
  "volli:ticket-list-archived",
  "volli:label-set-color",
  "volli:app-state-set",
];

// ---- input validation -------------------------------------------------
// The status/priority vocabulary guards live in @volli/shared next to the
// TICKET_STATUSES/TICKET_PRIORITIES constants they guard (isTicketStatus/
// isTicketPriority), imported above.

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/** Whether `value` is a `Record<string, string>` (the appState/rawBackup payload shape). */
function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value as Record<string, unknown>).every((entry) => typeof entry === "string")
  );
}

function isLegacyImportRequest(value: unknown): value is LegacyImportRequest {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    Array.isArray(candidate["projects"]) &&
    isStringRecord(candidate["appState"]) &&
    isStringRecord(candidate["rawBackup"])
  );
}

interface ProjectCreateInput {
  path: string;
  name: string;
}

function isProjectCreateInput(value: unknown): value is ProjectCreateInput {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate["path"] === "string" && typeof candidate["name"] === "string";
}

interface TicketCreateInput {
  projectId: string;
  status: TicketStatus;
  title: string;
  priority?: TicketPriority;
}

function isTicketCreateInput(value: unknown): value is TicketCreateInput {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate["projectId"] === "string" &&
    typeof candidate["title"] === "string" &&
    candidate["title"].trim().length > 0 &&
    isTicketStatus(candidate["status"]) &&
    (candidate["priority"] === undefined || isTicketPriority(candidate["priority"]))
  );
}

interface TicketMoveInput {
  projectId: string;
  ticketId: string;
  toStatus: TicketStatus;
  toIndex: number;
}

function isTicketMoveInput(value: unknown): value is TicketMoveInput {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate["projectId"] === "string" &&
    typeof candidate["ticketId"] === "string" &&
    isTicketStatus(candidate["toStatus"]) &&
    typeof candidate["toIndex"] === "number" &&
    Number.isInteger(candidate["toIndex"])
  );
}

interface TicketSetPriorityInput {
  ticketId: string;
  priority: TicketPriority;
}

function isTicketSetPriorityInput(value: unknown): value is TicketSetPriorityInput {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate["ticketId"] === "string" && isTicketPriority(candidate["priority"]);
}

interface TicketUpdateInput {
  ticketId: string;
  title?: string;
  body?: string;
}

function isTicketUpdateInput(value: unknown): value is TicketUpdateInput {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate["ticketId"] === "string" &&
    (candidate["title"] === undefined || typeof candidate["title"] === "string") &&
    (candidate["body"] === undefined || typeof candidate["body"] === "string")
  );
}

interface TicketSetLabelsInput {
  ticketId: string;
  labels: string[];
}

function isTicketSetLabelsInput(value: unknown): value is TicketSetLabelsInput {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate["ticketId"] === "string" && isStringArray(candidate["labels"]);
}

interface TicketIdInput {
  ticketId: string;
}

/** The `{ ticketId }` shape shared by the archive/unarchive/delete handlers. */
function isTicketIdInput(value: unknown): value is TicketIdInput {
  if (typeof value !== "object" || value === null) return false;
  return typeof (value as Record<string, unknown>)["ticketId"] === "string";
}

interface LabelSetColorInput {
  labelId: string;
  color: string | null;
}

function isLabelSetColorInput(value: unknown): value is LabelSetColorInput {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate["labelId"] === "string" &&
    (candidate["color"] === null || typeof candidate["color"] === "string")
  );
}

// ---- bootstrap payload --------------------------------------------------

function buildBootstrapPayload(db: Database.Database): BootstrapPayload {
  const projects = listProjects(db);
  const appState = getAllAppState(db);

  const ticketsByProject: Record<string, Ticket[]> = {};
  const labelsByProject: Record<string, Label[]> = {};
  for (const project of projects) {
    ticketsByProject[project.id] = [];
    labelsByProject[project.id] = [];
  }
  for (const ticket of listAllTickets(db)) {
    (ticketsByProject[ticket.projectId] ??= []).push(ticket);
  }
  for (const label of listAllLabels(db)) {
    (labelsByProject[label.projectId] ??= []).push(label);
  }

  return { projects, ticketsByProject, labelsByProject, appState };
}

// ---- registration --------------------------------------------------------

/**
 * Registers every `volli:data-*`/`volli:project-*`/`volli:ticket-*`/
 * `volli:label-*`/`volli:app-state-*` handler. When the db failed to open
 * (`handle.ok === false`), every channel instead resolves with `{ ok: false,
 * error: handle.error }` — main never crashes and invoke() never hangs; the
 * renderer surfaces the error itself. Failures never throw across the IPC
 * boundary either way — every handler below catches and converts.
 */
export function registerDataIpcHandlers(handle: DbHandle): void {
  if (!handle.ok) {
    const error = handle.error;
    for (const channel of DATA_CHANNELS) {
      ipcMain.handle(channel, () => ({ ok: false, error }));
    }
    return;
  }

  const db = handle.db;

  ipcMain.handle("volli:data-bootstrap" satisfies VolliIpcChannel, (): BootstrapResult => {
    try {
      return { ok: true, data: buildBootstrapPayload(db) };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  });

  ipcMain.handle(
    "volli:legacy-import" satisfies VolliIpcChannel,
    (_event, request: unknown): LegacyImportResult => {
      if (!isLegacyImportRequest(request)) {
        return { ok: false, error: "Invalid legacy import payload" };
      }
      try {
        // Idempotent-safe: only import into a genuinely empty projects
        // table; a second call (e.g. a relaunch racing the renderer) just
        // hands back the current state instead of re-importing over it.
        if (countProjects(db) > 0) {
          return { ok: true, data: buildBootstrapPayload(db), imported: 0 };
        }
        const legacyProjects = sanitizeLegacyProjects(request.projects);
        const now = Date.now();
        const run = db.transaction(() => {
          // Back up the raw source FIRST, in the same transaction: whatever
          // else happens, once this commits the untouched localStorage strings
          // live in SQLite, so boot can clear localStorage without ever making
          // a lossy/unreadable import unrecoverable (decision #29).
          if (Object.keys(request.rawBackup).length > 0) {
            setAppState(db, LEGACY_BACKUP_APP_STATE_KEY, JSON.stringify(request.rawBackup), now);
          }
          legacyProjects.forEach((legacy, index) => {
            insertProject(db, {
              id: legacy.id,
              name: legacy.name,
              path: legacy.path,
              ticketPrefix: legacy.ticketPrefix,
              colorIndex: legacy.colorIndex,
              sortOrder: index,
              createdAt: legacy.createdAt,
              updatedAt: now,
            });
          });
          for (const [key, value] of Object.entries(request.appState)) {
            setAppState(db, key, value, now);
          }
        });
        run();
        return { ok: true, data: buildBootstrapPayload(db), imported: legacyProjects.length };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  );

  ipcMain.handle(
    "volli:project-create" satisfies VolliIpcChannel,
    (_event, input: unknown): ProjectCreateResult => {
      if (!isProjectCreateInput(input)) {
        return { ok: false, error: "Invalid project" };
      }
      try {
        const existing = findProjectByPath(db, input.path);
        if (existing) {
          return { ok: true, project: existing, created: false };
        }
        const now = Date.now();
        const project: Project = {
          id: randomUUID(),
          name: input.name,
          path: input.path,
          ticketPrefix: derivePrefix(input.name),
          colorIndex: countProjects(db) % PROJECT_COLORS.length,
          sortOrder: nextSortOrder(db),
          createdAt: now,
          updatedAt: now,
        };
        insertProject(db, project);
        return { ok: true, project, created: true };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  );

  ipcMain.handle(
    "volli:project-remove" satisfies VolliIpcChannel,
    (_event, id: unknown): ProjectMutationResult => {
      if (typeof id !== "string") {
        return { ok: false, error: "Invalid project id" };
      }
      try {
        deleteProject(db, id);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  );

  ipcMain.handle(
    "volli:project-reorder" satisfies VolliIpcChannel,
    (_event, orderedIds: unknown): ProjectMutationResult => {
      if (!isStringArray(orderedIds)) {
        return { ok: false, error: "Invalid project order" };
      }
      try {
        reorderProjects(db, orderedIds, Date.now());
        return { ok: true };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  );

  ipcMain.handle(
    "volli:ticket-create" satisfies VolliIpcChannel,
    (_event, input: unknown): TicketResult => {
      if (!isTicketCreateInput(input)) {
        return { ok: false, error: "Invalid ticket" };
      }
      try {
        const now = Date.now();
        const run = db.transaction((): Ticket => {
          const ticketNumber = nextTicketNumberForProject(db, input.projectId);
          const position = nextPositionInStatus(db, input.projectId, input.status);
          const ticket = createTicket({
            id: randomUUID(),
            projectId: input.projectId,
            ticketNumber,
            title: input.title,
            status: input.status,
            order: position,
            now,
            priority: input.priority,
          });
          insertTicket(db, ticket);
          recordTicketEvent(
            db,
            ticket.id,
            { kind: "created", status: ticket.status, title: ticket.title },
            now,
          );
          return ticket;
        });
        return { ok: true, ticket: run() };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  );

  ipcMain.handle(
    "volli:ticket-move" satisfies VolliIpcChannel,
    (_event, input: unknown): TicketsResult => {
      if (!isTicketMoveInput(input)) {
        return { ok: false, error: "Invalid ticket move" };
      }
      try {
        const now = Date.now();
        const run = db.transaction((): Ticket[] => {
          const before = listTicketsByProject(db, input.projectId);
          const beforeById = new Map(before.map((ticket) => [ticket.id, ticket]));
          const after = moveTicket(before, input.ticketId, input.toStatus, input.toIndex, now);

          if (after !== before) {
            for (const ticket of after) {
              const prior = beforeById.get(ticket.id);
              if (!prior) continue;
              if (prior.status !== ticket.status || prior.order !== ticket.order) {
                updateTicketPositionStatus(
                  db,
                  ticket.id,
                  ticket.status,
                  ticket.order,
                  ticket.updatedAt,
                );
              }
            }
            const movedBefore = beforeById.get(input.ticketId);
            const movedAfter = after.find((ticket) => ticket.id === input.ticketId);
            if (movedBefore && movedAfter && movedBefore.status !== movedAfter.status) {
              recordTicketEvent(
                db,
                input.ticketId,
                { kind: "status_changed", from: movedBefore.status, to: movedAfter.status },
                now,
              );
            }
          }
          return after;
        });
        return { ok: true, tickets: run() };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  );

  ipcMain.handle(
    "volli:ticket-set-priority" satisfies VolliIpcChannel,
    (_event, input: unknown): TicketResult => {
      if (!isTicketSetPriorityInput(input)) {
        return { ok: false, error: "Invalid priority change" };
      }
      try {
        const now = Date.now();
        const run = db.transaction((): Ticket => {
          const row = getTicketRow(db, input.ticketId);
          if (!row) throw new Error("Unknown ticket");
          if (row.priority !== input.priority) {
            updateTicketPriority(db, input.ticketId, input.priority, now);
            recordTicketEvent(
              db,
              input.ticketId,
              {
                kind: "priority_changed",
                from: row.priority as TicketPriority,
                to: input.priority,
              },
              now,
            );
          }
          const ticket = getTicket(db, input.ticketId);
          if (!ticket) throw new Error("Unknown ticket");
          return ticket;
        });
        return { ok: true, ticket: run() };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  );

  ipcMain.handle(
    "volli:ticket-update" satisfies VolliIpcChannel,
    (_event, input: unknown): TicketResult => {
      if (!isTicketUpdateInput(input)) {
        return { ok: false, error: "Invalid ticket update" };
      }
      try {
        const now = Date.now();
        const run = db.transaction((): Ticket => {
          const row = getTicketRow(db, input.ticketId);
          if (!row) throw new Error("Unknown ticket");

          const fields: TicketFieldUpdate = {};
          if (input.title !== undefined && input.title !== row.title) fields.title = input.title;
          if (input.body !== undefined && input.body !== row.body) fields.body = input.body;

          if (fields.title !== undefined || fields.body !== undefined) {
            updateTicketFields(db, input.ticketId, fields, now);
            if (fields.title !== undefined) {
              recordTicketEvent(
                db,
                input.ticketId,
                { kind: "retitled", from: row.title, to: fields.title },
                now,
              );
            }
            if (fields.body !== undefined) {
              recordTicketEvent(db, input.ticketId, { kind: "body_edited" }, now);
            }
          }
          const ticket = getTicket(db, input.ticketId);
          if (!ticket) throw new Error("Unknown ticket");
          return ticket;
        });
        return { ok: true, ticket: run() };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  );

  ipcMain.handle(
    "volli:ticket-set-labels" satisfies VolliIpcChannel,
    (_event, input: unknown): TicketResult => {
      if (!isTicketSetLabelsInput(input)) {
        return { ok: false, error: "Invalid labels" };
      }
      try {
        const now = Date.now();
        const run = db.transaction((): Ticket => {
          const row = getTicketRow(db, input.ticketId);
          if (!row) throw new Error("Unknown ticket");

          const current = getTicketLabelNames(db, input.ticketId);
          const requested = input.labels;
          const added = requested.filter((name) => !current.includes(name));
          const removed = current.filter((name) => !requested.includes(name));

          if (added.length > 0 || removed.length > 0) {
            for (const name of added) {
              const label = getOrCreateLabel(db, row.project_id, name, now);
              addTicketLabel(db, input.ticketId, label.id);
            }
            for (const name of removed) {
              const label = findLabelByName(db, row.project_id, name);
              if (label) removeTicketLabel(db, input.ticketId, label.id);
            }
            bumpTicketVersion(db, input.ticketId, now);
            recordTicketEvent(db, input.ticketId, { kind: "labels_changed", added, removed }, now);
          }
          const ticket = getTicket(db, input.ticketId);
          if (!ticket) throw new Error("Unknown ticket");
          return ticket;
        });
        return { ok: true, ticket: run() };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  );

  ipcMain.handle(
    "volli:ticket-archive" satisfies VolliIpcChannel,
    (_event, input: unknown): Result => {
      if (!isTicketIdInput(input)) {
        return { ok: false, error: "Invalid ticket" };
      }
      try {
        const now = Date.now();
        const run = db.transaction((): void => {
          const row = getTicketRow(db, input.ticketId);
          if (!row) throw new Error("Unknown ticket");
          // Idempotent: re-archiving an already-archived ticket records nothing.
          if (row.archived_at === null) {
            archiveTicket(db, input.ticketId, now);
            recordTicketEvent(db, input.ticketId, { kind: "archived" }, now);
          }
        });
        run();
        return { ok: true };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  );

  ipcMain.handle(
    "volli:ticket-unarchive" satisfies VolliIpcChannel,
    (_event, input: unknown): TicketResult => {
      if (!isTicketIdInput(input)) {
        return { ok: false, error: "Invalid ticket" };
      }
      try {
        const now = Date.now();
        const run = db.transaction((): Ticket => {
          const row = getTicketRow(db, input.ticketId);
          if (!row) throw new Error("Unknown ticket");
          if (row.archived_at !== null) {
            // Append at the live end of its retained column — MAX+1 runs while
            // this ticket is still archived, so its own row can't contribute.
            const position = nextPositionInStatus(db, row.project_id, row.status as TicketStatus);
            unarchiveTicket(db, input.ticketId, position, now);
            recordTicketEvent(db, input.ticketId, { kind: "unarchived" }, now);
          }
          const ticket = getTicket(db, input.ticketId);
          if (!ticket) throw new Error("Unknown ticket");
          return ticket;
        });
        return { ok: true, ticket: run() };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  );

  ipcMain.handle(
    "volli:ticket-delete" satisfies VolliIpcChannel,
    (_event, input: unknown): Result => {
      if (!isTicketIdInput(input)) {
        return { ok: false, error: "Invalid ticket" };
      }
      try {
        const run = db.transaction((): void => {
          const row = getTicketRow(db, input.ticketId);
          if (!row) throw new Error("Unknown ticket");
          // The only destructive act, and only from the Archive: a live board
          // ticket is archived, never hard-deleted (CONCEPT #16/#92). Guarding
          // here — not just in the UI — keeps a stray call from nuking a live
          // ticket's history. The FK cascades take its labels + events with it.
          if (row.archived_at === null) {
            throw new Error("Only archived tickets can be deleted");
          }
          deleteTicket(db, input.ticketId);
        });
        run();
        return { ok: true };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  );

  ipcMain.handle(
    "volli:ticket-list-archived" satisfies VolliIpcChannel,
    (_event, projectId: unknown): ArchivedTicketsResult => {
      if (typeof projectId !== "string") {
        return { ok: false, error: "Invalid project id" };
      }
      try {
        return { ok: true, tickets: listArchivedTicketsByProject(db, projectId) };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  );

  ipcMain.handle(
    "volli:label-set-color" satisfies VolliIpcChannel,
    (_event, input: unknown): LabelResult => {
      if (!isLabelSetColorInput(input)) {
        return { ok: false, error: "Invalid label color" };
      }
      try {
        const label = setLabelColor(db, input.labelId, input.color, Date.now());
        if (!label) return { ok: false, error: "Unknown label" };
        return { ok: true, label };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  );

  ipcMain.handle(
    "volli:app-state-set" satisfies VolliIpcChannel,
    (_event, key: unknown, value: unknown): AppStateSetResult => {
      if (typeof key !== "string" || typeof value !== "string") {
        return { ok: false, error: "Invalid app state" };
      }
      try {
        setAppState(db, key, value, Date.now());
        return { ok: true };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    },
  );
}
