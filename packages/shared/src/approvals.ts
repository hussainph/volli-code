/**
 * Remembered approvals: the vocabulary of "allow for this Session" and "always
 * allow in this project" (VC-480).
 *
 * Everything here is pure data and total functions. The store that persists
 * rows lives in the desktop main process, in the same app-owned database as the
 * project policy and for the same reason: the Session being governed must not
 * be able to write what governs it. Nothing in the agent's tool surface reaches
 * it, and the renderer lists and revokes over an app-only channel.
 *
 * The unit is a {@link ApprovalScope}: ONE thing a refused call does — write
 * into a folder, read a file, run a git command against another tree. A rule
 * that refuses a call lists every scope it objects to
 * (`PolicyViolation.scopes`), a ledger row covers a scope or it does not, and a
 * call is cleared when every scope of every approvable rule is covered. A rule
 * whose objection cannot be named narrowly — a command that wraps other
 * commands, an operand the rule cannot classify as a read — has no scopes
 * (`scopes: null`) and can only be allowed once. Narrow-or-once is the whole
 * safety argument of the ledger: a row never grants more than the person was
 * shown.
 */

import type { AuthorityDenialCause } from "./authority";
import { containsPath } from "./authority-policy";

/** What a scope does to its target. The operation is part of the match: a read row never covers a write. */
export type ApprovalOperation =
  | "write"
  | "read"
  | "git"
  /** A command Volli cannot read inside (an interpreter, `sh -c`): remembered only as the exact string. */
  | "command"
  /** Reserved for the network ledger (VC-45 slice 6): a host, matched exactly. Nothing writes it yet. */
  | "connect";

/** One objection a rule made, named narrowly enough to remember. */
export interface ApprovalScope {
  operation: ApprovalOperation;
  /** What this call touches: an absolute resolved path, or for `git` the command fragment. */
  target: string;
  /**
   * What a row would store to cover this scope: a folder prefix for a write
   * (compared at segment boundaries), the exact path for a read, the fragment
   * for git. Null when the objection can only be allowed once.
   */
  key: string | null;
  /** The plain sentence a row is listed as and the card names: "Write files in ~/code/docs/". */
  summary: string;
  /**
   * Which stage of a compound shell command (`a && b && rm x`) made this
   * objection, as an index into the command's segments. The card highlights
   * it, so the person approves that stage and not the line.
   */
  stage?: number;
}

/** One rule's refusal of one call, with every scope it objects to. */
export interface PolicyViolation {
  rule: AuthorityDenialCause;
  reason: string;
  /** Null: the objection cannot be narrowed, so this refusal can only be allowed once. */
  scopes: readonly ApprovalScope[] | null;
}

/** Where a row applies. */
export const APPROVAL_SCOPES = ["session", "project"] as const;
export type ApprovalRowScope = (typeof APPROVAL_SCOPES)[number];

/** The part of a row that decides whether it covers a scope. */
export interface ApprovalKey {
  operation: ApprovalOperation;
  key: string;
}

/**
 * Whether one row covers one scope.
 *
 * Paths compare at segment boundaries, so `~/code/docs` never covers
 * `~/code/docs-evil`; git fragments compare exactly. The tool is deliberately
 * not part of the match: `write`, `edit` and a shell redirect to one file are
 * one operation.
 */
export function approvalCovers(row: ApprovalKey, scope: ApprovalScope): boolean {
  if (scope.key === null || row.operation !== scope.operation) return false;
  if (scope.operation === "write" || scope.operation === "read") {
    // A key equal to the target marks an exact-only scope (reads, shallow
    // writes, git plumbing and Volli state). Broader folder approvals must not
    // turn that deliberate boundary back into prefix coverage.
    if (scope.key === scope.target) return row.key === scope.target;
    return containsPath(row.key, scope.target);
  }
  return row.key === scope.target;
}

/**
 * The plain sentence for a scope, from the two fields the gate matches on and
 * nothing else — so the card, the Approved actions list and the gate cannot
 * describe different things. A write key is a folder or an exact file; either
 * way the row covers that path and what is beneath it.
 */
export function describeApproval(approval: ApprovalKey): string {
  switch (approval.operation) {
    case "write":
      return `Write to ${approval.key}`;
    case "read":
      return `Read ${approval.key}`;
    case "git":
      return `Run ${approval.key}`;
    case "command": {
      const shown =
        approval.key.length > 120 ? `${approval.key.slice(0, 117)}\u2026` : approval.key;
      return `Run exactly: ${shown}`;
    }
    case "connect":
      return `Connect to ${approval.key}`;
  }
}

function scopeOf(operation: ApprovalOperation, target: string, key: string): ApprovalScope {
  return { operation, target, key, summary: describeApproval({ operation, key }) };
}

/** Fewest path segments a folder may have to be remembered as a prefix. */
const MIN_PREFIX_SEGMENTS = 4;

/**
 * The key a write into `path` is remembered under: its folder, unless the
 * folder is the home directory, a top-level home folder or a system root, in
 * which case the exact file. `/Users/me/code/docs/a.md` → `/Users/me/code/docs`;
 * `/Users/me/code/a.md` and `/etc/hosts` stay exact, because "everything in
 * ~/code" and "everything in /etc" are not what a person agreed to.
 */
export function writeApprovalKey(path: string): string {
  const slash = path.lastIndexOf("/");
  const folder = slash <= 0 ? "" : path.slice(0, slash);
  const depth = folder.split("/").filter((part) => part !== "").length;
  return depth >= MIN_PREFIX_SEGMENTS ? folder : path;
}

/** The scope a write to `path` makes. */
export function writeScope(path: string): ApprovalScope {
  return scopeOf("write", path, writeApprovalKey(path));
}

/** The scope a read of `path` makes. */
export function readScope(path: string): ApprovalScope {
  return scopeOf("read", path, path);
}

/** The scope a git invocation makes, named by the fragment that made it objectionable. */
export function gitScope(fragment: string): ApprovalScope {
  return scopeOf("git", fragment, fragment);
}

/**
 * The scope of a command Volli cannot read inside: the exact string, nothing
 * broader. An interpreter prefix (`python`, `node`, `bash`, `npx`…) is never
 * remembered as "anything that starts with this" — everything after it is
 * arbitrary code — so the row covers this command and no other.
 */
export function commandScope(raw: string): ApprovalScope {
  return scopeOf("command", raw, raw);
}

/**
 * Whether "always allow in this project" may be offered for these scopes. Not
 * for a command Volli cannot read inside: its exact string is safe to remember
 * for a Session, and a project-wide row for it would outlive the context that
 * made the person trust it.
 */
export function projectRememberable(scopes: readonly ApprovalScope[]): boolean {
  return scopes.length > 0 && scopes.every((scope) => scope.operation !== "command");
}

/**
 * Programs that run what they are handed, so a command naming one cannot be
 * read for what it will do. The same list the lexer's own bypass notes name.
 */
const WRAPPING_PROGRAMS = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "fish",
  "eval",
  "xargs",
  "source",
  ".",
  "exec",
  "env",
  "nohup",
  "sudo",
  "ssh",
  "npx",
  "bunx",
  "uvx",
  "pipx",
  "dlx",
]);

// Versioned executables have the same inline-code boundary as their bare name.
const INTERPRETER = /^(python|node|perl|ruby|osascript|deno)(?:\d+(?:\.\d+)*)?$/;

function interpreterRunsCode(program: string, args: readonly string[]): boolean {
  const family = INTERPRETER.exec(program)?.[1];
  if (family === undefined) return false;
  if (family === "deno" && args.includes("eval")) return true;
  return args.some((arg) => {
    if (arg === "--eval" || arg.startsWith("--eval=")) return true;
    if (family === "node" && (arg === "--print" || arg.startsWith("--print="))) return true;
    if (!arg.startsWith("-") || arg.startsWith("--")) return false;
    // Includes attached code (-cCODE/-eCODE) and clusters such as perl -we.
    return (
      arg.slice(1).includes(family === "python" ? "c" : "e") ||
      (family === "node" && arg.slice(1).includes("p"))
    );
  });
}

/** Package managers whose `exec`/`dlx`/`x` subcommand runs a downloaded program. */
const PACKAGE_RUNNERS = new Set(["pnpm", "yarn", "npm", "bun"]);

/**
 * Whether a command hides other commands from the lexer: `sh -c`, `eval`,
 * `xargs`, `$(…)`, `find -exec`, an interpreter's `-c`/`-e`. Such a call is
 * remembered only as the exact command, never as an operand/path or project grant.
 */
export function wrapsCommands(command: {
  raw: string;
  segments: readonly { program: string; args: readonly string[] }[];
}): boolean {
  if (command.raw.includes("$(") || command.raw.includes("`")) return true;
  return command.segments.some((segment) => {
    const program = segment.program.slice(segment.program.lastIndexOf("/") + 1).toLowerCase();
    if (WRAPPING_PROGRAMS.has(program)) return true;
    if (program === "find") {
      return segment.args.some((arg) => ["-exec", "-execdir", "-ok", "-okdir"].includes(arg));
    }
    if (PACKAGE_RUNNERS.has(program)) {
      return segment.args.some((arg) => ["exec", "dlx", "x"].includes(arg));
    }
    return interpreterRunsCode(program, segment.args);
  });
}

/* ---------------------------------------------------------------- the ledger row */

/** Where a remembered approval came from. Written by main from the person's answer. */
export interface ApprovalProvenance {
  sessionId: string;
  sessionTitle: string | null;
  ticketDisplayId: string | null;
  /** The call exactly as the card showed it. */
  asked: string;
  /** The refusing rule's words. */
  reason: string;
  interactionId: string;
}

/** One remembered approval, as the Approved actions list shows it. */
export interface AuthorityApproval {
  id: string;
  projectId: string;
  scope: ApprovalRowScope;
  /** The Session a `session` row belongs to; null for a project row. */
  sessionId: string | null;
  operation: ApprovalOperation;
  key: string;
  /** The rule whose refusal this answered. */
  rule: string;
  /** Always `describeApproval(row)`; derived on read, never stored. */
  summary: string;
  createdAt: number;
  provenance: ApprovalProvenance;
  useCount: number;
  lastUsedAt: number | null;
  /** Verified subagent use of an inherited Session grant; null for ordinary/project use. */
  lastUsedBySessionId: string | null;
}

/* ------------------------------------------------------------------- the copy */

/** The card's words for an approvable refusal. */
export interface ApprovalCopy {
  title: string;
  because: string;
}

/** Card copy per refusing rule. Unlisted approvable rules fall back to a plain sentence. */
export function approvalCopy(cause: AuthorityDenialCause): ApprovalCopy {
  switch (cause) {
    case "path.outside-workspace":
      return {
        title: "Allow file access outside this workspace?",
        because: "this file is outside the Session's workspace, and protection is on.",
      };
    case "path.git-internals":
      return {
        title: "Allow changing this repository's git setup?",
        because: "git hooks and git config change what every later git command does.",
      };
    case "path.volli-internals":
      return {
        title: "Allow changing Volli's files here?",
        because: ".volli holds Volli's own state for this project.",
      };
    case "command.git-escapes-workspace":
      return {
        title: "Allow git to work in another repository?",
        because: "this command acts on a repository outside the Session's workspace.",
      };
    case "command.git-discards-work":
      return {
        title: "Allow discarding uncommitted changes?",
        because: "this throws away uncommitted work in your Main checkout.",
      };
    default:
      return {
        title: "Allow this?",
        because: "protection is on and this call needs your approval.",
      };
  }
}

/** The plain explanation of a refusal no one can approve. */
export interface HardRefusalCopy {
  heading: string;
  line: string;
}

/**
 * Words for a refusal that cannot be approved, or null when `cause` is one a
 * person may clear. Every non-approvable cause has an entry, so the model and
 * the person read a sentence rather than a rule id.
 */
export function hardRefusalCopy(cause: AuthorityDenialCause): HardRefusalCopy {
  switch (cause) {
    case "command.persistence":
      return {
        heading: "Never allowed: programs that outlive the Session",
        line: "Login items, launch agents and cron jobs keep running after the agent is gone.",
      };
    case "command.platform-weakening":
      return {
        heading: "Never allowed: turning off macOS protections",
        line: "SIP, Gatekeeper and the other macOS protections stay on for every agent.",
      };
    case "command.tls-weakening":
      return {
        heading: "Never allowed: skipping certificate checks",
        line: "Turning off TLS verification lets anyone in the middle read or change what's sent.",
      };
    case "command.destructive-removal":
      return {
        heading: "Never allowed: deleting a system or home folder",
        line: "A recursive delete aimed at / or your home folder can't be undone.",
      };
    case "call.unreadable":
      return {
        heading: "Blocked: Volli couldn't read this call",
        line: "It couldn't tell what this would touch, so it didn't run it.",
      };
    default:
      return {
        heading: "Never allowed",
        line: "Protection doesn't let any agent do this.",
      };
  }
}

/**
 * The text a never-allowed refusal becomes as the tool's result: the person's
 * explanation first, then the rule's own words for the model, then the way out.
 */
export function hardRefusalMessage(cause: AuthorityDenialCause, reason: string): string {
  const { heading, line } = hardRefusalCopy(cause);
  return `${heading}\n${line} This can't be approved, so find another way.\n\n${reason}`;
}

/** What the model reads when a person denies a call and says what to do instead. */
export function steerMessage(message: string): string {
  return `The person denied this and said: "${message.trim()}"`;
}

/** The tool result for a plain "Deny". */
export const DENIED_BY_PERSON =
  "The person denied this call. Carry on without it or try another way.";

/* ------------------------------------------------- typed adapter-authored cards */

/** What an authority-adapter approval card shows, carried as `SessionInteraction.approval`. */
export interface ApprovalDetail {
  /** The call as asked: the command, or the tool and its path. */
  asked: string;
  /** The "Stopped because…" sentence, without its lead-in. */
  because: string;
  /** The refusing rule's own words, for See details. */
  reason: string;
  /** A compound command's stages, in order; empty for a single command. */
  stages: readonly string[];
  /** Index of the stage held for approval, or null. */
  held: number | null;
  /** All affected stages on an aggregate card; absent on older cards. */
  heldStages?: readonly number[];
}

/** Adapter-authored metadata, never model option ids, identifies an approval. */
export function isApprovalInteraction<T extends { approval?: ApprovalDetail }>(
  interaction: T,
): interaction is T & { approval: ApprovalDetail } {
  return interaction.approval !== undefined;
}

/** Stable shortcuts: omitting an unavailable grant never renumbers the other actions. */
export function approvalActionDigit(optionId: string): number | null {
  switch (optionId) {
    case "once":
      return 1;
    case "session":
      return 2;
    case "project":
      return 3;
    case "reject":
      return 4;
    case "steer":
      return 5;
    default:
      return null;
  }
}

/* --------------------------------------------------------------- decisions */

/**
 * Who authorised a gated call, recorded before the call runs (VC-480).
 *
 * `classifier` is reserved for VC-28 and nothing writes it yet.
 */
export const APPROVAL_AUTHORISERS = [
  "user:once",
  "user:session",
  "user:project",
  "user:deny",
  "policy:ledger",
  "rule:hard",
  "classifier",
] as const;
export type ApprovalAuthoriser = (typeof APPROVAL_AUTHORISERS)[number];

/** One decision about one gated call, as the host records it. */
export interface ApprovalDecision {
  toolCallId: string;
  tool: string;
  authoriser: ApprovalAuthoriser;
  /** The refusing rule. */
  rule: string;
  /** What the decision covered, in the words of {@link describeApproval}; or the hard-refusal heading. */
  summary: string;
  asked: string;
  /** The ledger row that allowed it, for `policy:ledger`. */
  approvalId: string | null;
}
