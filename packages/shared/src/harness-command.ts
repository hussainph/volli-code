/**
 * Pure helpers for launching an agent harness CLI inside a freshly-spawned
 * login shell: POSIX single-quote escaping, the ticket → initial-prompt
 * composition, and the per-harness interactive launch command line. No
 * Node/Electron/DOM imports (package rule) — main injects the built command
 * line into the PTY (`src/main/pty.ts`).
 */
import { parseHarnessId } from "./ticket";
import type { HarnessId } from "./ticket";
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
 * The absolute path of the generated wrapper for a harness, or `null` when
 * Volli did not write one (the harness was not detected, or the census that
 * would have proved it absent could not run).
 *
 * Required wherever a launch line is built, and deliberately not optional: a
 * bare command name is resolved by the session's shell through `PATH`, and on
 * macOS a login shell rebuilds `PATH` — `/etc/zprofile` runs `path_helper`,
 * then every user prepend lands on top — so Volli's own `bin/` finishes far
 * down the list and the wrapper never runs. That defect passed every test on
 * this branch for its whole life because nothing asserted the resolution, only
 * the membership. An optional parameter would let the next call site
 * reintroduce it silently; a required one makes the omission a compile error.
 */
export type HarnessWrapperPath = string | null;

/**
 * Answers {@link HarnessWrapperPath} for a harness. Threaded into the places
 * that build a launch line, because which harness is launching is only known
 * once the session's scope resolves — a single pre-resolved path could not
 * cover a kickoff and a resume of different harnesses.
 */
export type HarnessWrapperLookup = (harnessId: HarnessId) => HarnessWrapperPath;

/**
 * Answers which adapter a harness id names, for a caller that has already
 * decided which harnesses count.
 *
 * Threaded rather than resolved in here, for the same reason
 * {@link HarnessWrapperPath} is threaded: the built-in registry is closed by
 * construction, and a manifest the user has registered AND trusted exists only
 * in main's hands. A launch helper that reached for that registry itself would
 * answer "no adapter" for a harness the user has fully set up — and answer it
 * identically forever, since nothing about the registry ever learns the
 * manifest exists. Made a parameter so the omission is a compile error rather
 * than a launch that quietly drops a harness's prompt flag and resume path.
 *
 * `getHarnessAdapter` is itself a valid lookup, and is the honest one to pass
 * wherever only the built-ins CAN be known.
 */
export type HarnessAdapterLookup = (harnessId: HarnessId) => HarnessAdapter | undefined;

/**
 * Whether a resume slot holds argv that would actually resume anything. An
 * EMPTY array is not a resume path: `[]` is truthy, so testing the array itself
 * reports a harness as resumable and then builds a "resume" line that is only
 * the bare executable — a FRESH session wearing a resume's name, on every
 * surface that offered the action. The manifest parser refuses empty argv, but
 * a launch must not be correct only because a validator two layers away is.
 * `harnessTier` keeps its own twin of this guard for the same reason.
 */
function hasResumeArgv(argv: readonly string[] | null): argv is readonly string[] {
  return argv !== null && argv.length > 0;
}

/**
 * The word that invokes a harness inside a Volli PTY: the generated wrapper by
 * absolute path when there is one, and otherwise the harness's own command,
 * left to `PATH` exactly as before.
 *
 * The fallback is not a lesser form of the same thing — it launches the harness
 * genuinely unwrapped, reporting no events — so a caller that cannot supply a
 * wrapper is choosing the Known tier, not merely a different spelling.
 *
 * `adapter` is what the caller resolved for this id, `undefined` when it
 * resolved nothing; the id then stands in for its own command, which is the
 * best a harness nobody has described can be launched by.
 */
export function harnessExecutable(
  harnessId: HarnessId,
  wrapperPath: HarnessWrapperPath,
  adapter: HarnessAdapter | undefined,
): string {
  if (wrapperPath !== null) return shellSingleQuote(wrapperPath);
  return adapter?.command ?? harnessId;
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
 * The executable is the generated wrapper's absolute path whenever one exists
 * (see {@link HarnessWrapperPath}) — a Volli-initiated launch must never be
 * left to `PATH` to resolve.
 *
 * A harness `adapterFor` resolves nothing for is launched by its own slug with
 * a positional prompt — the Declared tier still starts, it just starts blind.
 * Which is exactly why the lookup is the CALLER's: hand this the built-ins
 * alone and a registered harness declaring `promptFlag: "--prompt"` launches
 * with its prompt read as a subcommand.
 */
export function buildHarnessCommand(
  harnessId: HarnessId,
  prompt: string,
  wrapperPath: HarnessWrapperPath,
  adapterFor: HarnessAdapterLookup,
): string {
  const quoted = shellSingleQuote(prompt);
  const adapter = adapterFor(harnessId);
  return [harnessExecutable(harnessId, wrapperPath, adapter), adapter?.promptFlag, quoted]
    .filter(Boolean)
    .join(" ");
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
 * 3. Otherwise (a harness declaring neither, or declaring only empty argv) →
 *    `null` — the caller falls back to a fresh launch, and says so.
 */
export function buildResumeCommand(
  adapter: HarnessAdapter,
  harnessSessionId: string | null,
  wrapperPath: HarnessWrapperPath,
): string | null {
  const executable = harnessExecutable(adapter.id, wrapperPath, adapter);
  if (harnessSessionId && hasResumeArgv(adapter.resume.byId)) {
    return [executable, ...renderResumeArgv(adapter.resume.byId, harnessSessionId)].join(" ");
  }
  if (hasResumeArgv(adapter.resume.latest)) {
    return [executable, ...adapter.resume.latest].join(" ");
  }
  return null;
}

/**
 * {@link buildResumeCommand} for a harness named by id — `null` when
 * `adapterFor` resolves nothing under it.
 *
 * The lookup is the caller's ({@link HarnessAdapterLookup}): resolved against
 * the built-ins alone, a registered harness's resume is not merely unavailable,
 * it is unavailable SILENTLY — every interrupt falls back to a fresh launch
 * that loses the session it claimed to pick up.
 */
export function buildHarnessResumeCommand(
  harnessId: string,
  harnessSessionId: string | null,
  wrapperPath: HarnessWrapperPath,
  adapterFor: HarnessAdapterLookup,
): string | null {
  const parsed = parseHarnessId(harnessId);
  const adapter = parsed ? adapterFor(parsed) : undefined;
  return adapter ? buildResumeCommand(adapter, harnessSessionId, wrapperPath) : null;
}

/**
 * Whether a harness can be resumed at all — the question a UI asks when it
 * decides to offer the action, which is not the question a launch asks.
 *
 * Separate from {@link buildHarnessResumeCommand} because the renderer has no
 * business holding a shell command line, and no way to know where a wrapper
 * lives: those paths are main's. Capability is adapter data, so it answers here
 * without one — but it still cannot invent the adapter, so the same lookup the
 * launch side takes is passed in here, and the two agree by construction.
 */
export function canResumeHarness(
  harnessId: string,
  harnessSessionId: string | null,
  adapterFor: HarnessAdapterLookup,
): boolean {
  const parsed = parseHarnessId(harnessId);
  const adapter = parsed ? adapterFor(parsed) : undefined;
  if (!adapter) return false;
  // `Boolean(id)`, not `id !== null`, so an empty-string seed is "no seed" here
  // exactly as it is in {@link buildResumeCommand} — the two must never
  // disagree about whether the by-id branch is reachable.
  return (
    (Boolean(harnessSessionId) && hasResumeArgv(adapter.resume.byId)) ||
    hasResumeArgv(adapter.resume.latest)
  );
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
