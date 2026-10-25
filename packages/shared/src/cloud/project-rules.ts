/**
 * A cloud project's board-level rules as pure decisions: creating one in a
 * Workspace, renaming it, archiving it. Like the ticket rules
 * (`board-rules.ts`), each reads facts and answers changes and board events;
 * the backend mutation applies them.
 *
 * The ticket prefix is fixed for the project's life (ticket keys survive
 * moves). It is unique among a Workspace's live projects when the project is
 * created; a later move or migration may bring in a duplicate, which
 * resolution then reports as ambiguous (`ticket-key.ts`).
 */

import { derivePrefix, isValidPrefix, PROJECT_COLORS } from "../project-prefix";
import { BoardRuleError, type BoardEventDraft } from "./board-rules";

const PROJECT_LIMITS = { nameLength: 200, descriptionLength: 2_000 } as const;

function invalid(message: string): BoardRuleError {
  return new BoardRuleError("invalid_argument", message);
}

/** A project name as stored: trimmed, non-empty, bounded. */
function normalizeProjectName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) throw invalid("A project needs a name.");
  if (trimmed.length > PROJECT_LIMITS.nameLength) {
    throw invalid(`A project name is at most ${PROJECT_LIMITS.nameLength} characters.`);
  }
  return trimmed;
}

export interface CreateProjectCommand {
  name: string;
  description?: string;
  /** Absent: derived from the name. */
  ticketPrefix?: string;
}

export interface CreateProjectState {
  /** The Workspace's live (not deleted) projects. Archived ones still hold their prefix. */
  projects: readonly { name: string; ticketPrefix: string }[];
}

export interface CreateProjectDecision {
  name: string;
  description: string;
  ticketPrefix: string;
  colorIndex: number;
  events: BoardEventDraft[];
}

/**
 * A new project's identity. A named prefix must be valid and free in the
 * Workspace (`prefix_taken` otherwise); a derived one that is taken is
 * refused the same way, so the person picks one rather than Volli guessing.
 * The tile colour is assigned round-robin, as on the local board.
 */
export function decideCreateProject(
  state: CreateProjectState,
  command: CreateProjectCommand,
): CreateProjectDecision {
  const name = normalizeProjectName(command.name);
  const description = (command.description ?? "").trim();
  if (description.length > PROJECT_LIMITS.descriptionLength) {
    throw invalid(
      `A project description is at most ${PROJECT_LIMITS.descriptionLength} characters.`,
    );
  }
  const ticketPrefix = command.ticketPrefix ?? derivePrefix(name);
  if (!isValidPrefix(ticketPrefix)) {
    throw invalid(
      "Ticket prefixes must be 1–5 uppercase letters or digits and start with a letter.",
    );
  }
  const collision = state.projects.find((project) => project.ticketPrefix === ticketPrefix);
  if (collision !== undefined) {
    throw new BoardRuleError(
      "prefix_taken",
      `Ticket prefix "${ticketPrefix}" is already used by ${collision.name}.`,
    );
  }
  return {
    name,
    description,
    ticketPrefix,
    colorIndex: state.projects.length % PROJECT_COLORS.length,
    events: [{ ticketId: null, payload: { kind: "project_created", name, ticketPrefix } }],
  };
}

export interface ProjectDecision {
  patch: { name?: string; archivedAt?: number | null };
  events: BoardEventDraft[];
}

/** Renames a project; the same name changes nothing. Its prefix never changes. */
export function decideRenameProject(project: { name: string }, name: string): ProjectDecision {
  const next = normalizeProjectName(name);
  if (next === project.name) return { patch: {}, events: [] };
  return {
    patch: { name: next },
    events: [
      { ticketId: null, payload: { kind: "project_renamed", from: project.name, to: next } },
    ],
  };
}

/**
 * Archives (hides from the rail and refuses board writes) or restores a
 * project. Archive is not deletion: everything is kept. Repeating either
 * changes nothing.
 */
export function decideArchiveProject(
  project: { archivedAt: number | null },
  archived: boolean,
  now: number,
): ProjectDecision {
  if (archived === (project.archivedAt !== null)) return { patch: {}, events: [] };
  return archived
    ? {
        patch: { archivedAt: now },
        events: [{ ticketId: null, payload: { kind: "project_archived" } }],
      }
    : {
        patch: { archivedAt: null },
        events: [{ ticketId: null, payload: { kind: "project_unarchived" } }],
      };
}
