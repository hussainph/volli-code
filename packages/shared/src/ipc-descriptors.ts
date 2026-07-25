// Runtime half of the IPC request contract (issue #98). The type half lives in
// ipc.ts; this module may be imported at runtime by MAIN ONLY — the preload
// stays type-only on @volli/shared (the pack config keeps main and preload
// dependency-disjoint; see CAUTION in apps/desktop/vite.config.ts).

import type { DataIpcChannel, FileIpcChannel, IpcArgs, VolliInvokeContract } from "./ipc";
import { isHarnessId, isTicketPriority, isTicketStatus } from "./ticket";
import { isValidBranchName } from "./ticket-branch";

/**
 * One request's runtime descriptor: the validator over the raw
 * `ipcRenderer.invoke` argument tuple, and the exact `{ ok: false }` error
 * string returned when it rejects. The mapped table types below force every
 * guard's predicate to match its channel's contract `args` — a guard that
 * checks the wrong shape is a compile error, not silent drift.
 */
export interface IpcRequestDescriptor<C extends keyof VolliInvokeContract> {
  guard: (args: unknown[]) => args is IpcArgs<C>;
  invalidError: string;
}

// ---- shape helpers ----------------------------------------------------
// The status/priority/harness vocabulary guards live in @volli/shared next to
// the vocab constants they guard (isTicketStatus/isTicketPriority/isHarnessId),
// imported above; isValidBranchName lives next to the branch-naming rules.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/** Whether `value` is a `Record<string, string>` (the appState/rawBackup payload shape) — shallow only; deep sanitizing happens elsewhere (sanitizeLegacyProjects). */
function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) &&
    !Array.isArray(value) &&
    Object.values(value).every((v) => typeof v === "string")
  );
}

/** `undefined` (untouched), `null` (clear), or a `string` (set) — the worktree-identity/setupCommand field shape. */
function isOptionalNullableString(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === "string";
}

/** The `{ ticketId }` shape shared by every single-ticket-scoped channel. */
function isTicketIdInput(value: unknown): value is { ticketId: string } {
  return isRecord(value) && typeof value["ticketId"] === "string";
}

/** The `{ projectId }` shape shared by every single-project-scoped channel. */
function isProjectIdInput(value: unknown): value is { projectId: string } {
  return isRecord(value) && typeof value["projectId"] === "string";
}

// ---- data-IPC descriptor table ------------------------------------------
// Exactly one entry per VolliDataIpcContract channel (exhaustiveness is
// compile-checked in both directions). `DATA_CHANNELS` derives from its keys,
// so the degraded-DB registration can no longer skip a channel and leave a
// renderer `invoke()` hanging.

export const DATA_IPC: { readonly [C in DataIpcChannel]: IpcRequestDescriptor<C> } = {
  "volli:data-bootstrap": {
    guard: (args): args is [] => args.length === 0,
    invalidError: "Invalid request",
  },
  "volli:legacy-import": {
    guard: (args): args is IpcArgs<"volli:legacy-import"> => {
      if (args.length !== 1) return false;
      const [request] = args;
      return (
        isRecord(request) &&
        Array.isArray(request["projects"]) &&
        isStringRecord(request["appState"]) &&
        isStringRecord(request["rawBackup"])
      );
    },
    invalidError: "Invalid legacy import payload",
  },

  "volli:project-create": {
    guard: (args): args is IpcArgs<"volli:project-create"> => {
      if (args.length !== 1) return false;
      const [input] = args;
      return (
        isRecord(input) && typeof input["path"] === "string" && typeof input["name"] === "string"
      );
    },
    invalidError: "Invalid project",
  },
  "volli:project-update": {
    guard: (args): args is IpcArgs<"volli:project-update"> => {
      if (args.length !== 1) return false;
      const [input] = args;
      return (
        isRecord(input) &&
        typeof input["id"] === "string" &&
        (input["baseBranch"] === null ||
          (typeof input["baseBranch"] === "string" && isValidBranchName(input["baseBranch"]))) &&
        isOptionalNullableString(input["setupCommand"])
      );
    },
    invalidError: "Invalid project base branch",
  },
  "volli:project-remove": {
    guard: (args): args is IpcArgs<"volli:project-remove"> =>
      args.length === 1 && typeof args[0] === "string",
    invalidError: "Invalid project id",
  },
  "volli:project-reorder": {
    guard: (args): args is IpcArgs<"volli:project-reorder"> =>
      args.length === 1 && isStringArray(args[0]),
    invalidError: "Invalid project order",
  },

  "volli:ticket-create": {
    guard: (args): args is IpcArgs<"volli:ticket-create"> => {
      if (args.length !== 1) return false;
      const [input] = args;
      return (
        isRecord(input) &&
        typeof input["projectId"] === "string" &&
        typeof input["title"] === "string" &&
        input["title"].trim().length > 0 &&
        isTicketStatus(input["status"]) &&
        (input["priority"] === undefined || isTicketPriority(input["priority"])) &&
        (input["body"] === undefined || typeof input["body"] === "string") &&
        (input["labels"] === undefined || isStringArray(input["labels"])) &&
        (input["usesWorktree"] === undefined || typeof input["usesWorktree"] === "boolean") &&
        (input["preferredHarnessId"] === undefined || isHarnessId(input["preferredHarnessId"]))
      );
    },
    invalidError: "Invalid ticket",
  },
  "volli:ticket-move": {
    guard: (args): args is IpcArgs<"volli:ticket-move"> => {
      if (args.length !== 1) return false;
      const [input] = args;
      return (
        isRecord(input) &&
        typeof input["projectId"] === "string" &&
        typeof input["ticketId"] === "string" &&
        isTicketStatus(input["toStatus"]) &&
        typeof input["toIndex"] === "number" &&
        Number.isInteger(input["toIndex"])
      );
    },
    invalidError: "Invalid ticket move",
  },
  "volli:ticket-set-priority": {
    guard: (args): args is IpcArgs<"volli:ticket-set-priority"> => {
      if (args.length !== 1) return false;
      const [input] = args;
      return (
        isRecord(input) &&
        typeof input["ticketId"] === "string" &&
        isTicketPriority(input["priority"])
      );
    },
    invalidError: "Invalid priority change",
  },
  "volli:ticket-update": {
    guard: (args): args is IpcArgs<"volli:ticket-update"> => {
      if (args.length !== 1) return false;
      const [input] = args;
      return (
        isRecord(input) &&
        typeof input["ticketId"] === "string" &&
        (input["title"] === undefined || typeof input["title"] === "string") &&
        (input["body"] === undefined || typeof input["body"] === "string") &&
        isOptionalNullableString(input["worktreePath"]) &&
        isOptionalNullableString(input["branch"]) &&
        isOptionalNullableString(input["baseBranch"])
      );
    },
    invalidError: "Invalid ticket update",
  },
  "volli:ticket-set-labels": {
    guard: (args): args is IpcArgs<"volli:ticket-set-labels"> => {
      if (args.length !== 1) return false;
      const [input] = args;
      return (
        isRecord(input) && typeof input["ticketId"] === "string" && isStringArray(input["labels"])
      );
    },
    invalidError: "Invalid labels",
  },
  "volli:ticket-archive": {
    guard: (args): args is IpcArgs<"volli:ticket-archive"> =>
      args.length === 1 && isTicketIdInput(args[0]),
    invalidError: "Invalid ticket",
  },
  "volli:ticket-unarchive": {
    guard: (args): args is IpcArgs<"volli:ticket-unarchive"> =>
      args.length === 1 && isTicketIdInput(args[0]),
    invalidError: "Invalid ticket",
  },
  "volli:ticket-delete": {
    guard: (args): args is IpcArgs<"volli:ticket-delete"> =>
      args.length === 1 && isTicketIdInput(args[0]),
    invalidError: "Invalid ticket",
  },
  "volli:ticket-list-archived": {
    guard: (args): args is IpcArgs<"volli:ticket-list-archived"> =>
      args.length === 1 && typeof args[0] === "string",
    invalidError: "Invalid project id",
  },
  "volli:ticket-events": {
    guard: (args): args is IpcArgs<"volli:ticket-events"> =>
      args.length === 1 && isTicketIdInput(args[0]),
    invalidError: "Invalid ticket",
  },
  "volli:ticket-latest-signals": {
    guard: (args): args is IpcArgs<"volli:ticket-latest-signals"> =>
      args.length === 1 && isProjectIdInput(args[0]),
    invalidError: "Invalid project",
  },

  "volli:comment-list": {
    guard: (args): args is IpcArgs<"volli:comment-list"> =>
      args.length === 1 && isTicketIdInput(args[0]),
    invalidError: "Invalid ticket",
  },
  "volli:comment-create": {
    guard: (args): args is IpcArgs<"volli:comment-create"> => {
      if (args.length !== 1) return false;
      const [input] = args;
      return (
        isRecord(input) &&
        typeof input["ticketId"] === "string" &&
        typeof input["body"] === "string" &&
        input["body"].trim().length > 0 &&
        (input["sessionId"] === undefined ||
          input["sessionId"] === null ||
          typeof input["sessionId"] === "string")
      );
    },
    invalidError: "Invalid comment",
  },
  "volli:comment-update": {
    guard: (args): args is IpcArgs<"volli:comment-update"> => {
      if (args.length !== 1) return false;
      const [input] = args;
      return (
        isRecord(input) &&
        typeof input["commentId"] === "string" &&
        typeof input["body"] === "string" &&
        input["body"].trim().length > 0
      );
    },
    invalidError: "Invalid comment update",
  },
  "volli:comment-remove": {
    guard: (args): args is IpcArgs<"volli:comment-remove"> =>
      args.length === 1 && isRecord(args[0]) && typeof args[0]["commentId"] === "string",
    invalidError: "Invalid comment",
  },

  "volli:session-list": {
    guard: (args): args is IpcArgs<"volli:session-list"> =>
      args.length === 1 && isProjectIdInput(args[0]),
    invalidError: "Invalid project",
  },
  "volli:session-list-for-ticket": {
    guard: (args): args is IpcArgs<"volli:session-list-for-ticket"> =>
      args.length === 1 && isTicketIdInput(args[0]),
    invalidError: "Invalid ticket",
  },
  "volli:session-rename": {
    guard: (args): args is IpcArgs<"volli:session-rename"> => {
      if (args.length !== 1) return false;
      const [input] = args;
      return (
        isRecord(input) &&
        typeof input["sessionId"] === "string" &&
        typeof input["title"] === "string" &&
        input["title"].trim().length > 0
      );
    },
    invalidError: "Invalid session title",
  },
  "volli:label-set-color": {
    guard: (args): args is IpcArgs<"volli:label-set-color"> => {
      if (args.length !== 1) return false;
      const [input] = args;
      return (
        isRecord(input) &&
        typeof input["labelId"] === "string" &&
        (input["color"] === null || typeof input["color"] === "string")
      );
    },
    invalidError: "Invalid label color",
  },
  "volli:app-state-set": {
    guard: (args): args is IpcArgs<"volli:app-state-set"> =>
      args.length === 2 && args.every((entry) => typeof entry === "string"),
    invalidError: "Invalid app state",
  },

  "volli:worktree-remove": {
    guard: (args): args is IpcArgs<"volli:worktree-remove"> => {
      if (args.length !== 1) return false;
      const [input] = args;
      return (
        isRecord(input) &&
        typeof input["ticketId"] === "string" &&
        typeof input["force"] === "boolean"
      );
    },
    invalidError: "Invalid worktree removal",
  },
  "volli:worktree-branches": {
    guard: (args): args is IpcArgs<"volli:worktree-branches"> =>
      args.length === 1 && isProjectIdInput(args[0]),
    invalidError: "Invalid project",
  },
  "volli:worktree-orphans": {
    // `opts` is optional on the wire (the existing desktop test suite invokes
    // this with no argument at all) — both `[]` and `[{ rescan? }]` are valid;
    // only a present-but-non-boolean `rescan`, or a non-object first arg, rejects.
    guard: (args): args is IpcArgs<"volli:worktree-orphans"> => {
      if (args.length === 0) return true;
      if (args.length !== 1) return false;
      const [input] = args;
      return (
        isRecord(input) && (input["rescan"] === undefined || typeof input["rescan"] === "boolean")
      );
    },
    invalidError: "Invalid request",
  },
  "volli:worktree-orphan-delete": {
    guard: (args): args is IpcArgs<"volli:worktree-orphan-delete"> => {
      if (args.length !== 1) return false;
      const [input] = args;
      return isRecord(input) && typeof input["path"] === "string" && input["path"].length > 0;
    },
    invalidError: "Invalid orphan path",
  },

  "volli:worktree-status": {
    guard: (args): args is IpcArgs<"volli:worktree-status"> =>
      args.length === 1 && isTicketIdInput(args[0]),
    invalidError: "Invalid ticket",
  },
  "volli:worktree-diff": {
    guard: (args): args is IpcArgs<"volli:worktree-diff"> => {
      if (args.length !== 1) return false;
      const [input] = args;
      return (
        isRecord(input) &&
        typeof input["ticketId"] === "string" &&
        (input["mode"] === "working-tree" || input["mode"] === "merge-base")
      );
    },
    invalidError: "Invalid worktree diff request",
  },
  "volli:worktree-commit": {
    guard: (args): args is IpcArgs<"volli:worktree-commit"> =>
      args.length === 1 && isTicketIdInput(args[0]),
    invalidError: "Invalid ticket",
  },
  "volli:worktree-push-pr": {
    guard: (args): args is IpcArgs<"volli:worktree-push-pr"> =>
      args.length === 1 && isTicketIdInput(args[0]),
    invalidError: "Invalid ticket",
  },

  "volli:retention-state": {
    guard: (args): args is IpcArgs<"volli:retention-state"> =>
      args.length === 1 && isTicketIdInput(args[0]),
    invalidError: "Invalid ticket",
  },
  "volli:retention-keep": {
    guard: (args): args is IpcArgs<"volli:retention-keep"> => {
      if (args.length !== 1) return false;
      const [input] = args;
      return (
        isRecord(input) &&
        typeof input["ticketId"] === "string" &&
        typeof input["keep"] === "boolean"
      );
    },
    invalidError: "Invalid keep request",
  },
  "volli:retention-dismiss": {
    guard: (args): args is IpcArgs<"volli:retention-dismiss"> =>
      args.length === 1 && isTicketIdInput(args[0]),
    invalidError: "Invalid ticket",
  },
  "volli:retention-archive-clean": {
    guard: (args): args is IpcArgs<"volli:retention-archive-clean"> =>
      args.length === 1 && isTicketIdInput(args[0]),
    invalidError: "Invalid ticket",
  },
  "volli:retention-ttl-get": {
    guard: (args): args is [] => args.length === 0,
    invalidError: "Invalid request",
  },
  "volli:retention-ttl-set": {
    guard: (args): args is IpcArgs<"volli:retention-ttl-set"> => {
      if (args.length !== 1) return false;
      const [input] = args;
      return isRecord(input) && typeof input["days"] === "number" && Number.isFinite(input["days"]);
    },
    invalidError: "Invalid TTL",
  },
  "volli:retention-poll": {
    guard: (args): args is [] => args.length === 0,
    invalidError: "Invalid request",
  },
};

/** Every channel the data-IPC surface owns, derived — never hand-synced. */
export const DATA_CHANNELS = Object.keys(DATA_IPC) as readonly DataIpcChannel[];

// ---- file-IPC descriptor table ------------------------------------------
// Exactly one entry per VolliFileIpcContract channel (the 7 file/artifact
// channels `src/main/volli-fs.ts` owns). Every one of that module's handlers
// falls back to the same "Invalid request" string on a bad shape.

/** The `{ projectId, ticketId?, relPath }` shape shared by read/reveal/watch/unwatch. */
function isFilePathInput(
  value: unknown,
): value is { projectId: string; ticketId?: string; relPath: string } {
  if (!isRecord(value)) return false;
  if (typeof value["projectId"] !== "string" || typeof value["relPath"] !== "string") return false;
  return value["ticketId"] === undefined || typeof value["ticketId"] === "string";
}

/**
 * The dir-watch shape. `relPath` is accepted EMPTY here (the project root) —
 * main runs the containment check, which rejects every other unsafe spelling.
 */
function isDirPathInput(value: unknown): value is { projectId: string; relPath: string } {
  return (
    isRecord(value) &&
    typeof value["projectId"] === "string" &&
    typeof value["relPath"] === "string"
  );
}

export const FILE_IPC: { readonly [C in FileIpcChannel]: IpcRequestDescriptor<C> } = {
  "volli:file-index": {
    guard: (args): args is IpcArgs<"volli:file-index"> =>
      args.length === 1 && isProjectIdInput(args[0]),
    invalidError: "Invalid request",
  },
  "volli:file-read": {
    guard: (args): args is IpcArgs<"volli:file-read"> =>
      args.length === 1 && isFilePathInput(args[0]),
    invalidError: "Invalid request",
  },
  "volli:file-write": {
    guard: (args): args is IpcArgs<"volli:file-write"> => {
      if (args.length !== 1 || !isFilePathInput(args[0])) return false;
      const input = args[0] as Record<string, unknown>;
      if (typeof input["content"] !== "string") return false;
      return input["expectedMtime"] === undefined || typeof input["expectedMtime"] === "number";
    },
    invalidError: "Invalid request",
  },
  "volli:artifact-create": {
    guard: (args): args is IpcArgs<"volli:artifact-create"> => {
      if (args.length !== 1) return false;
      const [input] = args;
      return (
        isRecord(input) &&
        typeof input["projectId"] === "string" &&
        typeof input["name"] === "string"
      );
    },
    invalidError: "Invalid request",
  },
  "volli:file-reveal": {
    guard: (args): args is IpcArgs<"volli:file-reveal"> =>
      args.length === 1 && isFilePathInput(args[0]),
    invalidError: "Invalid request",
  },
  "volli:file-watch": {
    guard: (args): args is IpcArgs<"volli:file-watch"> =>
      args.length === 1 && isFilePathInput(args[0]),
    invalidError: "Invalid request",
  },
  "volli:file-unwatch": {
    guard: (args): args is IpcArgs<"volli:file-unwatch"> =>
      args.length === 1 && isFilePathInput(args[0]),
    invalidError: "Invalid request",
  },
  "volli:dir-watch": {
    guard: (args): args is IpcArgs<"volli:dir-watch"> =>
      args.length === 1 && isDirPathInput(args[0]),
    invalidError: "Invalid request",
  },
  "volli:dir-unwatch": {
    guard: (args): args is IpcArgs<"volli:dir-unwatch"> =>
      args.length === 1 && isDirPathInput(args[0]),
    invalidError: "Invalid request",
  },
};

/** Every channel the file-IPC surface owns, derived — never hand-synced. */
export const FILE_CHANNELS = Object.keys(FILE_IPC) as readonly FileIpcChannel[];
