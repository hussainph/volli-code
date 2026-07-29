/**
 * Pure helpers for launching an agent harness CLI inside a freshly-spawned
 * login shell: POSIX single-quote escaping, the ticket → initial-prompt
 * composition, and the per-harness interactive launch command line. No
 * Node/Electron/DOM imports (package rule) — main injects the built command
 * line into the PTY (`src/main/pty.ts`).
 */
import { parseHarnessId } from "./ticket";
import type { HarnessId } from "./ticket";
import { getHarnessAdapter } from "./harness/core";
import type { HarnessAdapter } from "./harness/types";

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
 * - `cursor` → `cursor-agent <prompt>` (the CLI's binary is `cursor-agent`;
 *   `cursor` is the editor's shell command).
 *
 * A harness with no registered adapter is launched by its own slug with a
 * positional prompt — the Declared tier still starts, it just starts blind.
 */
export function buildHarnessCommand(harnessId: HarnessId, prompt: string): string {
  const quoted = shellSingleQuote(prompt);
  const adapter = getHarnessAdapter(harnessId);
  return [adapter?.command ?? harnessId, adapter?.promptFlag, quoted].filter(Boolean).join(" ");
}

/** The last `/`-segment of a relative path — the materialized file's own basename. */
function basenameOf(relPath: string): string {
  const idx = relPath.lastIndexOf("/");
  return idx === -1 ? relPath : relPath.slice(idx + 1);
}

/**
 * The prompt's "## Attachments" section (CONCEPT decision #19): lists every
 * materialized file's relative path plus every URL attachment, so the agent
 * knows exactly what spec material it has and where. Returns `""` when there
 * is nothing to list — main and the CLI's `ticket.brief` both skip appending
 * a separator in that case. A file/URL's label is suffixed with ` — ${label}`
 * only when it differs from the raw name (the file's basename) or URL —
 * repeating an identical label would be pure noise. The "Read each attached
 * file…" lead-in appears only when there's at least one file; "Reference
 * URLs:" only when there's at least one URL.
 */
export function composeAttachmentsSection(input: {
  files: readonly { relPath: string; label: string }[];
  urls: readonly { url: string; label: string }[];
}): string {
  if (input.files.length === 0 && input.urls.length === 0) return "";

  const lines: string[] = ["## Attachments", ""];
  if (input.files.length > 0) {
    lines.push("Read each attached file before starting — they are part of the ticket's spec:");
    for (const file of input.files) {
      const suffix = file.label === basenameOf(file.relPath) ? "" : ` — ${file.label}`;
      lines.push(`- \`${file.relPath}\`${suffix}`);
    }
  }
  if (input.urls.length > 0) {
    lines.push("Reference URLs:");
    for (const url of input.urls) {
      const suffix = url.label === url.url ? "" : ` — ${url.label}`;
      lines.push(`- ${url.url}${suffix}`);
    }
  }
  return lines.join("\n");
}

/** The `{id}` token a {@link HarnessResume.byId} template substitutes at. */
export const RESUME_ID_TOKEN = "{id}";

/**
 * A by-id resume argv template with the session id substituted in. The id is
 * shell-quoted, but only the id: a template like `--session={id}` renders as
 * `--session='abc'`, so the flag it is embedded in stays a literal flag.
 */
export function renderResumeArgv(template: readonly string[], harnessSessionId: string): string[] {
  const quoted = shellSingleQuote(harnessSessionId);
  return template.map((token) => token.replaceAll(RESUME_ID_TOKEN, () => quoted));
}

/**
 * The command line to resume a harness's prior session (interrupt/resume,
 * issue #78), for an adapter already in hand.
 *
 * Fallback chain:
 * 1. `harnessSessionId` is known AND the harness declares a by-id resume
 *    template → `<command> <template with {id} substituted>`.
 * 2. Otherwise, the harness has "resume latest in cwd" support → `<command>
 *    <resume.latest...>`.
 * 3. Otherwise (a harness with no registered adapter, or one declaring
 *    neither) → `null` — the caller falls back to a fresh launch.
 */
export function buildResumeCommand(
  adapter: HarnessAdapter,
  harnessSessionId: string | null,
): string | null {
  if (harnessSessionId && adapter.resume.byId) {
    return [adapter.command, ...renderResumeArgv(adapter.resume.byId, harnessSessionId)].join(" ");
  }
  if (adapter.resume.latest) {
    return [adapter.command, ...adapter.resume.latest].join(" ");
  }
  return null;
}

/** {@link buildResumeCommand} for a harness named by id — `null` when nothing is registered under it. */
export function buildHarnessResumeCommand(
  harnessId: string,
  harnessSessionId: string | null,
): string | null {
  const parsed = parseHarnessId(harnessId);
  const adapter = parsed ? getHarnessAdapter(parsed) : undefined;
  return adapter ? buildResumeCommand(adapter, harnessSessionId) : null;
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
