/**
 * The pure fold from a measured {@link CliToolStatus} to the rows the Settings
 * → CLI pane draws (VC-52). Extracted from the view for the same reason
 * `harness-catalog.ts` is: these mappings decide what a user is TOLD about a
 * silent background install, so they are enrolled at 100% coverage while the
 * JSX around them stays view glue.
 *
 * Tone vocabulary, chosen against the pane's job (detection, not alarm):
 * `ok` is a working piece; `warn` is a piece that needs the user's eyes (a
 * foreign link, a missing PATH entry); `muted` is a true-but-unactionable
 * state — the zsh-only limitation, a shell that could not be asked — stated
 * as a known state rather than dressed up as a failure (the ticket's
 * "note it, not silence" rule).
 */
import type { CliToolStatus } from "../../../../ipc/contract";

export type CliRowTone = "ok" | "warn" | "muted";

export interface CliStatusRow {
  key: string;
  /** Row label — a noun; the value does the explaining. */
  label: string;
  tone: CliRowTone;
  /** The short state phrase next to the dot. */
  value: string;
  /** An optional second line — a path or a one-line consequence. */
  detail?: string;
}

export type SessionPathComparisonState = "matching" | "pending" | "diverged" | "unknown";

/**
 * The comparison a person needs, rather than a raw pair of 25-entry strings.
 *
 * Session-only entries are normal: Volli's bin directory is deliberately
 * first, and a dev launch may retain private entries of its own. A missing
 * login directory or a changed shared order is not normal — either can change
 * which command a Session resolves — so those are the only divergent states.
 */
export interface SessionPathComparison {
  state: SessionPathComparisonState;
  loginEntries: readonly string[];
  sessionEntries: readonly string[];
  missingFromSession: readonly string[];
  sessionOnly: readonly string[];
  sharedEntryCount: number;
  sharedOrderMatches: boolean;
}

function pathEntries(path: string): string[] {
  return path.split(":").filter((entry) => entry.length > 0);
}

function uniqueAbsentFrom(entries: readonly string[], present: ReadonlySet<string>): string[] {
  const seen = new Set<string>();
  const absent: string[] = [];
  for (const entry of entries) {
    if (present.has(entry) || seen.has(entry)) continue;
    seen.add(entry);
    absent.push(entry);
  }
  return absent;
}

function sameEntries(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

/**
 * Folds the two measured PATH values into the exact differences the pane draws.
 *
 * The full strings stay available as entry lists for an explicit disclosure,
 * but the difference is never behind that disclosure. A long directory name
 * is the evidence; hiding it behind an ellipsis would recreate the ambiguity
 * this comparison exists to remove.
 */
export function sessionPathComparison(
  status: Pick<CliToolStatus, "environment">,
): SessionPathComparison {
  const sessionEntries = pathEntries(status.environment.session.path);
  const loginPath = status.environment.loginPath;
  if (loginPath === null) {
    return {
      state: "unknown",
      loginEntries: [],
      sessionEntries,
      missingFromSession: [],
      sessionOnly: [],
      sharedEntryCount: 0,
      sharedOrderMatches: false,
    };
  }

  const loginEntries = pathEntries(loginPath);
  const loginSet = new Set(loginEntries);
  const sessionSet = new Set(sessionEntries);
  const missingFromSession = uniqueAbsentFrom(loginEntries, sessionSet);
  const sessionOnly = uniqueAbsentFrom(sessionEntries, loginSet);
  const sharedLoginOrder = loginEntries.filter((entry) => sessionSet.has(entry));
  const sharedSessionOrder = sessionEntries.filter((entry) => loginSet.has(entry));
  const sharedOrderMatches = sameEntries(sharedLoginOrder, sharedSessionOrder);

  const differs = missingFromSession.length > 0 || !sharedOrderMatches;
  // The interactive pass is deliberately asynchronous: a Settings read that
  // lands before it finishes can observe a short Session PATH that is already
  // on its way to matching. `pending` names that transition rather than
  // presenting it as either a healthy match or a permanent failure. A failed
  // boot pass stays loud even while that recovery attempt is in flight.
  const state = !differs
    ? "matching"
    : status.environment.session.interactiveProvenance === "pending" &&
        status.environment.session.provenance !== "probe-failed"
      ? "pending"
      : "diverged";

  return {
    state,
    loginEntries,
    sessionEntries,
    missingFromSession,
    sessionOnly,
    sharedEntryCount: new Set(sharedLoginOrder).size,
    sharedOrderMatches,
  };
}

function linkRow(status: CliToolStatus): CliStatusRow {
  const { link, installSuppressed } = status;
  switch (link.state) {
    case "ours":
      return { key: "link", label: "Command", tone: "ok", value: "Linked", detail: link.path };
    case "missing":
      return installSuppressed
        ? {
            key: "link",
            label: "Command",
            tone: "muted",
            value: "Removed",
            detail: "Reinstall from File → Install Volli CLI & Agent Skills.",
          }
        : { key: "link", label: "Command", tone: "warn", value: "Not linked", detail: link.path };
    case "foreign":
      return {
        key: "link",
        label: "Command",
        tone: "warn",
        value: "Owned by another tool",
        detail: link.target ?? undefined,
      };
    case "not-symlink":
      return {
        key: "link",
        label: "Command",
        tone: "warn",
        value: "A file of yours holds the name",
        detail: link.path,
      };
  }
}

function pathRow(status: CliToolStatus): CliStatusRow {
  switch (status.path.state) {
    case "reachable":
      return { key: "path", label: "Volli on login PATH", tone: "ok", value: "Reachable" };
    case "missing":
      return {
        key: "path",
        label: "Volli on login PATH",
        tone: "warn",
        value: "Missing",
        detail: `${status.path.binDir} is not on the login shell's PATH.`,
      };
    case "unknown":
      return {
        key: "path",
        label: "Volli on login PATH",
        tone: "muted",
        value: "Unknown",
        detail: "The login shell did not answer.",
      };
  }
}

function shellRow(status: CliToolStatus): CliStatusRow {
  const { shell } = status;
  if (!shell.supported) {
    return {
      key: "shell",
      label: "Shell chain",
      tone: "muted",
      value: `${shell.name} — zsh only for now`,
    };
  }
  return shell.chainActive
    ? { key: "shell", label: "Shell chain", tone: "ok", value: "zsh" }
    : { key: "shell", label: "Shell chain", tone: "warn", value: "Not generated" };
}

/** The pane's detection rows, in reading order: the outside world first, then this launch. */
export function cliStatusRows(status: CliToolStatus): CliStatusRow[] {
  const rows: CliStatusRow[] = [
    linkRow(status),
    pathRow(status),
    {
      key: "socket",
      label: "App socket",
      tone: status.socket.live ? "ok" : "warn",
      value: status.socket.live ? "Live" : "Not running",
      detail: status.socket.path,
    },
    status.wrappers.commands.length > 0
      ? {
          key: "wrappers",
          label: "Wrappers",
          tone: "ok",
          value: status.wrappers.commands.join(", "),
        }
      : { key: "wrappers", label: "Wrappers", tone: "muted", value: "None generated" },
    shellRow(status),
  ];
  // The stale admin-owned /usr/local/bin link most hosts cannot unlink without
  // elevation: reported truthfully when present, invisible when migration is
  // complete. Ours is inert (the user-space link shadows it) — muted; a
  // foreign one could still shadow us in an unusual PATH order — warn.
  if (status.legacy.state === "ours") {
    rows.push({
      key: "legacy",
      label: "Legacy link",
      tone: "muted",
      value: "Old /usr/local/bin link remains",
      detail: "Admin-owned; harmless, and safe to delete yourself.",
    });
  } else if (status.legacy.state === "foreign") {
    rows.push({
      key: "legacy",
      label: "Legacy link",
      tone: "warn",
      value: "Another volli sits in /usr/local/bin",
      detail: status.legacy.path,
    });
  }
  return rows;
}

/** Whether anything on the pane deserves the user's eyes — drives the section's summary chip. */
export function cliNeedsAttention(rows: readonly CliStatusRow[]): boolean {
  return rows.some((row) => row.tone === "warn");
}
