/**
 * VC-30 — the sessions behind the sidebar-integration scratch.
 *
 * WHAT THIS HAS TO SHOW, and so what it is shaped around:
 *
 *   • Both bands. Five Sessions land in Active (a question, two working, an
 *     interrupted turn, a quiet Board Session) and thirteen in Previous, and
 *     the shipped `buildActiveSessionListing` decides which is which — nothing
 *     here assigns a band.
 *   • Folders of every size the band holds: one ticket with four Sessions, two
 *     with two, two with one, and one ticketless Session sitting at the top
 *     level between them (VC-54 keeps those ungrouped).
 *   • The case the peek exists for. VLT-11 holds three Sessions titled `Chat`
 *     — 45% of the real corpus is still called that (see the VC-69 scratch) —
 *     so the folder's rows tell a reader nothing, and only what each Session
 *     DID can.
 *   • Two Sessions of one ticket live at once (VLT-14: one asking, one
 *     working). VC-69 left telling those apart to the peek rather than to a
 *     hierarchy; this is where that is judged.
 *   • The ticket open in the right rail (VLT-14) has live rows AND a folded
 *     record, including a closed terminal companion with nothing to reply to.
 *
 * The copy is the peek's CONTENT and is fixture, deliberately: a summary's
 * freshness and truth are runtime contracts this lab cannot model (see the
 * v2 README). The time is the lab's frozen `NOW`, so ages read identically on
 * every load.
 */
import {
  type ChatSessionRecord,
  type ChatWaitingReason,
  type HarnessId,
  type SessionInteractionPrompt,
  type SessionRecord,
} from "@volli/shared";

import type { BuildActiveSessionListingInput } from "@renderer/components/sidebar/active-session-listing";

import { NOW, project, tickets } from "../fixtures";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The vendors a row's mark can be drawn for — `providerMark`'s ids. */
export type VendorId = "anthropic" | "openai-codex" | "zai" | "opencode-go" | "github-copilot";

export const VENDOR_LABEL: Record<VendorId, string> = {
  anthropic: "Anthropic",
  "openai-codex": "OpenAI",
  zai: "Z.ai",
  "opencode-go": "OpenCode",
  "github-copilot": "GitHub Copilot",
};

/**
 * A terminal companion is drawn with its harness's VENDOR, which is what the
 * VC-402 decision chose over the Phosphor mnemonics. Only the two harnesses
 * this corpus runs are mapped; a custom slug would keep the terminal glyph.
 */
const HARNESS_VENDOR: Partial<Record<HarnessId, VendorId>> = {
  "claude-code": "anthropic",
  codex: "openai-codex",
};

export interface CorpusMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
}

/** Everything a row and its peek need about one Session, beyond the listing's own row. */
export interface CorpusSession {
  readonly id: string;
  readonly kind: "chat" | "terminal";
  readonly vendor: VendorId;
  /** What the peek's header names: the model for a chat, the harness for a terminal. */
  readonly runs: { readonly modelId: string; readonly label: string };
  readonly summary: string;
  readonly messages: readonly CorpusMessage[];
  readonly question: { readonly prompts: readonly SessionInteractionPrompt[] } | null;
  readonly failure: string | null;
}

const INTERRUPTED =
  "Turn ended without a reply — the executor exited while the model was streaming.";

const OPUS = { modelId: "claude-opus-5", label: "Opus 5" };
const SOL = { modelId: "gpt-6-sol", label: "GPT 6 Sol" };
const GLM = { modelId: "glm-5.3", label: "GLM 5.3" };
const OPENCODE = { modelId: "kimi-k3", label: "Kimi K3" };
const COPILOT = { modelId: "gpt-6-mini", label: "GPT 6 mini" };

const GUTTER_QUESTION: SessionInteractionPrompt = {
  id: "gutter-fix",
  label: "Which fix should land first?",
  detail: null,
  options: [
    {
      id: "scroll-end",
      label: "Recompute on scroll end",
      description: "Small change; marks lag one frame during a flick",
    },
    {
      id: "virtual-viewport",
      label: "Render from the virtual viewport",
      description: "No lag; touches the renderer's range API",
    },
  ],
  multiple: false,
  custom: true,
};

/** What the replay-test Session asks when the scratch's script reaches it. */
const REPLAY_QUESTION: SessionInteractionPrompt = {
  id: "replay-home",
  label: "Where should the scroll-replay test live?",
  detail: null,
  options: [
    {
      id: "beside",
      label: "Beside the gutter",
      description: "Fast, runs with the unit suite; replays recorded frames",
    },
    {
      id: "e2e",
      label: "In the end-to-end suite",
      description: "Real scrolling in a window; slower and only in CI",
    },
  ],
  multiple: false,
  custom: true,
};

interface Seed {
  readonly id: string;
  readonly ticketId: string | null;
  readonly title: string;
  readonly vendor: VendorId;
  readonly runs: { readonly modelId: string; readonly label: string };
  readonly ago: number;
  readonly activity?: ChatSessionRecord["activity"];
  readonly waitingOn?: ChatWaitingReason;
  readonly live?: boolean;
  readonly ask: string;
  readonly summary: string;
  readonly reply?: string;
  readonly question?: SessionInteractionPrompt;
}

/**
 * The chats, newest first within each band. `ask` is the person's opening
 * message and `reply` the agent's last (defaulting to the summary's substance),
 * which is all the conversation overlay needs to be a conversation.
 */
const CHAT_SEEDS: readonly Seed[] = [
  // ---------------------------------------------------------------- Active
  {
    id: "chat-a1",
    ticketId: "tkt-14",
    title: "Trace the dropped decorations back to the debounce",
    vendor: "anthropic",
    runs: OPUS,
    ago: 2 * MINUTE,
    activity: "waiting",
    waitingOn: "question",
    live: true,
    ask: "Find out why the diff gutter drops decorations when I scroll fast. Don't change the renderer yet.",
    summary:
      "Traced the missing gutter marks to the 16 ms scroll debounce: marks are computed for the viewport it last saw, not the one on screen. Two fixes are ready; nothing committed.",
    reply:
      "The decorations are computed from the viewport the scroll debounce last observed. During a flick the renderer paints three or four frames ahead of it, so those frames have no marks.\n\nI can recompute on scroll end, which is a small change but leaves a one-frame lag, or render marks from the virtual viewport, which removes the lag but touches the renderer's range API.",
    question: GUTTER_QUESTION,
  },
  {
    id: "chat-a2",
    ticketId: "tkt-14",
    title: "Chat",
    vendor: "openai-codex",
    runs: SOL,
    ago: 20 * SECOND,
    activity: "working",
    live: true,
    ask: "Write a test that reproduces the gutter drop so the fix has something to pass.",
    summary:
      "Writing a scroll-replay test for the gutter: it records a 40-line flick and asserts every visible hunk keeps its marker. The first run reproduces the drop on 3 of 40 frames.",
    // Working at load; the scratch's script has it ask this part-way through.
    question: REPLAY_QUESTION,
  },
  {
    id: "chat-a3",
    ticketId: "tkt-12",
    title: "Warm-park timer and the keep-awake flag",
    vendor: "anthropic",
    runs: OPUS,
    ago: 1 * MINUTE,
    activity: "working",
    live: true,
    ask: "Implement the plan: the park timer belongs to the session, and keep-awake should stop a park rather than undo it.",
    summary:
      "Moved the park timer from the pane to the Session, so a split no longer resets it. Keep-awake now blocks the park instead of waking the Session afterwards; running the park tests.",
  },
  {
    id: "chat-a4",
    ticketId: "tkt-13",
    title: "Chat",
    vendor: "zai",
    runs: GLM,
    ago: 14 * MINUTE,
    activity: "interrupted",
    live: false,
    ask: "Why does focus land in the wrong split pane after the GPU resets?",
    summary:
      "Read the device-loss handler and the focus ledger, then began comparing restored pane ids with the saved ones when the turn ended.",
    reply:
      "The device-loss handler restores panes in creation order, and the focus ledger stores an index rather than a pane id. I was comparing the two when",
  },
  {
    id: "chat-a5",
    ticketId: null,
    title: "Backlog scan and progress",
    vendor: "opencode-go",
    runs: OPENCODE,
    ago: 22 * MINUTE,
    activity: "idle",
    live: true,
    ask: "Go through the backlog and tell me what can be closed. Don't close anything.",
    summary:
      "Scanned 31 backlog tickets: 6 have merged PRs linked and look closable, and 4 duplicate newer tickets. Listed them for review; nothing was moved.",
  },
  // -------------------------------------------------------------- Previous
  {
    id: "chat-p3",
    ticketId: "tkt-11",
    title: "Chat",
    vendor: "anthropic",
    runs: OPUS,
    ago: 50 * MINUTE,
    ask: "The reviewer asks why the padding key is read so late. Answer on the PR.",
    summary:
      "Answered the reviewer: window-padding-balance only applies once the cell grid leaves slack, so the adapter reads it after sizing. Posted the reply; no code changed.",
  },
  {
    id: "chat-p1",
    ticketId: "tkt-14",
    title: "Reproduce the gutter flicker",
    vendor: "anthropic",
    runs: OPUS,
    ago: 2 * HOUR,
    ask: "Get me a reliable repro for the gutter flicker.",
    summary:
      "Reproduced the flicker on a 3,000-line diff at 120 Hz; it never happens at 60 Hz. Saved the trace and the file that triggers it.",
  },
  {
    id: "chat-p4",
    ticketId: "tkt-11",
    title: "Chat",
    vendor: "anthropic",
    runs: OPUS,
    ago: 3 * HOUR,
    ask: "Add window-padding-balance to the Ghostty adapter.",
    summary:
      "Added window-padding-balance to the Ghostty adapter with tests for odd and even slack. Opened the PR; CI is green.",
  },
  {
    id: "chat-p7",
    ticketId: "tkt-10",
    title: "Code review",
    vendor: "anthropic",
    runs: OPUS,
    ago: 4 * HOUR,
    ask: "Review the hover-state fix on this branch.",
    summary:
      "Reviewed the hover fix: the priority icon survives hover because the card no longer swaps its class list. One nit about a magic number; approved otherwise.",
  },
  {
    id: "chat-p8",
    ticketId: null,
    title: "v0.1.0 launch tickets",
    vendor: "anthropic",
    runs: OPUS,
    ago: 6 * HOUR,
    activity: "stopped",
    ask: "Turn the release checklist into tickets.",
    summary: "Drafted 12 launch tickets from the release checklist and filed them in Backlog.",
  },
  {
    id: "chat-p5",
    ticketId: "tkt-11",
    title: "Review fixes",
    vendor: "openai-codex",
    runs: SOL,
    ago: 1 * DAY + 2 * HOUR,
    ask: "Address the two review threads and rebase.",
    summary:
      "Renamed the padding helper, dropped the unused x offset and rebased on main. Both review threads resolved.",
  },
  {
    id: "chat-p9",
    ticketId: "tkt-12",
    title: "Scope and plan",
    vendor: "anthropic",
    runs: OPUS,
    ago: 1 * DAY + 5 * HOUR,
    ask: "Plan warm-parking before anyone writes code.",
    summary:
      "Agreed the park timer belongs to the Session, not the pane. Wrote a four-step plan with test cases for splits and keep-awake.",
  },
  {
    id: "chat-p6",
    ticketId: "tkt-11",
    title: "Chat",
    vendor: "zai",
    runs: GLM,
    ago: 2 * DAY + 3 * HOUR,
    activity: "interrupted",
    ask: "Where does the Ghostty parser normalise padding keys?",
    summary:
      "Started reading the Ghostty config parser for where padding keys are normalised; the turn ended before it reported anything.",
    reply: "The parser lowercases every key before",
  },
  {
    id: "chat-p11",
    ticketId: "tkt-9",
    title: "Chat",
    vendor: "github-copilot",
    runs: COPILOT,
    ago: 3 * DAY + 1 * HOUR,
    ask: "How do other tools remember which agent you picked?",
    summary:
      "Compared three other tools: all of them store the last harness per project, with a global fallback. Recommended the same.",
  },
  {
    id: "chat-p12",
    ticketId: "tkt-9",
    title: "Compare per-project and global harness defaults",
    vendor: "anthropic",
    runs: OPUS,
    ago: 3 * DAY + 4 * HOUR,
    ask: "Why do projects keep overwriting each other's harness choice?",
    summary:
      "The picker writes the global default on every launch, which is why projects overwrite each other. The fix is a per-project key with a global fallback.",
  },
  {
    id: "chat-p13",
    ticketId: "tkt-7",
    title: "Spike: fuzzy scorer",
    vendor: "opencode-go",
    runs: OPENCODE,
    ago: 5 * DAY,
    ask: "Try a couple of fuzzy scorers on real ticket titles.",
    summary:
      "Ran two fuzzy scorers over 400 real ticket titles. Subsequence ranks the intended ticket first 91% of the time, trigram 78%.",
  },
];

interface TerminalSeed {
  readonly id: string;
  readonly ticketId: string;
  readonly title: string;
  readonly harnessId: HarnessId;
  readonly ranFor: number;
  readonly endedAgo: number;
  readonly exitCode: number;
}

/** Closed terminal companions — a record to read, never a Session to answer. */
const TERMINAL_SEEDS: readonly TerminalSeed[] = [
  {
    id: "term-p2",
    ticketId: "tkt-14",
    title: "Session 1",
    harnessId: "claude-code",
    ranFor: 72 * MINUTE,
    endedAgo: 1 * DAY + 1 * HOUR,
    exitCode: 0,
  },
  {
    id: "term-p10",
    ticketId: "tkt-12",
    title: "Session 1",
    harnessId: "codex",
    ranFor: 8 * MINUTE,
    endedAgo: 2 * DAY + 2 * HOUR,
    exitCode: 1,
  },
];

const HARNESS_NAME: Partial<Record<HarnessId, string>> = {
  "claude-code": "Claude Code",
  codex: "Codex",
};

function chatRecord(seed: Seed): ChatSessionRecord {
  const lastActivityAt = NOW - seed.ago;
  return {
    sessionId: seed.id,
    projectId: project.id,
    ticketId: seed.ticketId,
    title: seed.title,
    createdAt: lastActivityAt - 40 * MINUTE,
    adapterId: "pi",
    live: seed.live ?? false,
    activity: seed.activity ?? "idle",
    waitingOn: seed.waitingOn ?? null,
    outcome: seed.activity === "interrupted" ? "interrupted" : null,
    lastActivityAt,
    bornTicketless: seed.ticketId === null,
    role: seed.ticketId === null ? "project" : "ticket",
    parentSessionId: null,
    model: { providerId: seed.vendor, modelId: seed.runs.modelId, reasoningLevel: "medium" },
  };
}

function terminalRecord(seed: TerminalSeed): SessionRecord {
  const endedAt = NOW - seed.endedAgo;
  return {
    id: seed.id,
    projectId: project.id,
    ticketId: seed.ticketId,
    harnessId: seed.harnessId,
    activeHarnessId: null,
    harnessSessionId: null,
    launchKind: "agent",
    placement: "tab",
    title: seed.title,
    cwd: `${project.path}-worktrees/${seed.ticketId}`,
    createdAt: endedAt - seed.ranFor,
    endedAt,
    exitCode: seed.exitCode,
    lastActivityAt: endedAt,
    bornTicketless: false,
  };
}

export const CHAT_RECORDS: readonly ChatSessionRecord[] = CHAT_SEEDS.map(chatRecord);
export const TERMINAL_RECORDS: readonly SessionRecord[] = TERMINAL_SEEDS.map(terminalRecord);

function minutes(ms: number): string {
  const total = Math.round(ms / MINUTE);
  return total < 60 ? `${total} min` : `${Math.floor(total / 60)}h ${total % 60}m`;
}

/** The peek's side of every Session, keyed by the id the listing rows carry. */
export const CORPUS: ReadonlyMap<string, CorpusSession> = new Map<string, CorpusSession>([
  ...CHAT_SEEDS.map((seed): [string, CorpusSession] => [
    seed.id,
    {
      id: seed.id,
      kind: "chat",
      vendor: seed.vendor,
      runs: seed.runs,
      summary: seed.summary,
      messages: [
        { role: "user", text: seed.ask },
        { role: "assistant", text: seed.reply ?? seed.summary },
      ],
      question: seed.question === undefined ? null : { prompts: [seed.question] },
      failure: seed.activity === "interrupted" ? INTERRUPTED : null,
    },
  ]),
  ...TERMINAL_SEEDS.map((seed): [string, CorpusSession] => {
    const harness = HARNESS_NAME[seed.harnessId] ?? seed.harnessId;
    return [
      seed.id,
      {
        id: seed.id,
        kind: "terminal",
        vendor: HARNESS_VENDOR[seed.harnessId] ?? "anthropic",
        runs: { modelId: seed.harnessId, label: harness },
        // A terminal has no transcript the peek could summarise, so it says the
        // two facts the record does hold — and says it has nothing more.
        summary: `${harness} in a terminal. Exited ${seed.exitCode} after ${minutes(seed.ranFor)}; open it to read the scrollback.`,
        messages: [],
        question: null,
        failure: null,
      },
    ];
  }),
]);

/**
 * The listing's input: the shipped builder reads exactly what the app hands
 * it, minus the clock and the filter the scratch owns.
 *
 * No `statusEnteredAt`: without column history both cleanup rules stay silent,
 * so every Session survives to be drawn — which rows cleanup would hide is
 * VC-69's question, not this one's.
 */
export const LISTING_INPUT: Omit<BuildActiveSessionListingInput, "now" | "filter"> = {
  tickets,
  containers: {},
  signalsByTicket: {},
  records: TERMINAL_RECORDS,
  chatSessions: CHAT_RECORDS,
  lastOutputAt: {},
  parkState: {},
  harness: {},
  statusEnteredAt: new Map(),
};

/** The ticket the right rail opens on: live rows, a question, and a record with a terminal. */
export const RAIL_TICKET_ID = "tkt-14";
