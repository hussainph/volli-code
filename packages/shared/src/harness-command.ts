/**
 * Pure helpers for launching an agent harness CLI inside a freshly-spawned
 * login shell: POSIX single-quote escaping, the ticket → initial-prompt
 * composition, and the per-harness interactive launch command line. No
 * Node/Electron/DOM imports (package rule) — main injects the built command
 * line into the PTY (`src/main/pty.ts`).
 */
import { isHarnessId } from "./ticket";
import type { HarnessId } from "./ticket";
import { getHarnessAdapter } from "./harness/core";
import { GENERIC_RESUME_METADATA } from "./harness/generic";

/**
 * Wraps `input` as a single POSIX single-quoted zsh word so every shell
 * metacharacter it contains — `$`, backticks, `"`, `\`, globs — stays inert.
 *
 * Defensive normalization first: `\r\n`/lone `\r` collapse to `\n` (so a
 * pasted CRLF prompt can't smuggle a carriage return into the line), and NUL
 * (U+0000) and EOT (U+0004) control bytes are stripped (a NUL truncates a C
 * string; EOT at a shell prompt is end-of-input). Embedded single quotes use
 * the classic `'\''` idiom (close-quote, escaped literal quote, reopen-quote).
 *
 * Empirically verified against interactive zsh under a PTY: embedded literal
 * newlines inside the single quotes produce continuation prompts (`PS2`), never
 * premature execution, and the payload round-trips byte-for-byte.
 */
export function shellSingleQuote(input: string): string {
  const normalized = input
    .replace(/\r\n?/g, "\n")
    .replaceAll("\u0000", "")
    .replaceAll("\u0004", "");
  return `'${normalized.replace(/'/g, "'\\''")}'`;
}

/**
 * The agent's initial prompt for a ticket: a `"${displayId}: ${title}"` header
 * and, when the ticket has a non-empty (trimmed) body, a blank line then the
 * body verbatim. `Ticket.body` is markdown and becomes the prompt (see the
 * `Ticket.body` doc in `ticket.ts` — "Markdown; becomes the agent prompt").
 */
export function composeTicketPrompt(input: {
  displayId: string;
  title: string;
  body: string;
}): string {
  const header = `${input.displayId}: ${input.title}`;
  const body = input.body.trim();
  return body.length > 0 ? `${header}\n\n${body}` : header;
}

/**
 * The full interactive launch command line for a harness, with `prompt` passed
 * as its initial prompt (single-quoted via {@link shellSingleQuote}). Verified
 * against the installed CLIs:
 *
 * - `claude-code` → `claude <prompt>` (positional prompt boots the TUI).
 * - `codex` → `codex <prompt>` (positional prompt = interactive TUI; `codex
 *   exec` is the NON-interactive path and is deliberately not used).
 * - `opencode` → `opencode --prompt <prompt>` (the `--prompt` flag on the
 *   default TUI command; `opencode run` is NON-interactive and not used).
 */
export function buildHarnessCommand(harnessId: HarnessId, prompt: string): string {
  const quoted = shellSingleQuote(prompt);
  const adapter = getHarnessAdapter(harnessId);
  return [adapter.command, adapter.promptFlag, quoted].filter(Boolean).join(" ");
}

/**
 * The command line to resume a harness's prior session (interrupt/resume,
 * issue #78): the same shell-quoting {@link shellSingleQuote} applies to
 * prompts applies to the session id here.
 *
 * Fallback chain:
 * 1. `harnessSessionId` is known AND the harness has by-id resume support
 *    (`resumeIdArgs`) → `<command> <resumeIdArgs...> <quoted-id>`.
 * 2. Otherwise, the harness has "resume latest in cwd" support
 *    (`resumeLatestArgs`) → `<command> <resumeLatestArgs...>`.
 * 3. Otherwise (a custom/undetected harness id, or a first-class harness
 *    missing both) → `null` — the caller falls back to a fresh launch.
 */
export function buildHarnessResumeCommand(
  harnessId: HarnessId | string,
  harnessSessionId: string | null,
): string | null {
  const adapter = isHarnessId(harnessId) ? getHarnessAdapter(harnessId) : null;
  const command = adapter?.command ?? null;
  const resumeIdArgs = adapter?.resumeIdArgs ?? GENERIC_RESUME_METADATA.resumeIdArgs;
  const resumeLatestArgs = adapter?.resumeLatestArgs ?? GENERIC_RESUME_METADATA.resumeLatestArgs;

  if (command && harnessSessionId && resumeIdArgs) {
    return [command, ...resumeIdArgs, shellSingleQuote(harnessSessionId)].join(" ");
  }
  if (command && resumeLatestArgs) {
    return [command, ...resumeLatestArgs].join(" ");
  }
  return null;
}

/**
 * The orientation preamble a worktree ticket's prompt OPENS with
 * (worktree-support §6): agents must never infer — much less "reorient" —
 * their working directory, so the situation is stated outright before the
 * ticket content. Main prepends this after `ensure` resolves (only then are
 * path/branch/base known); the CLI's `ticket.brief` prepends it the same way.
 */
export function worktreeOrientationPreamble(input: {
  worktreePath: string;
  branch: string;
  baseBranch: string | null;
  projectPath: string;
}): string {
  const branchedFrom = input.baseBranch ? ` (branched from \`${input.baseBranch}\`)` : "";
  return (
    `You are working in an isolated git worktree at \`${input.worktreePath}\` ` +
    `on branch \`${input.branch}\`${branchedFrom}. All work happens in the ` +
    `current directory. The main checkout at \`${input.projectPath}\` is ` +
    `reference-only — never modify it.`
  );
}
