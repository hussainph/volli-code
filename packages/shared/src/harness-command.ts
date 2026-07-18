/**
 * Pure helpers for launching an agent harness CLI inside a freshly-spawned
 * login shell: POSIX single-quote escaping, the ticket → initial-prompt
 * composition, and the per-harness interactive launch command line. No
 * Node/Electron/DOM imports (package rule) — main injects the built command
 * line into the PTY (`src/main/pty.ts`).
 */
import type { HarnessId } from "./ticket";

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
  switch (harnessId) {
    case "claude-code":
      return `claude ${quoted}`;
    case "codex":
      return `codex ${quoted}`;
    case "opencode":
      return `opencode --prompt ${quoted}`;
  }
}
