/** The hanging verb is view state over the existing transcript, never a new Session fact. */
import type { DynamicToolUIPart, UIMessage } from "ai";
import { readActivityDescriptor, type SessionPresentationProjection } from "@volli/shared";
import { isRowActive, type LiveTranscriptCompaction } from "@volli/session-presentation";

// Approved liquid-island vocabulary. Git is constrained to the operation actually requested below.
export const TURN_ACTIVITY_POOLS = {
  reason: ["Mulling", "Pondering", "Puzzling", "Weighing", "Musing", "Thinking"],
  read: ["Perusing", "Poring over", "Leafing through", "Studying", "Skimming", "Reading"],
  search: ["Combing", "Hunting", "Rummaging", "Sifting", "Tracking down", "Searching"],
  edit: ["Tinkering", "Tweaking", "Reworking", "Patching", "Honing", "Editing"],
  write: ["Drafting", "Sketching", "Composing", "Penning", "Writing"],
  run: ["Running", "Executing", "Firing off", "Kicking off", "Spinning up"],
  test: ["Vetting", "Checking", "Proving", "Poking at", "Testing"],
  build: ["Building", "Compiling", "Assembling", "Type-checking"],
  web: ["Scouting", "Looking up", "Fetching", "Researching", "Browsing"],
  browser: ["Steering", "Navigating", "Clicking through"],
  shot: ["Snapping"],
  delegate: ["Handing off", "Enlisting", "Briefing", "Delegating"],
  awaitSub: ["Standing by", "Awaiting", "Holding", "Waiting"],
  reply: ["Wording", "Phrasing", "Replying", "Writing"],
  compact: ["Distilling", "Condensing", "Tidying", "Compacting"],
  install: ["Installing", "Fetching deps", "Unpacking"],
  git: ["Committing", "Stashing", "Branching", "Pushing"],
  code: ["Scripting", "Orchestrating", "Batching"],
  askUser: ["Asking", "Checking in"],
} as const;

export type TurnActivityKind = keyof typeof TURN_ACTIVITY_POOLS;
export interface TurnActivity {
  /** Stable activity identity, not a streaming-frame or word identity. */
  key: string;
  activity: TurnActivityKind;
  word: string;
  preposition?: string;
  payload: string | null;
  waiting: boolean;
  /** Semantic category, not the rotating synonym. Never truncate the accessible announcement. */
  announcement: string;
}

/** Structurally accepts the corresponding fields of useSessionController's SessionView. */
export interface TurnActivityInput {
  messages: readonly UIMessage[];
  working: boolean;
  turnActive: boolean;
  projection: {
    turnActive: boolean;
    interactions: {
      active: readonly Pick<
        SessionPresentationProjection["interactions"]["active"][number],
        "id" | "kind"
      >[];
    };
  } | null;
  liveCompaction: Pick<LiveTranscriptCompaction, "throughSequence"> | null;
}

interface ActivityEvent {
  key: string;
  activity: TurnActivityKind;
  callId?: string;
  payload: string | null;
  /** Git words name different operations, not synonyms. */
  word?: string;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** FNV-1a, the mock's stable call-id hash. */
export function turnActivityHash(id: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function pickTurnActivityWord(
  activity: TurnActivityKind,
  callId?: string,
  previous?: string,
): string {
  const pool: readonly string[] = TURN_ACTIVITY_POOLS[activity];
  if (!callId) return pool[0]!;
  let index = turnActivityHash(callId) % pool.length;
  if (pool.length > 1 && pool[index] === previous) index = (index + 1) % pool.length;
  return pool[index]!;
}

/** Conservative shell recognition: never infer an operation from a quoted argument or a pipeline. */
function commandWords(command: string): string[] | null {
  const words: string[] = [];
  let word = "";
  let quote = "";
  let escaped = false;
  let inWord = false;
  for (const char of command.trim()) {
    if (escaped) {
      word += char;
      escaped = false;
    } else if (char === "\\" && quote !== "'") {
      escaped = true;
      inWord = true;
    } else if (quote) {
      if (char === quote) quote = "";
      else if (quote === '"' && (char === "$" || char === "`")) return null;
      else word += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      inWord = true;
    } else if (/[|;&<>\n$`]/u.test(char)) {
      return null;
    } else if (/\s/u.test(char)) {
      if (inWord) words.push(word);
      word = "";
      inWord = false;
    } else {
      word += char;
      inWord = true;
    }
  }
  if (quote || escaped) return null;
  if (inWord) words.push(word);
  while (words[0] && /^[A-Za-z_][A-Za-z_0-9]*=/u.test(words[0])) words.shift();
  return words;
}

/** Options with values which can precede a package-manager subcommand. Unknown ones degrade to run. */
function managerCommand(args: readonly string[]): string[] {
  const rest = [...args];
  if (rest[0] === "run" || rest[0] === "exec") rest.shift();
  while (rest[0]?.startsWith("-")) {
    const option = rest.shift()!;
    if (["-C", "--dir", "--prefix", "--filter", "-F", "--workspace", "-w"].includes(option)) {
      rest.shift();
    } else if (!option.includes("=")) {
      return [];
    }
  }
  if (rest[0] === "run" || rest[0] === "exec") rest.shift();
  return rest;
}

function classifyCommand(command: string): Pick<ActivityEvent, "activity" | "word" | "payload"> {
  const fallback = { activity: "run" as const, payload: command };
  const words = commandWords(command);
  if (!words?.length) return fallback;
  const executable = words[0]!.split("/").at(-1);
  let args = words.slice(1);
  if (executable === "git") {
    while (
      args[0] === "-C" ||
      args[0] === "-c" ||
      args[0] === "--git-dir" ||
      args[0] === "--work-tree"
    ) {
      args = args.slice(2);
    }
    const operation = args[0];
    // Status, diff, log, fetch, checkout of an existing branch, etc. stay Running <command>.
    // Never roll a random Git verb and claim status is a commit or a push.
    const word =
      operation === "commit" && !args.some((arg) => ["--dry-run", "--help", "-h"].includes(arg))
        ? "Committing"
        : operation === "push" &&
            !args.some((arg) => ["--dry-run", "-n", "--help", "-h"].includes(arg))
          ? "Pushing"
          : operation === "stash" && (!args[1] || ["push", "save"].includes(args[1]))
            ? "Stashing"
            : (operation === "branch" &&
                  args.length === 2 &&
                  args[1] &&
                  !args[1].startsWith("-")) ||
                (operation === "switch" && (args[1] === "-c" || args[1] === "--create")) ||
                (operation === "checkout" && args[1] === "-b")
              ? "Branching"
              : undefined;
    return word ? { activity: "git", word, payload: command } : fallback;
  }
  if (executable === "rg" || executable === "grep") return { activity: "search", payload: command };
  if (["pnpm", "npm", "yarn", "bun", "vp"].includes(executable ?? "")) {
    args = managerCommand(args);
    if (["install", "add", "ci"].includes(args[0] ?? ""))
      return { activity: "install", payload: command };
    if (["test", "vitest", "jest", "playwright"].includes(args[0] ?? ""))
      return { activity: "test", payload: command };
    if (["build", "typecheck", "tsc"].includes(args[0] ?? ""))
      return { activity: "build", payload: command };
  }
  if (
    ["vitest", "jest", "pytest"].includes(executable ?? "") ||
    (["cargo", "go"].includes(executable ?? "") && args[0] === "test")
  ) {
    return { activity: "test", payload: command };
  }
  if (executable === "tsc" || (["cargo", "go"].includes(executable ?? "") && args[0] === "build")) {
    return { activity: "build", payload: command };
  }
  return fallback;
}

/** Pi's part.toolName is normally volli.activity; the native name lives in its descriptor. */
function toolEvent(part: DynamicToolUIPart, key: string): ActivityEvent {
  const descriptor = readActivityDescriptor(part.toolMetadata);
  const nativeName = descriptor?.nativeToolName ?? part.toolName;
  const input = record(part.input);
  const subject = descriptor?.subject;
  const path = subject?.path ?? text(input.path) ?? text(input.file_path) ?? subject?.label ?? null;
  // File activities name the file, not its entire worktree path; the transcript owns full paths.
  const basename = path?.split(/[/\\]/u).findLast((segment) => segment.length > 0) ?? path;
  const base = { key, callId: part.toolCallId, payload: null };
  const event = (activity: TurnActivityKind, payload: string | null = null): ActivityEvent => ({
    ...base,
    activity,
    payload,
  });
  if (
    ["bash", "execute", "shell_start"].includes(nativeName) ||
    (descriptor?.kind === "run-command" && !["shell_output", "shell_kill"].includes(nativeName))
  ) {
    const command = text(input.command) ?? subject?.label;
    return command ? { ...base, ...classifyCommand(command) } : event("run");
  }
  if (nativeName === "codemode" || nativeName === "code_mode") return event("code");
  if (nativeName === "ask_user" || nativeName === "request_secret") return event("askUser");
  if (nativeName === "session_await" || nativeName === "ticket_await") return event("awaitSub");
  if (
    nativeName === "web_search" ||
    nativeName === "web_fetch" ||
    descriptor?.kind === "fetch-url"
  ) {
    return event("web", text(input.query) ?? text(input.url) ?? subject?.label ?? null);
  }
  if (nativeName === "browser_screenshot" || descriptor?.browse?.action === "screenshot") {
    return event("shot", descriptor?.browse?.url ?? text(input.url));
  }
  if (nativeName.startsWith("browser_") || descriptor?.kind === "browse") {
    return event("browser", descriptor?.browse?.url ?? text(input.url));
  }
  if (nativeName === "session_delegate" || descriptor?.kind === "delegate") {
    return event("delegate", subject?.agentName ?? text(input.title) ?? subject?.label ?? null);
  }
  switch (descriptor?.kind) {
    case "read-file":
      return event("read", basename);
    case "edit-file":
      return event("edit", basename);
    case "write-file":
      return event("write", basename);
    case "search":
      return event("search", text(input.query) ?? text(input.pattern) ?? subject?.label ?? null);
    case "list-directory":
      return event("read", basename);
  }
  if (nativeName === "read") return event("read", basename);
  if (nativeName === "edit") return event("edit", basename);
  if (nativeName === "write") return event("write", basename);
  // Unknown tools retain their real name, rather than pretending they are reasoning or Code Mode.
  return event("run", nativeName);
}

const ANNOUNCEMENT: Record<TurnActivityKind, string> = {
  reason: "Reasoning",
  read: "Reading",
  search: "Searching",
  edit: "Editing",
  write: "Writing",
  run: "Running",
  test: "Running tests",
  build: "Building or typechecking",
  web: "Accessing the web",
  browser: "Using the browser",
  shot: "Taking a screenshot",
  delegate: "Delegating",
  awaitSub: "Waiting on subagents",
  reply: "Writing a reply",
  compact: "Compacting context",
  install: "Installing dependencies",
  git: "Running",
  code: "Running Code Mode",
  askUser: "Waiting for you",
};

function present(event: ActivityEvent, word: string): TurnActivity {
  const preposition =
    event.payload === null
      ? undefined
      : event.activity === "search" && word !== "Tracking down"
        ? "for"
        : event.activity === "delegate" && !["Enlisting", "Briefing"].includes(word)
          ? "to"
          : undefined;
  return {
    key: event.key,
    activity: event.activity,
    word,
    ...(preposition ? { preposition } : {}),
    payload: event.payload,
    waiting: event.activity === "askUser",
    announcement: [
      ANNOUNCEMENT[event.activity],
      event.payload
        ? event.activity === "search"
          ? "for"
          : event.activity === "delegate"
            ? "to"
            : null
        : null,
      event.payload,
    ]
      .filter(Boolean)
      .join(" "),
  };
}

/**
 * Reconstruct picks from transcript order, once per distinct call, not render order.
 * Streaming updates and StrictMode therefore cannot rotate synonyms. Completed calls
 * contribute to repeat avoidance but can never remain the current activity.
 */
export function selectTurnActivity(
  sessionId: string,
  input: TurnActivityInput,
): TurnActivity | null {
  const interaction = input.projection?.interactions.active[0];
  if (interaction)
    return present(
      { key: `${sessionId}:ask:${interaction.id}`, activity: "askUser", payload: null },
      TURN_ACTIVITY_POOLS.askUser[0],
    );
  if (input.liveCompaction)
    return present(
      {
        key: `${sessionId}:compact:${input.liveCompaction.throughSequence}`,
        activity: "compact",
        payload: null,
      },
      TURN_ACTIVITY_POOLS.compact[0],
    );
  // The stream/lifecycle own the live turn. A retained presentation snapshot
  // can still say turnActive after recovery has settled and removed a send.
  if (!input.working && !input.turnActive) return null;

  let start = 0;
  let boundary = "opening";
  for (let i = input.messages.length - 1; i >= 0; i -= 1) {
    if (input.messages[i]?.role === "user") {
      start = i + 1;
      boundary = input.messages[i]!.id;
      break;
    }
  }
  const previous = new Map<TurnActivityKind, string>();
  const calls = new Map<string, string>();
  const activeTools = new Map<string, TurnActivity>();
  const settledCalls = new Set<string>();
  let tail: TurnActivity | null = null;
  let lastKey = boundary;
  for (const message of input.messages.slice(start)) {
    if (message.role !== "assistant") continue;
    for (const [index, part] of message.parts.entries()) {
      const key = `${sessionId}:${message.id}:${index}`;
      lastKey = key;
      tail = null;
      if (part.type === "dynamic-tool") {
        const event = toolEvent(
          part,
          part.toolCallId ? `${sessionId}:call:${part.toolCallId}` : key,
        );
        const word =
          event.word ??
          calls.get(event.key) ??
          pickTurnActivityWord(event.activity, event.callId, previous.get(event.activity));
        if (!calls.has(event.key)) previous.set(event.activity, word);
        calls.set(event.key, word);
        // Match the transcript's work-window ownership: a durable result wins
        // over an older running overlay of the same call, in either order.
        if (!isRowActive(part)) {
          settledCalls.add(event.key);
          activeTools.delete(event.key);
        } else if (!settledCalls.has(event.key)) {
          activeTools.delete(event.key);
          activeTools.set(event.key, present(event, word));
        }
      } else if (part.type === "reasoning" && part.state === "streaming") {
        tail = present({ key, activity: "reason", payload: null }, TURN_ACTIVITY_POOLS.reason[0]);
      } else if (part.type === "text" && part.state === "streaming") {
        tail = present({ key, activity: "reply", payload: null }, TURN_ACTIVITY_POOLS.reply[0]);
      }
    }
  }
  return (
    [...activeTools.values()].at(-1) ??
    tail ??
    present(
      { key: `${sessionId}:reason:${lastKey}`, activity: "reason", payload: null },
      TURN_ACTIVITY_POOLS.reason[0],
    )
  );
}

/** Read the same committed boundary the transcript already consumes, including remote stops. */
export function selectTurnExitKind(
  frames: readonly { event: { payload: { kind: string } } | null }[],
): "done" | "abort" {
  const boundary = frames.findLast((frame) => {
    const kind = frame.event?.payload.kind;
    return kind === "turn.started" || kind === "turn.completed" || kind === "turn.interrupted";
  });
  return boundary?.event?.payload.kind === "turn.interrupted" ? "abort" : "done";
}

/** Only the mock's command and reasoning pools escalate; tests/builds/waits do not. */
export function escalateTurnActivity(activity: TurnActivity): TurnActivity {
  const word =
    activity.activity === "reason"
      ? "Deep in thought"
      : activity.activity === "run"
        ? "Still running"
        : null;
  if (!word) return activity;
  return { ...activity, word };
}

/** Pure middle truncation. Width may be pixels (canvas measureText) or character units in tests. */
export function middleTruncatePayload(
  payload: string,
  maxWidth: number,
  measure: (text: string) => number = (value) => Array.from(value).length,
): string {
  if (maxWidth <= 0) return "";
  if (measure(payload) <= maxWidth) return payload;
  if (measure("…") > maxWidth) return "";
  const chars = Array.from(payload);
  for (let keep = chars.length - 1; keep > 0; keep -= 1) {
    const head = Math.ceil(keep * 0.35);
    const candidate = `${chars.slice(0, head).join("")}…${chars.slice(chars.length - (keep - head)).join("")}`;
    if (measure(candidate) <= maxWidth) return candidate;
  }
  return "…";
}
