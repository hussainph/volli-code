// Runtime half of the IPC request contract (issue #98). The type half is
// ../ipc/contract.ts, which all three desktop processes may `import type` from.
//
// This is the half with values in it, and living in src/main/ is what keeps
// "runtime-importable by MAIN ONLY" true: main is the only entry whose module
// graph reaches this directory, so the rule is structural now rather than
// written down and hoped for. The preload stays type-only either way (the pack
// config keeps main and preload dependency-disjoint; see CAUTION in
// apps/desktop/vite.config.ts).

import {
  isAppearance,
  isHarnessTrustVerdict,
  isSkillName,
  isWritablePromptTemplateName,
  REASONING_LEVELS,
  isHexColor,
  isProjectThemeOverride,
  isTicketPriority,
  isTicketStatus,
  isValidBranchName,
  isValidOverlayKey,
  isValidOverlayValue,
  parseCanvas,
  parseHarnessId,
} from "@volli/shared";

import { isExternalAppId } from "./external-apps";
import type {
  AgentObservabilityIpcChannel,
  AutomationIpcChannel,
  CliIpcChannel,
  DataIpcChannel,
  FileIpcChannel,
  HarnessIpcChannel,
  IpcArgs,
  ModelAccessIpcChannel,
  ThemeIpcChannel,
  WebAccessIpcChannel,
  UpdateIpcChannel,
  VolliInvokeContract,
} from "../ipc/contract";

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
// the vocab constants they guard (isTicketStatus/isTicketPriority/parseHarnessId),
// imported above; isValidBranchName lives next to the branch-naming rules.

/**
 * The usage scope's four arms, checked structurally.
 *
 * Written out rather than accepting any record with a `kind`, because this is
 * the boundary where a renderer's word becomes a database predicate: an
 * unrecognised arm must be rejected here rather than fall through the ledger's
 * switch and read a scope nobody asked for.
 */
function isUsageScope(value: unknown): boolean {
  if (!isRecord(value)) return false;
  switch (value["kind"]) {
    case "all":
      return true;
    case "project":
      return typeof value["projectId"] === "string";
    case "ticket":
      return typeof value["ticketId"] === "string";
    case "session":
      return typeof value["sessionId"] === "string";
    default:
      return false;
  }
}

function isOptionalFiniteNumber(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Whether `value` is a well-formed harness id — a built-in, or a slug a
 * manifest could legally be registered under.
 *
 * A shape guard, deliberately, and the ONLY kind this module could honestly
 * offer: whether a slug names a harness the user actually registered and
 * trusted is a fact about their disk and their verdicts, which this package
 * cannot see and by design never will. It gates the field it appears on — a
 * ticket's persisted harness PREFERENCE — and nothing else. Trust is checked
 * where it can be: at the launch door in main (`pty/ipc.ts`), against the
 * adapters that launch actually resolved. A preference naming a harness that
 * is not (or is no longer) trusted therefore stores fine and simply never
 * launches, which is the right way round: a verdict is revocable, and a
 * revoked one must not have to reach back into rows written before it.
 */
function isHarnessIdShape(value: unknown): boolean {
  return typeof value === "string" && parseHarnessId(value) !== null;
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

/** An absent key and a string key both pass; anything else is a malformed payload. */
function isOptionalString(input: Record<string, unknown>, key: string): boolean {
  return input[key] === undefined || typeof input[key] === "string";
}

/**
 * Exactly one attachment owner (VC-50), mirroring the `blob_links` CHECK that
 * enforces the same thing durably. `unowned` is the new-Ticket composer, whose
 * Ticket has no id yet.
 */
function isBlobOwner(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (typeof value["ticketId"] === "string") return true;
  if (typeof value["sessionId"] === "string") return true;
  return value["unowned"] === true;
}

/** The `{ projectId }` shape shared by every single-project-scoped channel. */
function isProjectIdInput(value: unknown): value is { projectId: string } {
  return isRecord(value) && typeof value["projectId"] === "string";
}

/**
 * A commit message's cap. Generous enough that no message a person writes in
 * the rail's field can hit it, small enough that the string stays far below the
 * argv budget `execFile` spends it against (~256 KiB on macOS, shared with the
 * rest of the command line).
 */
const MAX_COMMIT_MESSAGE_LENGTH = 5000;

/**
 * Whether `value` is a commit message main will hand to `git commit -m`.
 *
 * The same rigour `isValidBranchName` applies to a branch, for the same reason:
 * this is user text going to git. It is NOT the same rule set, though, because
 * a commit message is prose, not a ref — blank is legal here (it means "generate
 * one", resolved in main), and so are newlines and tabs, which a multi-line
 * message needs. What is rejected is the rest of C0 and DEL: a NUL cannot cross
 * an argv boundary at all, and the others are invisible junk that would be
 * entombed verbatim in a commit nobody can rewrite. Leading `-` needs no guard —
 * the string is the value of `-m`, never a word git could read as a flag, and
 * the runner is args-array with no shell.
 */
function isCommitMessage(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (value.length > MAX_COMMIT_MESSAGE_LENGTH) return false;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 0x09 || code === 0x0a || code === 0x0d) continue;
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
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
  "volli:database": {
    guard: (args): args is IpcArgs<"volli:database"> =>
      args.length === 0 || (args.length === 1 && (args[0] === "reveal" || args[0] === "export")),
    invalidError: "Invalid database request",
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
  "volli:project-skill-modes": {
    guard: (args): args is IpcArgs<"volli:project-skill-modes"> => {
      if (args.length !== 1) return false;
      const [input] = args;
      if (!isRecord(input) || typeof input["id"] !== "string") return false;
      const modes = input["modes"];
      if (!isRecord(modes)) return false;
      // `auto` is deliberately NOT on the wire: it is the absence of a rule,
      // and accepting it would let the renderer store a value that reads the
      // same as no value (see `parseSkillModes`).
      return Object.entries(modes).every(
        ([slug, mode]) => isSkillName(slug) && (mode === "manual" || mode === "off"),
      );
    },
    invalidError: "Invalid skill rules",
  },
  "volli:project-session-defaults": {
    guard: (args): args is IpcArgs<"volli:project-session-defaults"> => {
      if (args.length !== 1) return false;
      const [input] = args;
      if (!isRecord(input) || typeof input["id"] !== "string") return false;
      const harness = input["harness"];
      if (harness !== null && typeof harness !== "string") return false;
      const model = input["model"];
      if (model === null) return true;
      return (
        isRecord(model) &&
        typeof model["providerId"] === "string" &&
        typeof model["modelId"] === "string" &&
        REASONING_LEVELS.some((level) => level === model["reasoningLevel"])
      );
    },
    invalidError: "Invalid session defaults",
  },
  "volli:project-authority-policy": {
    /**
     * Shape only — an id and a slot that is an object or `null`. The document
     * itself is judged by `validateAuthorityPolicyOverride` in the handler,
     * NOT here, and the split is deliberate: a guard can only refuse, and a
     * refused policy write has to come back saying which field was wrong. A
     * duplicate structural check here would be a second validator to keep in
     * agreement with the first, which is how the two drift apart.
     */
    guard: (args): args is IpcArgs<"volli:project-authority-policy"> => {
      if (args.length !== 1) return false;
      const [input] = args;
      if (!isRecord(input) || typeof input["id"] !== "string") return false;
      const override = input["override"];
      // `isRecord` admits an array (`typeof [] === "object"`), and an array is
      // not a policy document. The handler's validator refuses one too, so this
      // is the cheap half of a check that exists on both sides.
      return override === null || (isRecord(override) && !Array.isArray(override));
    },
    invalidError: "Invalid authority policy",
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
        (input["preferredHarnessId"] === undefined ||
          isHarnessIdShape(input["preferredHarnessId"])) &&
        // Shape only — the NAME is validated by `createTicketCommand`, which is
        // the one gate both doors (socket and IPC) share.
        (input["baseBranch"] === undefined ||
          input["baseBranch"] === null ||
          typeof input["baseBranch"] === "string")
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
        isOptionalNullableString(input["baseBranch"]) &&
        (input["usesWorktree"] === undefined || typeof input["usesWorktree"] === "boolean")
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
  "volli:ticket-status-entries": {
    guard: (args): args is IpcArgs<"volli:ticket-status-entries"> =>
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

  "volli:blob-attach": {
    guard: (args): args is IpcArgs<"volli:blob-attach"> => {
      if (args.length !== 1) return false;
      const [input] = args;
      if (!isRecord(input)) return false;
      if (typeof input["fileName"] !== "string" || input["fileName"].trim().length === 0) {
        return false;
      }
      // Bytes or a path — with neither there is nothing to attach, and the
      // handler would have to invent a failure further in.
      const hasBytes = input["bytes"] instanceof Uint8Array;
      const hasPath = typeof input["sourcePath"] === "string";
      if (!hasBytes && !hasPath) return false;
      return (
        isBlobOwner(input["owner"]) &&
        isOptionalString(input, "mime") &&
        isOptionalString(input, "label") &&
        isOptionalString(input, "refRoot")
      );
    },
    invalidError: "Invalid attachment",
  },
  "volli:blob-list": {
    guard: (args): args is IpcArgs<"volli:blob-list"> => {
      if (args.length !== 1) return false;
      const [input] = args;
      return (
        isRecord(input) &&
        isOptionalString(input, "ticketId") &&
        isOptionalString(input, "sessionId")
      );
    },
    invalidError: "Invalid attachment owner",
  },
  "volli:blob-remove": {
    guard: (args): args is IpcArgs<"volli:blob-remove"> =>
      args.length === 1 && isRecord(args[0]) && typeof args[0]["linkId"] === "string",
    invalidError: "Invalid attachment",
  },
  "volli:blob-link-drafts": {
    guard: (args): args is IpcArgs<"volli:blob-link-drafts"> => {
      if (args.length !== 1) return false;
      const [input] = args;
      if (!isRecord(input) || typeof input["ticketId"] !== "string") return false;
      const blobs = input["blobs"];
      return (
        Array.isArray(blobs) &&
        blobs.every(
          (entry) =>
            isRecord(entry) &&
            typeof entry["blobHash"] === "string" &&
            isOptionalString(entry, "label"),
        )
      );
    },
    invalidError: "Invalid attachment drafts",
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
  "volli:session-starts": {
    guard: (args): args is IpcArgs<"volli:session-starts"> =>
      args.length === 1 &&
      isRecord(args[0]) &&
      typeof args[0]["sinceMs"] === "number" &&
      Number.isFinite(args[0]["sinceMs"]),
    invalidError: "Invalid session window",
  },
  "volli:usage-report": {
    guard: (args): args is IpcArgs<"volli:usage-report"> => {
      if (args.length !== 1) return false;
      const [input] = args;
      if (!isRecord(input)) return false;
      if (!isUsageScope(input["scope"])) return false;
      // Absent is legal for all three; present must be usable. A NaN bound
      // would otherwise reach SQLite as a comparison that silently matches
      // nothing, and the surface would draw an empty report as if it were a
      // measured zero.
      if (!isOptionalFiniteNumber(input["sinceMs"])) return false;
      if (!isOptionalFiniteNumber(input["untilMs"])) return false;
      const groupBy = input["groupBy"];
      return (
        groupBy === undefined ||
        groupBy === "ticket" ||
        groupBy === "session" ||
        groupBy === "model" ||
        groupBy === "day"
      );
    },
    invalidError: "Invalid usage query",
  },
  "volli:venue-snapshot": {
    guard: (args): args is IpcArgs<"volli:venue-snapshot"> => {
      if (args.length !== 1) return false;
      const [input] = args;
      if (!isRecord(input) || typeof input["projectId"] !== "string") return false;
      // `ticketId: null` is the Project-Session arm and must pass; `undefined`
      // must not — a caller that forgot the key is asking a different question
      // from one that said "no ticket".
      return input["ticketId"] === null || typeof input["ticketId"] === "string";
    },
    invalidError: "Invalid venue",
  },
  "volli:session-rename": {
    guard: (args): args is IpcArgs<"volli:session-rename"> => {
      if (args.length !== 1) return false;
      const [input] = args;
      if (!isRecord(input)) return false;
      if (typeof input["sessionId"] !== "string") return false;
      if (typeof input["title"] !== "string" || input["title"].trim().length === 0) return false;
      // The optional auto-title rider (VC-81): absent on a person's rename, a
      // non-blank first message on the heuristic one.
      const refineFrom = input["refineFrom"];
      return (
        refineFrom === undefined || (typeof refineFrom === "string" && refineFrom.trim().length > 0)
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
  "volli:worktree-recreate": {
    guard: (args): args is IpcArgs<"volli:worktree-recreate"> =>
      args.length === 1 && isTicketIdInput(args[0]),
    invalidError: "Invalid ticket",
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
  "volli:worktree-change-set": {
    guard: (args): args is IpcArgs<"volli:worktree-change-set"> =>
      args.length === 1 && isTicketIdInput(args[0]),
    invalidError: "Invalid ticket",
  },
  "volli:worktree-base-read": {
    guard: (args): args is IpcArgs<"volli:worktree-base-read"> => {
      if (args.length !== 1) return false;
      const [input] = args;
      return (
        isRecord(input) &&
        typeof input["ticketId"] === "string" &&
        typeof input["path"] === "string" &&
        (input["baseRevision"] === undefined || typeof input["baseRevision"] === "string")
      );
    },
    invalidError: "Invalid worktree base read request",
  },
  "volli:worktree-change-watch": {
    guard: (args): args is IpcArgs<"volli:worktree-change-watch"> =>
      args.length === 1 && isTicketIdInput(args[0]),
    invalidError: "Invalid ticket",
  },
  "volli:worktree-change-unwatch": {
    guard: (args): args is IpcArgs<"volli:worktree-change-unwatch"> =>
      args.length === 1 && isTicketIdInput(args[0]),
    invalidError: "Invalid ticket",
  },
  "volli:worktree-commit": {
    guard: (args): args is IpcArgs<"volli:worktree-commit"> => {
      if (args.length !== 1) return false;
      const [input] = args;
      if (!isRecord(input) || typeof input["ticketId"] !== "string") return false;
      // Both optional, both defaulted in main to the pre-field behaviour, so an
      // old `{ ticketId }` payload still passes here unchanged.
      return (
        (input["message"] === undefined || isCommitMessage(input["message"])) &&
        (input["includeUnstaged"] === undefined || typeof input["includeUnstaged"] === "boolean")
      );
    },
    invalidError: "Invalid commit request",
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
// Exactly one entry per VolliFileIpcContract channel (the file, artifact, and
// external-app channels `src/main/volli-fs.ts` owns). Every one of that module's
// handlers falls back to the same "Invalid request" string on a bad shape.

/**
 * The `{ projectId, ticketId? }` scope pair the file index is listed for
 * (VC-190) — {@link isFilePathInput} minus the path. An absent `ticketId` means
 * the project's main checkout; a present one means that ticket's worktree, and
 * main re-checks the pair against the db before it resolves anything.
 */
function isFileIndexInput(value: unknown): value is { projectId: string; ticketId?: string } {
  if (!isRecord(value)) return false;
  if (typeof value["projectId"] !== "string") return false;
  return value["ticketId"] === undefined || typeof value["ticketId"] === "string";
}

/** The `{ projectId, ticketId?, relPath }` shape shared by read/reveal/watch/unwatch. */
function isFilePathInput(
  value: unknown,
): value is { projectId: string; ticketId?: string; relPath: string } {
  return isRecord(value) && typeof value["relPath"] === "string" && isFileIndexInput(value);
}

/**
 * The search shape (plan §4.7): the index's scope pair plus the literal text.
 * Only its TYPE is judged here — an empty or whitespace-only query is a request
 * main answers with an empty result rather than a malformed-request refusal,
 * because it is what a Search page holds every time it is opened.
 */
function isFileSearchInput(value: unknown): boolean {
  return isRecord(value) && typeof value["query"] === "string" && isFileIndexInput(value);
}

/**
 * The rename shape: the file-path input plus the destination path (VC-191).
 * Both are checked as strings HERE; whether either is a safe relative path, and
 * whether the two resolve against the same checkout, is main's two-layer job.
 */
function isFileRenameInput(value: unknown): boolean {
  return isRecord(value) && typeof value["toRelPath"] === "string" && isFilePathInput(value);
}

/** The file-path shape plus one closed app id — callers never name a bundle or command. */
function isExternalAppOpenFileInput(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const appId = value["appId"];
  return isFilePathInput(value) && isExternalAppId(appId);
}

/** The closed app id plus the two ids that name a ticket's worktree. */
function isExternalAppOpenWorktreeInput(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value["projectId"] === "string" &&
    typeof value["ticketId"] === "string" &&
    isExternalAppId(value["appId"])
  );
}

/** The project/ticket pair needed to resolve a worktree root without trusting a path from renderer. */
function isWorktreeRevealInput(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value["projectId"] === "string" &&
    typeof value["ticketId"] === "string"
  );
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
      args.length === 1 && isFileIndexInput(args[0]),
    invalidError: "Invalid request",
  },
  "volli:file-read": {
    guard: (args): args is IpcArgs<"volli:file-read"> =>
      args.length === 1 && isFilePathInput(args[0]),
    invalidError: "Invalid request",
  },
  "volli:search": {
    guard: (args): args is IpcArgs<"volli:search"> =>
      args.length === 1 && isFileSearchInput(args[0]),
    invalidError: "Invalid request",
  },
  "volli:external-app-list": {
    guard: (args): args is [] => args.length === 0,
    invalidError: "Invalid request",
  },
  "volli:external-app-open-file": {
    guard: (args): args is IpcArgs<"volli:external-app-open-file"> =>
      args.length === 1 && isExternalAppOpenFileInput(args[0]),
    invalidError: "Invalid request",
  },
  "volli:external-app-open-worktree": {
    guard: (args): args is IpcArgs<"volli:external-app-open-worktree"> =>
      args.length === 1 && isExternalAppOpenWorktreeInput(args[0]),
    invalidError: "Invalid request",
  },
  "volli:worktree-reveal": {
    guard: (args): args is IpcArgs<"volli:worktree-reveal"> =>
      args.length === 1 && isWorktreeRevealInput(args[0]),
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
  // The creation track (plan §4.5). Four of the five carry nothing beyond the
  // scoped path the read channels already take; only rename names a second one.
  "volli:file-create": {
    guard: (args): args is IpcArgs<"volli:file-create"> =>
      args.length === 1 && isFilePathInput(args[0]),
    invalidError: "Invalid request",
  },
  "volli:dir-create": {
    guard: (args): args is IpcArgs<"volli:dir-create"> =>
      args.length === 1 && isFilePathInput(args[0]),
    invalidError: "Invalid request",
  },
  "volli:file-rename": {
    guard: (args): args is IpcArgs<"volli:file-rename"> =>
      args.length === 1 && isFileRenameInput(args[0]),
    invalidError: "Invalid request",
  },
  "volli:file-duplicate": {
    guard: (args): args is IpcArgs<"volli:file-duplicate"> =>
      args.length === 1 && isFilePathInput(args[0]),
    invalidError: "Invalid request",
  },
  "volli:file-delete": {
    guard: (args): args is IpcArgs<"volli:file-delete"> =>
      args.length === 1 && isFilePathInput(args[0]),
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
  "volli:prompt-template-create": {
    guard: (args): args is IpcArgs<"volli:prompt-template-create"> => {
      if (args.length !== 1) return false;
      const [input] = args;
      return (
        isRecord(input) &&
        typeof input["projectId"] === "string" &&
        (input["scope"] === "project" || input["scope"] === "personal") &&
        typeof input["name"] === "string" &&
        // The narrow writable grammar, checked at the boundary as well as in
        // the writer: the name becomes a filename, so this is the door where
        // a traversal attempt has to stop.
        isWritablePromptTemplateName(input["name"]) &&
        typeof input["description"] === "string" &&
        typeof input["body"] === "string"
      );
    },
    invalidError: "Invalid command",
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
  "volli:prompt-templates": {
    guard: (args): args is IpcArgs<"volli:prompt-templates"> => {
      if (args.length !== 1 || !isProjectIdInput(args[0])) return false;
      const ruled = (args[0] as Record<string, unknown>)["ruled"];
      return ruled === undefined || typeof ruled === "boolean";
    },
    invalidError: "Invalid request",
  },
};

/** Every channel the file-IPC surface owns, derived — never hand-synced. */
export const FILE_CHANNELS = Object.keys(FILE_IPC) as readonly FileIpcChannel[];

// ---- theme-IPC descriptor table ------------------------------------------
// Exactly one entry per VolliThemeIpcContract channel (the channels
// `src/main/theme-ipc.ts` owns). The per-surface override guard lives next to
// the shape it enforces (`theme/project-override.ts`), imported above.

/**
 * Whether every value is a string or null — the overlay edit-set shape (`null`
 * removes the key) — AND every key/value is one `applyOverlayEdits` will
 * actually write. The character rule is imported, not restated, so the IPC
 * boundary cannot drift from the writer it guards: an edit that would inject a
 * second ghostty directive (`command = …` sets the program the terminal runs)
 * is refused here, before main runs, as well as there.
 */
function isOverlayEdits(value: unknown): value is Record<string, string | null> {
  return (
    isRecord(value) &&
    !Array.isArray(value) &&
    Object.entries(value).every(
      ([key, entry]) =>
        isValidOverlayKey(key) &&
        (entry === null || (typeof entry === "string" && isValidOverlayValue(entry))),
    )
  );
}

/**
 * The optional `projectId` that names the scope a theme request is MADE FROM.
 * Absent is the global scope; a project id asks for that project's resolution.
 * Shared by the read and by the global writes, which answer in the caller's
 * scope rather than the one they wrote to (#123).
 */
function isCallerScope(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

export const THEME_IPC: { readonly [C in ThemeIpcChannel]: IpcRequestDescriptor<C> } = {
  "volli:theme-state": {
    guard: (args): args is IpcArgs<"volli:theme-state"> => {
      if (args.length !== 1) return false;
      const [input] = args;
      return isRecord(input) && isCallerScope(input["projectId"]);
    },
    invalidError: "Invalid theme request",
  },
  "volli:theme-set-project": {
    guard: (args): args is IpcArgs<"volli:theme-set-project"> => {
      if (args.length !== 1) return false;
      const [input] = args;
      if (!isRecord(input) || typeof input["projectId"] !== "string") return false;
      return input["override"] === null || isProjectThemeOverride(input["override"]);
    },
    invalidError: "Invalid project theme override",
  },
  // ── the canvas writes (migration 014) ──────────────────────────────────
  // Every one of these is a WRITE with no read twin: the stored state rides
  // `volli:data-bootstrap` back to the renderer, so there is nothing to answer
  // with beyond the authoritative row a project write already returns.
  "volli:theme-canvas-set-global": {
    guard: (args): args is IpcArgs<"volli:theme-canvas-set-global"> =>
      args.length === 1 && isRecord(args[0]) && parseCanvas(args[0]["canvas"]) !== null,
    invalidError: "Invalid canvas",
  },
  "volli:theme-appearance-set-global": {
    guard: (args): args is IpcArgs<"volli:theme-appearance-set-global"> =>
      args.length === 1 && isRecord(args[0]) && isAppearance(args[0]["appearance"]),
    invalidError: "Invalid appearance",
  },
  "volli:theme-canvas-set-project": {
    guard: (args): args is IpcArgs<"volli:theme-canvas-set-project"> => {
      if (args.length !== 1) return false;
      const [input] = args;
      if (!isRecord(input) || typeof input["projectId"] !== "string") return false;
      return input["canvas"] === null || parseCanvas(input["canvas"]) !== null;
    },
    invalidError: "Invalid canvas",
  },
  "volli:theme-appearance-set-project": {
    guard: (args): args is IpcArgs<"volli:theme-appearance-set-project"> => {
      if (args.length !== 1) return false;
      const [input] = args;
      if (!isRecord(input) || typeof input["projectId"] !== "string") return false;
      return input["appearance"] === null || isAppearance(input["appearance"]);
    },
    invalidError: "Invalid appearance",
  },
  // `auto` is NOT accepted here: the hint records what the renderer RESOLVED,
  // and an unresolved mode is exactly the value main cannot act on at window
  // construction — the one thing this row exists to make possible.
  "volli:theme-first-paint-set": {
    guard: (args): args is IpcArgs<"volli:theme-first-paint-set"> => {
      if (args.length !== 1) return false;
      const [input] = args;
      if (!isRecord(input)) return false;
      if (input["appearance"] !== "light" && input["appearance"] !== "dark") return false;
      return typeof input["background"] === "string" && isHexColor(input["background"]);
    },
    invalidError: "Invalid first-paint hint",
  },
  // The renderer names a SCOPE, never a path — so the "Volli never writes the
  // user's own ghostty config" invariant (#67) holds at the IPC boundary as
  // well as at the write path, rather than relying on the guard alone.
  "volli:theme-terminal-overlay-write": {
    guard: (args): args is IpcArgs<"volli:theme-terminal-overlay-write"> => {
      if (args.length !== 1) return false;
      const [input] = args;
      if (!isRecord(input) || !isOverlayEdits(input["edits"])) return false;
      if (input["scope"] === "global") return true;
      return input["scope"] === "project" && typeof input["projectId"] === "string";
    },
    invalidError: "Invalid terminal overlay write",
  },
};

/** Every channel the theme-IPC surface owns, derived — never hand-synced. */
export const THEME_CHANNELS = Object.keys(THEME_IPC) as readonly ThemeIpcChannel[];

// ---- automations descriptor table (VC-126) ---------------------------------

/**
 * A stored-shape guard for a Runtime pin: the exact `ModelSelection` fields
 * and a reasoning level from Volli's own scale. Whether the pair is one the
 * catalog can actually run is judged in the handler against Model Access —
 * that is a fact about accounts, not about the request's shape.
 */
function isModelSelectionShape(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value["providerId"] === "string" &&
    value["providerId"].length > 0 &&
    typeof value["modelId"] === "string" &&
    value["modelId"].length > 0 &&
    (REASONING_LEVELS as readonly unknown[]).includes(value["reasoningLevel"])
  );
}

/**
 * Automation commands are durable retry identities, not an IPC-local counter.
 * The renderer mints UUIDs, so a retry can carry the exact same intent through
 * another host without deriving an id from this machine.
 */
function isAutomationCommandId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

/**
 * A transported Trigger's shape (VC-128, widened for VC-130's schedule). Only
 * the wire grammar is judged here — which column names are real, whether a zone
 * is one this build's ICU knows, and whether either collapses to "Nothing
 * else", is the shared parser's job on the way into the record, so this guard
 * never has to be kept in step with the board's columns or with the tz database.
 *
 * A MISSING Trigger is refused rather than read as the default. "Nothing else"
 * has its own union member (`{ kind: "none" }`) precisely so the default is a
 * value a JSON transport can carry, and a door that also accepted absence would
 * be the second spelling docs/BOUNDARIES.md rule 3 exists to prevent.
 */
function isAutomationTriggerShape(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value["kind"] === "none") return true;
  if (value["kind"] === "schedule") return isRecord(value["schedule"]);
  return value["kind"] === "columns" && Array.isArray(value["columns"]);
}

/** What a Run names: a saved Automation, or an Unbound Run's own Instructions. */
function isAutomationRunTargetShape(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value["kind"] === "automation") return typeof value["automationId"] === "string";
  if (value["kind"] === "unbound") return typeof value["instructions"] === "string";
  return false;
}

/** The editable fields every automation write carries, shape-checked once. */
function isAutomationDraftShape(value: Record<string, unknown>): boolean {
  return (
    typeof value["name"] === "string" &&
    typeof value["instructions"] === "string" &&
    isAutomationTriggerShape(value["trigger"]) &&
    (value["runtime"] === null || isModelSelectionShape(value["runtime"]))
  );
}

export const AUTOMATION_IPC: { readonly [C in AutomationIpcChannel]: IpcRequestDescriptor<C> } = {
  "volli:automation-list": {
    guard: (args): args is IpcArgs<"volli:automation-list"> =>
      args.length === 1 && isRecord(args[0]) && typeof args[0]["projectId"] === "string",
    invalidError: "Invalid automation list request",
  },
  "volli:automation-create": {
    guard: (args): args is IpcArgs<"volli:automation-create"> => {
      if (args.length !== 1) return false;
      const [input] = args;
      if (!isRecord(input) || !isAutomationCommandId(input["commandId"])) return false;
      const projectId = input["projectId"];
      if (projectId !== null && typeof projectId !== "string") return false;
      return isAutomationDraftShape(input);
    },
    invalidError: "Invalid automation",
  },
  "volli:automation-update": {
    guard: (args): args is IpcArgs<"volli:automation-update"> => {
      if (args.length !== 1) return false;
      const [input] = args;
      if (
        !isRecord(input) ||
        !isAutomationCommandId(input["commandId"]) ||
        typeof input["automationId"] !== "string"
      ) {
        return false;
      }
      return isAutomationDraftShape(input);
    },
    invalidError: "Invalid automation",
  },
  "volli:automation-delete": {
    guard: (args): args is IpcArgs<"volli:automation-delete"> =>
      args.length === 1 &&
      isRecord(args[0]) &&
      isAutomationCommandId(args[0]["commandId"]) &&
      typeof args[0]["automationId"] === "string",
    invalidError: "Invalid automation delete request",
  },
  "volli:automation-run": {
    // The target is a union at the door, not a nullable id: a request naming an
    // Automation and a request carrying its own Instructions (VC-129) are two
    // shapes, and one that is somehow both never reaches the runner. Wire SHAPE
    // only, as ever — whether the Instructions say anything is the domain's own
    // rule (`unboundRunProblem`), stated once and re-checked by main.
    guard: (args): args is IpcArgs<"volli:automation-run"> =>
      args.length === 1 &&
      isRecord(args[0]) &&
      isAutomationCommandId(args[0]["commandId"]) &&
      isAutomationRunTargetShape(args[0]["target"]) &&
      typeof args[0]["ticketId"] === "string" &&
      (args[0]["modelOverride"] === null || isModelSelectionShape(args[0]["modelOverride"])),
    invalidError: "Invalid automation run request",
  },
  "volli:automation-runs-for-ticket": {
    guard: (args): args is IpcArgs<"volli:automation-runs-for-ticket"> =>
      args.length === 1 && isRecord(args[0]) && typeof args[0]["ticketId"] === "string",
    invalidError: "Invalid automation runs request",
  },
  "volli:automation-arming-list": {
    guard: (args): args is IpcArgs<"volli:automation-arming-list"> =>
      args.length === 1 && isRecord(args[0]) && typeof args[0]["projectId"] === "string",
    invalidError: "Invalid automation arming request",
  },
  "volli:automation-arm": {
    // A `commandId` like every other automation write: the PROJECTION is
    // machine-local (`db/automations-repo.ts`), the INTENT is a durable command
    // with an event and a receipt (docs/BOUNDARIES.md rule 5). `automationId:
    // null` is disarm, and the status is checked against the board's own
    // vocabulary here because it is half of the row's primary key.
    guard: (args): args is IpcArgs<"volli:automation-arm"> =>
      args.length === 1 &&
      isRecord(args[0]) &&
      isAutomationCommandId(args[0]["commandId"]) &&
      typeof args[0]["projectId"] === "string" &&
      isTicketStatus(args[0]["status"]) &&
      (args[0]["automationId"] === null || typeof args[0]["automationId"] === "string"),
    invalidError: "Invalid automation arm request",
  },
  "volli:automation-column-order-list": {
    guard: (args): args is IpcArgs<"volli:automation-column-order-list"> =>
      args.length === 1 && isRecord(args[0]) && typeof args[0]["projectId"] === "string",
    invalidError: "Invalid automation order request",
  },
  "volli:automation-set-column-order": {
    // A `commandId` like every other write: the PROJECTION is machine-local
    // (`automation_column_order`), the INTENT is a durable command with an
    // event and a receipt (docs/BOUNDARIES.md rule 5). The whole list travels
    // and every element must be a string, because this is what a lane's drop
    // MEANS — a shape-check here is the last place a non-id can be turned away
    // before it is stored as somebody's digit.
    guard: (args): args is IpcArgs<"volli:automation-set-column-order"> =>
      args.length === 1 &&
      isRecord(args[0]) &&
      isAutomationCommandId(args[0]["commandId"]) &&
      typeof args[0]["projectId"] === "string" &&
      isTicketStatus(args[0]["status"]) &&
      Array.isArray(args[0]["rankedAutomationIds"]) &&
      args[0]["rankedAutomationIds"].every((id) => typeof id === "string"),
    invalidError: "Invalid automation order request",
  },
  "volli:automation-runs-for-project": {
    guard: (args): args is IpcArgs<"volli:automation-runs-for-project"> =>
      args.length === 1 && isRecord(args[0]) && typeof args[0]["projectId"] === "string",
    invalidError: "Invalid automation runs request",
  },
  "volli:automation-enablement": {
    guard: (args): args is IpcArgs<"volli:automation-enablement"> => args.length === 0,
    invalidError: "Invalid automation enablement request",
  },
  "volli:automation-set-enabled": {
    // A `commandId` like every other write: the projection is machine-local
    // (`enablement.ts`), the INTENT is a durable command with an event and a
    // receipt (docs/BOUNDARIES.md rule 5). `enabled` is a value rather than a
    // toggle, so a replayed command is also the same end state.
    guard: (args): args is IpcArgs<"volli:automation-set-enabled"> =>
      args.length === 1 &&
      isRecord(args[0]) &&
      isAutomationCommandId(args[0]["commandId"]) &&
      typeof args[0]["automationId"] === "string" &&
      typeof args[0]["enabled"] === "boolean",
    invalidError: "Invalid automation enablement request",
  },
  "volli:automation-skips-for-project": {
    guard: (args): args is IpcArgs<"volli:automation-skips-for-project"> =>
      args.length === 1 && isRecord(args[0]) && typeof args[0]["projectId"] === "string",
    invalidError: "Invalid automation skips request",
  },
  "volli:automation-run-for-project": {
    // The Project is named rather than implied: this door's whole difference
    // from `volli:automation-run` is the Target, so the Target is a required
    // field instead of an absent one (docs/BOUNDARIES.md rule 3).
    guard: (args): args is IpcArgs<"volli:automation-run-for-project"> =>
      args.length === 1 &&
      isRecord(args[0]) &&
      isAutomationCommandId(args[0]["commandId"]) &&
      typeof args[0]["automationId"] === "string" &&
      typeof args[0]["projectId"] === "string",
    invalidError: "Invalid automation run request",
  },
};

/** Every channel the automations surface owns, derived — never hand-synced. */
export const AUTOMATION_CHANNELS = Object.keys(AUTOMATION_IPC) as readonly AutomationIpcChannel[];

// ---- harness-trust descriptor table ---------------------------------------
// A manifest declares a command line Volli will execute, so this is the one
// request surface where the guard is part of the security story rather than
// only part of the type story: `reconfirm` is refused here (it is Volli's
// conclusion, never a human's answer), and a verdict with no hash is refused
// because nothing may be trusted in the abstract — only a named version of a
// file can be.

export const HARNESS_IPC: { readonly [C in HarnessIpcChannel]: IpcRequestDescriptor<C> } = {
  "volli:harness-pending": {
    guard: (args): args is [] => args.length === 0,
    invalidError: "Invalid request",
  },
  "volli:harness-trust-set": {
    guard: (args): args is IpcArgs<"volli:harness-trust-set"> => {
      if (args.length !== 1) return false;
      const [input] = args;
      return (
        isRecord(input) &&
        typeof input["slug"] === "string" &&
        typeof input["manifestSha256"] === "string" &&
        isHarnessTrustVerdict(input["decision"])
      );
    },
    invalidError: "Invalid harness verdict",
  },
  "volli:harness-registered": {
    guard: (args): args is [] => args.length === 0,
    invalidError: "Invalid request",
  },
};

/** Every channel the harness-trust surface owns, derived — never hand-synced. */
export const HARNESS_CHANNELS = Object.keys(HARNESS_IPC) as readonly HarnessIpcChannel[];

// ---- CLI install-detection descriptor table --------------------------------
// The Settings → CLI surface (VC-52): a host-wide status read, optionally
// scoped to a known project's dependency and Git credential roots, and a doctor
// run whose one flag says whether main should repair before probing.

export const CLI_IPC: { readonly [C in CliIpcChannel]: IpcRequestDescriptor<C> } = {
  "volli:cli-status": {
    guard: (args): args is IpcArgs<"volli:cli-status"> =>
      args.length === 0 ||
      (args.length === 1 &&
        isRecord(args[0]) &&
        (args[0]["cwd"] === undefined || typeof args[0]["cwd"] === "string")),
    invalidError: "Invalid request",
  },
  "volli:cli-doctor": {
    guard: (args): args is IpcArgs<"volli:cli-doctor"> =>
      args.length === 1 &&
      isRecord(args[0]) &&
      typeof args[0]["fix"] === "boolean" &&
      (args[0]["cwd"] === undefined || typeof args[0]["cwd"] === "string"),
    invalidError: "Invalid doctor request",
  },
  // The repair alone (VC-159): the launch banner's Fix now button, which takes
  // no input at all — there is one repair and it is idempotent.
  "volli:cli-repair": {
    guard: (args): args is IpcArgs<"volli:cli-repair"> => args.length === 0,
    invalidError: "Invalid repair request",
  },
};
// No CLI_CHANNELS sibling to HARNESS_CHANNELS: that list exists to register
// degraded-db handlers, and the CLI surface is deliberately db-free — a
// derived list nothing consumes would be dead weight kept alive by its test.

// ---- model-access sign-in descriptor table --------------------------------
// The one request surface an argument can be a credential on, so the guards
// below are written to the letter of what they may say. `invalidError` never
// interpolates an argument and never counts characters: "Invalid sign-in
// answer" is the whole vocabulary a rejected `respond` gets, because a message
// shaped by the value it rejected is a message that describes a secret. The
// value is deliberately unconstrained apart from being a string — a provider
// decides what a valid key looks like, this package cannot, and a length or
// charset rule invented here would reject a legitimate credential format the
// next provider ships.

function isSignInType(value: unknown): boolean {
  return value === "api-key" || value === "oauth";
}

function isIdArgument(value: unknown): boolean {
  return typeof value === "string" && value.length > 0;
}

export const MODEL_ACCESS_IPC: {
  readonly [C in ModelAccessIpcChannel]: IpcRequestDescriptor<C>;
} = {
  "volli:model-access-sign-in-begin": {
    guard: (args): args is IpcArgs<"volli:model-access-sign-in-begin"> =>
      args.length === 2 && isIdArgument(args[0]) && isSignInType(args[1]),
    invalidError: "Invalid sign-in request",
  },
  "volli:model-access-sign-in-respond": {
    guard: (args): args is IpcArgs<"volli:model-access-sign-in-respond"> =>
      args.length === 3 &&
      isIdArgument(args[0]) &&
      isIdArgument(args[1]) &&
      typeof args[2] === "string",
    invalidError: "Invalid sign-in answer",
  },
  "volli:model-access-sign-in-cancel": {
    guard: (args): args is IpcArgs<"volli:model-access-sign-in-cancel"> =>
      args.length === 1 && isIdArgument(args[0]),
    invalidError: "Invalid sign-in request",
  },
  "volli:model-access-sign-out": {
    guard: (args): args is IpcArgs<"volli:model-access-sign-out"> =>
      args.length === 1 && isIdArgument(args[0]),
    invalidError: "Invalid sign-out request",
  },
};

/** Every channel the in-app sign-in surface owns, derived — never hand-synced. */
export const MODEL_ACCESS_CHANNELS = Object.keys(
  MODEL_ACCESS_IPC,
) as readonly ModelAccessIpcChannel[];

// ---- web access descriptor table ------------------------------------------
// The second surface an argument can be a credential on, written to the same
// letter as the sign-in table above: `invalidError` never interpolates an
// argument and never counts characters, because a message shaped by the value it
// rejected is a message that describes a secret. The key is unconstrained apart
// from being a string — Brave decides what its token looks like, and a length or
// charset rule invented here would reject a legitimate one.
//
// The endpoint is NOT validated here. A guard's job is the argument's shape, and
// where a search request may go is a policy (`admitSearchEndpoint`) whose
// refusals are sentences a person needs to read — "Invalid request" would tell
// them nothing about which of their URL's several problems to fix.

function isWebAccessProvider(value: unknown): boolean {
  return value === "off" || value === "brave" || value === "searxng" || value === "exa";
}

/** The providers that carry a key, which are the only ones a key channel names. */
function isKeyedWebAccessProvider(value: unknown): boolean {
  return value === "brave" || value === "exa";
}

export const WEB_ACCESS_IPC: { readonly [C in WebAccessIpcChannel]: IpcRequestDescriptor<C> } = {
  "volli:web-access-get": {
    guard: (args): args is [] => args.length === 0,
    invalidError: "Invalid request",
  },
  "volli:web-access-set-provider": {
    guard: (args): args is IpcArgs<"volli:web-access-set-provider"> =>
      args.length === 2 &&
      isWebAccessProvider(args[0]) &&
      (args[1] === null || typeof args[1] === "string"),
    invalidError: "Invalid web access provider",
  },
  "volli:web-access-set-key": {
    guard: (args): args is IpcArgs<"volli:web-access-set-key"> =>
      args.length === 2 && isKeyedWebAccessProvider(args[0]) && typeof args[1] === "string",
    invalidError: "Invalid API key",
  },
  "volli:web-access-clear-key": {
    guard: (args): args is IpcArgs<"volli:web-access-clear-key"> =>
      args.length === 1 && isKeyedWebAccessProvider(args[0]),
    invalidError: "Invalid request",
  },
};

/** Every channel the Web Access surface owns, derived — never hand-synced. */
export const WEB_ACCESS_CHANNELS = Object.keys(WEB_ACCESS_IPC) as readonly WebAccessIpcChannel[];

// ---- agent observability descriptor table (VC-119) ------------------------
// The endpoint is deliberately NOT validated here, for the reason the Web
// Access table gives: a guard checks an argument's SHAPE, and where telemetry
// may be sent is a policy (`admitCollectorEndpoint`) whose refusals are
// sentences a person has to read. "Invalid request" would not tell them which
// of their address's problems to fix.

export const AGENT_OBSERVABILITY_IPC: {
  readonly [C in AgentObservabilityIpcChannel]: IpcRequestDescriptor<C>;
} = {
  "volli:agent-observability-get": {
    guard: (args): args is [] => args.length === 0,
    invalidError: "Invalid request",
  },
  "volli:agent-observability-set": {
    guard: (args): args is IpcArgs<"volli:agent-observability-set"> =>
      args.length === 2 && typeof args[0] === "boolean" && typeof args[1] === "string",
    invalidError: "Invalid request",
  },
};

/** Every channel the agent-observability surface owns, derived — never hand-synced. */
export const AGENT_OBSERVABILITY_CHANNELS = Object.keys(
  AGENT_OBSERVABILITY_IPC,
) as readonly AgentObservabilityIpcChannel[];

// ---- self-update descriptor table (VC-59) ---------------------------------
// Every update request is argument-less — the state is main's to own and the
// commands carry no caller data — so the guards only refuse stray payloads.

export const UPDATE_IPC: { readonly [C in UpdateIpcChannel]: IpcRequestDescriptor<C> } = {
  "volli:update-state-get": {
    guard: (args): args is [] => args.length === 0,
    invalidError: "Invalid request",
  },
  "volli:update-check": {
    guard: (args): args is [] => args.length === 0,
    invalidError: "Invalid request",
  },
  "volli:update-install": {
    guard: (args): args is [] => args.length === 0,
    invalidError: "Invalid request",
  },
  "volli:update-live-work": {
    guard: (args): args is [] => args.length === 0,
    invalidError: "Invalid request",
  },
  "volli:update-channel-get": {
    guard: (args): args is [] => args.length === 0,
    invalidError: "Invalid request",
  },
  "volli:update-channel-set": {
    guard: (args): args is IpcArgs<"volli:update-channel-set"> =>
      args.length === 1 && (args[0] === "stable" || args[0] === "canary"),
    invalidError: "Invalid release channel",
  },
};

/** Every channel the self-update surface owns, derived — never hand-synced. */
export const UPDATE_CHANNELS = Object.keys(UPDATE_IPC) as readonly UpdateIpcChannel[];
