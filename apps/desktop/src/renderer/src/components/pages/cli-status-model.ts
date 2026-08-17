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
      return { key: "path", label: "Login PATH", tone: "ok", value: "Reachable" };
    case "missing":
      return {
        key: "path",
        label: "Login PATH",
        tone: "warn",
        value: "Missing",
        detail: `${status.path.binDir} is not on the login shell's PATH.`,
      };
    case "unknown":
      return {
        key: "path",
        label: "Login PATH",
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
