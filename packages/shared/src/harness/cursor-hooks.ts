/**
 * `cursor-agent`'s own `hooks.json` schema, and the one merge that keeps a file
 * the user wrote.
 *
 * Extracted from the installed bundle (`~/.local/share/cursor-agent/versions/
 * <version>/index.js`, module `../hooks/dist/index.js`, plus the executor in
 * `3143.index.js`) rather than from documentation, because the mistake this
 * module exists to correct came from believing a mechanism without reading one
 * binary. What the validator there actually enforces:
 *
 * - the document is `{ version: <positive integer>, hooks: { … } }`; a missing
 *   or non-integer `version` is an error, and so is a key in `hooks` that is
 *   not one of cursor's own event names — one bad key rejects the WHOLE file,
 *   which is why nothing speculative is written into it;
 * - an entry is `{ command }` (a shell command line, `type` defaulting to
 *   `"command"`) or `{ type: "prompt", prompt }`;
 * - `timeout` is in SECONDS, not milliseconds — the executor multiplies it by
 *   1000 — and defaults to 60;
 * - `loop_limit` is a positive integer or `null`, and `undefined` is NOT the
 *   same as `null`: on `stop` and `subagentStop` an absent limit means 5, after
 *   which the hook is skipped. An observer that must not stop observing says
 *   `null` out loud;
 * - `matcher` is a regex string (`""` and `"*"` mean everything), omitted here
 *   because none of the bound events filters on a tool name;
 * - unknown keys on an ENTRY are ignored, which is what makes {@link
 *   VOLLI_MARKER_KEY} possible.
 *
 * The payload reaches the command on **stdin** as JSON, carrying `session_id`,
 * `hook_event_name`, `workspace_roots` and `transcript_path`; the command runs
 * with cwd set to the workspace and `CURSOR_PROJECT_DIR` in its environment.
 */

/**
 * The document version cursor validates. A positive integer is all it requires;
 * `1` is what its own claude-compat transformer emits.
 */
const CURSOR_HOOKS_VERSION = 1;

/**
 * The key that says an entry is Volli's. Cursor ignores unknown entry fields,
 * so this survives its validator untouched — and it is the only way a rewrite
 * can tell an entry it wrote last boot (with a socket path that has since
 * changed) from one the user wrote by hand. Matching on the command string
 * instead would strand every stale entry the moment the socket moved.
 */
export const VOLLI_MARKER_KEY = "volli";

/** One command hook, in the shape cursor's validator accepts. */
export interface CursorHookEntry {
  readonly type: "command";
  readonly command: string;
  /** Seconds. Cursor multiplies by 1000; a millisecond value here is a 5000-second hook. */
  readonly timeout: number;
  /** `null`, never absent — see the module comment on `stop`'s implicit limit of 5. */
  readonly loop_limit: null;
  readonly [VOLLI_MARKER_KEY]: number;
}

/** A command hook Volli owns, for `native` cursor event name and `command`. */
export function cursorHookEntry(command: string, timeoutMs: number): CursorHookEntry {
  return {
    type: "command",
    command,
    timeout: Math.max(1, Math.ceil(timeoutMs / 1000)),
    loop_limit: null,
    [VOLLI_MARKER_KEY]: CURSOR_HOOKS_VERSION,
  };
}

/** Native-event-name → entries, the only shape `hooks` may take. */
export type CursorHookMap = Readonly<Record<string, readonly CursorHookEntry[]>>;

/** The whole file, as cursor's validator wants to read it. */
export function renderCursorHooks(hooks: CursorHookMap): string {
  return `${JSON.stringify({ version: CURSOR_HOOKS_VERSION, hooks }, null, 2)}\n`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isVolliEntry(value: unknown): boolean {
  return isPlainObject(value) && VOLLI_MARKER_KEY in value;
}

/** The `hooks` map of a parsed document, or `null` when it has none. */
function hooksOf(document: Record<string, unknown>): Record<string, unknown> | null {
  const hooks = document["hooks"];
  return isPlainObject(hooks) ? hooks : null;
}

export type CursorHooksMerge =
  | { readonly ok: true; readonly content: string }
  /** The file on disk is not a hooks document Volli can safely rewrite. */
  | { readonly ok: false; readonly reason: string };

/**
 * `desired` folded into whatever is already at the path.
 *
 * Volli's entries REPLACE Volli's entries and are appended after everyone
 * else's, so a rewrite is idempotent (the socket path moves between boots and
 * the file must not grow an entry each time) and the user's own hooks keep
 * running. Their other top-level keys survive; only the events Volli binds are
 * touched, and an event they bound that Volli does not is left exactly as is.
 *
 * A file that will not parse is REFUSED rather than replaced. Cursor strips
 * line and block comments before parsing this file, so a commented file still
 * works for cursor while `JSON.parse` rejects it — and quietly discarding
 * someone's commented configuration is the one outcome worse than not
 * installing a hook.
 */
export function mergeCursorHooks(existing: string | null, desired: string): CursorHooksMerge {
  if (existing === null || existing.trim().length === 0) return { ok: true, content: desired };
  let parsed: unknown;
  try {
    parsed = JSON.parse(existing);
  } catch {
    return { ok: false, reason: "existing .cursor/hooks.json is not valid JSON" };
  }
  if (!isPlainObject(parsed)) {
    return { ok: false, reason: "existing .cursor/hooks.json is not an object" };
  }
  const currentHooks = hooksOf(parsed);
  if (currentHooks === null) {
    return { ok: false, reason: "existing .cursor/hooks.json has no hooks object" };
  }
  // `desired` is always this module's own render, so its shape is not in
  // question — only the file on disk is.
  const ours = (JSON.parse(desired) as { hooks: Record<string, unknown[]> }).hooks;

  const merged: Record<string, unknown> = {};
  for (const [event, entries] of Object.entries(currentHooks)) {
    // Theirs, minus anything a previous boot of Volli left here.
    merged[event] = Array.isArray(entries)
      ? entries.filter((entry) => !isVolliEntry(entry))
      : entries;
  }
  for (const [event, entries] of Object.entries(ours)) {
    const kept = merged[event];
    merged[event] = Array.isArray(kept) ? [...kept, ...(entries as unknown[])] : entries;
  }
  // `version` is required, and a file that lacked one was already invalid to
  // cursor — supplying it is the one field this merge asserts.
  const document = { ...parsed, version: CURSOR_HOOKS_VERSION, hooks: merged };
  return { ok: true, content: `${JSON.stringify(document, null, 2)}\n` };
}
