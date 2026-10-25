/**
 * The last-seen Volli Cloud board, as this window keeps it on disk for a
 * launch that cannot reach the backend (VC-889, D3; main stores the text,
 * `main/cloud-snapshot.ts`).
 *
 * - **What it holds:** the Workspace on screen, its projects, and each
 *   project's cards and labels as the board painted them. No ticket bodies
 *   (each card reads its own when opened), no transcripts, nothing but what
 *   the backend had already answered.
 * - **Schema-versioned:** a snapshot another version wrote, another account's,
 *   or one that does not hold together, reads as none. An offline launch then
 *   shows today's offline state rather than a guess.
 * - **Written when the live board settles:** debounced, so a burst of changes
 *   is one write, and only while the board on screen is the live one.
 */
import type { Label, Project, Ticket } from "@volli/shared";

/** The snapshot format this build writes and reads. */
export const BOARD_SNAPSHOT_VERSION = 1;

/** How long the live board must be quiet before it is written. */
export const BOARD_SNAPSHOT_DEBOUNCE_MS = 2_000;

/** How long a cloud launch waits for its live project list before showing the snapshot. */
export const BOARD_SNAPSHOT_AFTER_MS = 4_000;

export interface BoardSnapshot {
  readonly version: typeof BOARD_SNAPSHOT_VERSION;
  readonly userId: string;
  /** When the board was last seen live (epoch ms). */
  readonly savedAt: number;
  readonly workspace: { readonly id: string; readonly name: string };
  readonly projects: readonly Project[];
  readonly boards: Readonly<
    Record<string, { readonly tickets: readonly Ticket[]; readonly labels: readonly Label[] }>
  >;
}

/** The snapshot's text, bodies left out. */
export function encodeBoardSnapshot(snapshot: BoardSnapshot): string {
  const boards = Object.fromEntries(
    Object.entries(snapshot.boards).map(([projectId, board]) => [
      projectId,
      { tickets: board.tickets.map((ticket) => ({ ...ticket, body: "" })), labels: board.labels },
    ]),
  );
  return JSON.stringify({ ...snapshot, boards });
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === "string";

function isProject(value: unknown): value is Project {
  return (
    isRecord(value) &&
    isString(value["id"]) &&
    isString(value["name"]) &&
    isString(value["ticketPrefix"])
  );
}

function isTicket(value: unknown): value is Ticket {
  return (
    isRecord(value) &&
    isString(value["id"]) &&
    isString(value["projectId"]) &&
    isString(value["title"]) &&
    isString(value["status"]) &&
    typeof value["ticketNumber"] === "number" &&
    typeof value["order"] === "number" &&
    Array.isArray(value["labels"])
  );
}

function isLabel(value: unknown): value is Label {
  return isRecord(value) && isString(value["id"]) && isString(value["name"]);
}

function isBoard(value: unknown): value is BoardSnapshot["boards"][string] {
  return (
    isRecord(value) &&
    Array.isArray(value["tickets"]) &&
    value["tickets"].every(isTicket) &&
    Array.isArray(value["labels"]) &&
    value["labels"].every(isLabel)
  );
}

/**
 * The snapshot in `text`, when it is this version's, this account's, and
 * whole; `null` otherwise (nothing kept, another account's, or not one).
 */
export function decodeBoardSnapshot(text: string | null, userId: string): BoardSnapshot | null {
  if (text === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (
    !isRecord(value) ||
    value["version"] !== BOARD_SNAPSHOT_VERSION ||
    value["userId"] !== userId ||
    typeof value["savedAt"] !== "number" ||
    !isRecord(value["workspace"]) ||
    !isString(value["workspace"]["id"]) ||
    !isString(value["workspace"]["name"]) ||
    !Array.isArray(value["projects"]) ||
    !value["projects"].every(isProject) ||
    !isRecord(value["boards"]) ||
    !Object.values(value["boards"]).every(isBoard)
  ) {
    return null;
  }
  return value as unknown as BoardSnapshot;
}

/**
 * The board to keep, as the window holds it now: `null` unless it is the live
 * one (the snapshot is not on screen) and every listed project's board has
 * painted from a live answer, so a half-loaded board never replaces a whole
 * one.
 */
export function liveBoardSnapshot(input: {
  readonly userId: string;
  readonly savedAt: number;
  readonly showingSnapshot: boolean;
  readonly workspace: { readonly id: string; readonly name: string } | null;
  readonly projects: readonly Project[];
  readonly ticketsByProject: Readonly<Record<string, readonly Ticket[]>>;
  readonly labelsByProject: Readonly<Record<string, readonly Label[]>>;
  painted(projectId: string): boolean;
}): BoardSnapshot | null {
  if (input.showingSnapshot || input.workspace === null) return null;
  if (!input.projects.every((project) => input.painted(project.id))) return null;
  return {
    version: BOARD_SNAPSHOT_VERSION,
    userId: input.userId,
    savedAt: input.savedAt,
    workspace: { id: input.workspace.id, name: input.workspace.name },
    projects: input.projects,
    boards: Object.fromEntries(
      input.projects.map((project) => [
        project.id,
        {
          tickets: input.ticketsByProject[project.id] ?? [],
          labels: input.labelsByProject[project.id] ?? [],
        },
      ]),
    ),
  };
}

/** A timer, injectable for tests. */
export interface SnapshotClock {
  now(): number;
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/**
 * Writes the live board once it has been quiet for
 * {@link BOARD_SNAPSHOT_DEBOUNCE_MS}: `read` answers the board to keep (or
 * `null` when there is no live board to keep), `save` hands its text to main.
 * A failed save is logged, and the next change tries again.
 */
export function createSnapshotWriter(deps: {
  read(savedAt: number): BoardSnapshot | null;
  save(text: string): Promise<unknown>;
  clock: SnapshotClock;
  warn(message: string, error: unknown): void;
}): { schedule(): void } {
  let timer: unknown = null;
  const write = () => {
    timer = null;
    const snapshot = deps.read(deps.clock.now());
    if (snapshot === null) return;
    deps.save(encodeBoardSnapshot(snapshot)).catch((error: unknown) => {
      deps.warn("couldn't keep the board snapshot", error);
    });
  };
  return {
    schedule() {
      if (timer !== null) deps.clock.clearTimeout(timer);
      timer = deps.clock.setTimeout(write, BOARD_SNAPSHOT_DEBOUNCE_MS);
    },
  };
}
