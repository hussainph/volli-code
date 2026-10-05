import {
  ERROR_RECOVERY,
  formatSessionOrigin,
  decodeSessionStopDetail,
  sessionStopSummary,
  isAgentMutationPlan,
  LEGACY_DOCTOR_REMEDY,
  legacyDoctorFailureTitle,
  readSessionOrigin,
  SESSION_ENV_TOOLS,
  TICKET_STATUS_LABELS,
  untrustedProseResponseLines,
} from "@volli/shared";
import type {
  AgentError,
  AgentErrorCode,
  DoctorCheck,
  SessionEnvRepair,
  TicketStatus,
} from "@volli/shared";

import { renderDoctorReport } from "./doctor";

/**
 * v1 output contract (decision 6): output is identical on a TTY and on a
 * pipe — plain, stable, uncolored — so the spec's non-TTY guarantees
 * (untruncated, parseable, no color codes) hold universally rather than
 * only when stdout isn't a terminal. A distinct TTY-pretty mode is
 * deliberate future work, not a gap in this contract.
 */
export interface RenderOptions {
  json: boolean;
  full?: boolean;
}

// ESC/OSC/CSI controls can mutate terminal state (including OSC 52 clipboard
// writes), while bidi formatting marks can visually reorder trusted prefixes.
// Preserve the two controls used by our text contract (LF and TAB) and render
// every other terminal-active character visibly.
function isUnsafeTerminalCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0)!;
  return (
    codePoint <= 0x08 ||
    (codePoint >= 0x0b && codePoint <= 0x1f) ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    codePoint === 0x061c ||
    codePoint === 0x200e ||
    codePoint === 0x200f ||
    (codePoint >= 0x2028 && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069)
  );
}

function terminalEscape(character: string): string {
  const codePoint = character.codePointAt(0)!;
  return codePoint <= 0xff
    ? `\\x${codePoint.toString(16).padStart(2, "0")}`
    : `\\u${codePoint.toString(16).padStart(4, "0")}`;
}

function terminalSafeText(text: string): string {
  return Array.from(text, (character) =>
    isUnsafeTerminalCharacter(character) ? terminalEscape(character) : character,
  ).join("");
}

function terminalSafeInline(value: unknown): string {
  return terminalSafeText(String(value)).replaceAll("\t", "\\x09").replaceAll("\n", "\\x0a");
}

function terminalSafeJson(value: unknown): string {
  // JSON's \u escape is data-equivalent after parsing and remains valid JSON.
  return Array.from(JSON.stringify(value), (character) =>
    isUnsafeTerminalCharacter(character)
      ? `\\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`
      : character,
  ).join("");
}

interface TicketListItem {
  id: string;
  status: TicketStatus;
  title: string;
  labels: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function titleCase(value: string): string {
  return value.length === 0 ? value : `${value[0]!.toUpperCase()}${value.slice(1)}`;
}

/** Renders `identify`'s project field: `name (prefix)`, consistent with project.list's leading columns. */
function renderIdentifyProject(value: unknown): string {
  if (isRecord(value) && typeof value["name"] === "string" && typeof value["prefix"] === "string") {
    return `${terminalSafeInline(value["name"])} (${terminalSafeInline(value["prefix"])})`;
  }
  return "-";
}

function renderBoard(data: unknown): string | null {
  if (!isRecord(data) || !isRecord(data["project"]) || !isRecord(data["columns"])) return null;
  const project = data["project"];
  if (typeof project["name"] !== "string" || typeof project["prefix"] !== "string") return null;
  const sections: string[] = [];
  for (const [status, value] of Object.entries(data["columns"])) {
    if (!Array.isArray(value) || value.length === 0) continue;
    const lines = value.filter(isRecord).map((ticket) => {
      const labels = Array.isArray(ticket["labels"])
        ? (ticket["labels"] as unknown[]).filter(
            (label): label is string => typeof label === "string",
          )
        : [];
      return `${terminalSafeInline(ticket["id"])}  ${terminalSafeInline(titleCase(String(ticket["priority"])))}  ${terminalSafeInline(ticket["title"])}${labels.length > 0 ? `  [${labels.map(terminalSafeInline).join(", ")}]` : ""}`;
    });
    const normalizedStatus = status as TicketStatus;
    sections.push(
      `${terminalSafeInline(TICKET_STATUS_LABELS[normalizedStatus] ?? titleCase(status))}\n${lines.join("\n")}`,
    );
  }
  const header = `${terminalSafeInline(project["name"])} (${terminalSafeInline(project["prefix"])})`;
  return `${header}${sections.length > 0 ? `\n\n${sections.join("\n\n")}` : ""}\n`;
}

function ticketList(data: unknown): TicketListItem[] | null {
  if (typeof data !== "object" || data === null) return null;
  const tickets = (data as { tickets?: unknown }).tickets;
  if (!Array.isArray(tickets)) return null;
  return tickets as TicketListItem[];
}

function recordsAt(data: unknown, key: string): Record<string, unknown>[] | null {
  if (!isRecord(data) || !Array.isArray(data[key])) return null;
  return data[key].filter(isRecord);
}

function ticketLine(ticket: Record<string, unknown>): string | null {
  if (
    typeof ticket["id"] !== "string" ||
    typeof ticket["status"] !== "string" ||
    typeof ticket["title"] !== "string"
  ) {
    return null;
  }
  const status = ticket["status"] as TicketStatus;
  const labels = Array.isArray(ticket["labels"])
    ? ticket["labels"].filter((label): label is string => typeof label === "string")
    : [];
  const labelText = labels.length > 0 ? `  [${labels.map(terminalSafeInline).join(", ")}]` : "";
  return `${terminalSafeInline(ticket["id"])}  ${terminalSafeInline(TICKET_STATUS_LABELS[status] ?? titleCase(status))}  ${terminalSafeInline(ticket["title"])}${labelText}`;
}

function renderTicketResult(data: unknown): string | null {
  if (!isRecord(data) || !isRecord(data["ticket"])) return null;
  return ticketLine(data["ticket"]);
}

/** The most prose one ticket-show log field may hand an agent in text mode. */
export const TICKET_SHOW_PROSE_MAX_CHARS = 1_000;

interface TicketLogProse {
  /** The `[n]` token the citing row prints, so a hoisted block names its own row. */
  ref: string;
  label: string;
  text: string;
  truncated: boolean;
}

/**
 * Collects the prose a ticket read surface hoists into its one response-wide
 * envelope, handing each row back the reference token that finds it again.
 *
 * Prose leaves the row it belongs to so the envelope can be stated once, which
 * is what makes a poll cheap. That trade only works if the reader can still
 * pair the two: two `validate` signals or two comments produce blocks whose
 * labels alone would be identical.
 */
interface TicketLogProseCollector {
  /** Bounds and records one block, returning the `[n]` token its row cites. */
  cite(label: string, text: string, uncapped?: boolean): string;
  full: boolean;
  blocks(): readonly TicketLogProse[];
}

function ticketLogProse(full = false): TicketLogProseCollector {
  const blocks: TicketLogProse[] = [];
  return {
    full,
    cite(label, text, uncapped = false) {
      const truncated = !full && !uncapped && text.length > TICKET_SHOW_PROSE_MAX_CHARS;
      const ref = `[${blocks.length + 1}]`;
      blocks.push({
        ref,
        label,
        text: truncated ? text.slice(0, TICKET_SHOW_PROSE_MAX_CHARS) : text,
        truncated,
      });
      return ref;
    },
    blocks: () => blocks,
  };
}

/** The verdict columns shared by ticket.signal's receipt and ticket show's latest-signal rows. */
function ticketSignalLine(signal: Record<string, unknown>): string {
  return ["ticket", "kind", "verdict"]
    .map((field) => (typeof signal[field] === "string" ? terminalSafeInline(signal[field]) : "-"))
    .join("  ");
}

/**
 * Event fields a text row may render bare. Everything else is another author's
 * data below the response-wide envelope, so a newly added free-text payload
 * cannot silently bypass the bound and framing contract.
 */
const TICKET_EVENT_INLINE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  created: ["status"],
  status_changed: ["from", "to"],
  priority_changed: ["from", "to"],
  harness_changed: ["from", "to"],
  // Label names are short tokens this same response already prints bare on the
  // ticket line; quoting them below as prose would say two things about one
  // vocabulary.
  labels_changed: ["added", "removed"],
  body_edited: [],
  archived: [],
  unarchived: [],
  commented: ["commentId"],
  signaled: ["signalKind", "verdict"],
  worktree_changed: ["from", "to"],
  worktree_scope_changed: ["from", "to"],
  worktree_failed: ["stage"],
  worktree_committed: [],
  pr_opened: ["url"],
  pr_merged: ["url"],
  worktree_reclaimed: ["branch", "daysInDone"],
  worktree_trimmed: ["entries", "bytes", "kept"],
  attachment_added: ["attachmentId"],
  attachment_removed: ["attachmentId"],
  session_started: [],
  session_resumed: ["turn", "attachment"],
};

/** Ticket events cross the socket under `payload`; a top-level kind is not an event payload. */
function ticketEventPayload(event: Record<string, unknown>): Record<string, unknown> | null {
  return isRecord(event["payload"]) ? event["payload"] : null;
}

/** One scalar or scalar list as a scan-friendly event field, with no silent record drop. */
function ticketEventValue(value: unknown, full: boolean): string {
  let text: string;
  if (value === null) {
    text = "-";
  } else if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    text = String(value);
  } else if (Array.isArray(value)) {
    text =
      value.length === 0 ? "[]" : value.map((entry) => ticketEventValue(entry, full)).join(",");
  } else {
    text = "<record>";
  }
  // Inline fields are structured facts, not prose, but malformed or future
  // data must still not turn one event line into an unbounded response.
  const bounded =
    !full && text.length > TICKET_SHOW_PROSE_MAX_CHARS
      ? `${text.slice(0, TICKET_SHOW_PROSE_MAX_CHARS)}…`
      : text;
  return terminalSafeInline(bounded);
}

/** Flatten a nested structured fact instead of dropping its identities from the event row. */
function ticketEventFacts(field: string, value: unknown, full: boolean): string[] {
  if (!isRecord(value)) return [`${terminalSafeInline(field)}=${ticketEventValue(value, full)}`];
  const entries = Object.entries(value);
  if (entries.length === 0) return [`${terminalSafeInline(field)}=<empty>`];
  return entries.flatMap(([nestedField, nestedValue]) =>
    ticketEventFacts(`${field}.${nestedField}`, nestedValue, full),
  );
}

/** A readable data representation for a field the response envelope quotes line by line. */
function ticketEventProseText(value: unknown): string {
  if (value === null) return "-";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.length === 0
      ? "(empty)"
      : value.map((entry, index) => `${index + 1}. ${ticketEventProseText(entry)}`).join("\n");
  }
  if (isRecord(value)) {
    const entries = Object.entries(value);
    return entries.length === 0
      ? "(empty)"
      : entries
          .map(([field, nestedValue]) => `${field}: ${ticketEventProseText(nestedValue)}`)
          .join("\n");
  }
  return "<unrenderable>";
}

/** An empty container is a fact the row can state, not prose worth a block of its own. */
function emptyContainerFact(value: unknown): string | null {
  if (Array.isArray(value) && value.length === 0) return "[]";
  if (isRecord(value) && Object.keys(value).length === 0) return "<empty>";
  return null;
}

/** One durable event as columns plus any prose it directs to the response envelope. */
function renderTicketEvent(
  event: Record<string, unknown>,
  prose: TicketLogProseCollector,
): string[] {
  const payload = ticketEventPayload(event);
  const kindValue = payload?.["kind"];
  const kind = typeof kindValue === "string" ? kindValue : "-";
  // Who asked for a Session to start or resume. The origin names the door
  // exactly, so it replaces the actor columns it would only repeat (and for a
  // resume, whose actor context is the Session that asked, would contradict
  // the `session=` the row is about). A launch recorded before origins existed
  // has none: its actor columns are all there is, and they stay.
  const by = payload === null ? null : launchOriginFact(kind, payload, prose.full);
  const metadata: string[] = [];
  if (by === null && typeof event["actor"] === "string") {
    metadata.push(`actor=${terminalSafeInline(event["actor"])}`);
  }
  if (
    by === null &&
    isRecord(event["actorContext"]) &&
    typeof event["actorContext"]["session"] === "string"
  ) {
    metadata.push(
      `${kind === "session_started" ? "by" : "session"}=${terminalSafeInline(event["actorContext"]["session"])}`,
    );
  }
  if (typeof event["createdAt"] === "number") metadata.push(`at=${event["createdAt"]}`);
  if (payload === null) {
    return [["event", "-", "payload=<missing>", ...metadata].join("  ")];
  }

  const inlineFields = new Set(TICKET_EVENT_INLINE_FIELDS[kind] ?? []);
  const facts = Object.entries(payload).flatMap(([field, value]) => {
    if (field === "kind") return [];
    if (field === "origin" && by !== null) return [];
    if (
      (kind === "session_started" || kind === "session_resumed") &&
      (field === "session" || field === "sessionId") &&
      typeof value === "string" &&
      /^(?:[0-9a-f]{8}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(value)
    ) {
      return [`session=${value.slice(0, 8)}`];
    }
    if (inlineFields.has(field)) return ticketEventFacts(field, value, prose.full);
    // An omitted signal detail carries no prose; every other present field is
    // named on the row and handed over as bounded, quoted data below it.
    if (
      field === "detail" &&
      (value === null || (typeof value === "string" && value.trim().length === 0))
    ) {
      return [];
    }
    if (value === null || value === undefined) return [`${terminalSafeInline(field)}=-`];
    const empty = emptyContainerFact(value);
    if (empty !== null) return [`${terminalSafeInline(field)}=${empty}`];
    const ref = prose.cite(
      `event ${terminalSafeInline(kind)} ${terminalSafeInline(field)}`,
      ticketEventProseText(value),
    );
    return [`${terminalSafeInline(field)}=${ref}`];
  });
  return [
    ["event", terminalSafeInline(kind), ...facts, ...(by === null ? [] : [by]), ...metadata].join(
      "  ",
    ),
  ];
}

/**
 * The `by=` column of a Session launch or resume row, or `null` when the event
 * has no readable origin to state.
 *
 * A resume always states one: a stored `null` is a legacy turn whose door
 * recorded nothing, and that is `unknown` — never a person. A Run's name is
 * another party's text, so it arrives quoted by the shared formatter and then
 * passes through the same bound and terminal escaping as every inline field.
 */
function launchOriginFact(
  kind: string,
  payload: Record<string, unknown>,
  full: boolean,
): string | null {
  if (kind !== "session_started" && kind !== "session_resumed") return null;
  const origin = readSessionOrigin(payload["origin"]);
  if (origin !== null) return `by=${ticketEventValue(formatSessionOrigin(origin), full)}`;
  return kind === "session_resumed" ? "by=unknown" : null;
}

function renderTicketSignal(
  signal: Record<string, unknown>,
  prose: TicketLogProseCollector,
): string[] {
  const row = `signal  ${ticketSignalLine(signal)}`;
  if (typeof signal["detail"] !== "string" || signal["detail"].trim().length === 0) return [row];
  // The signal kind is in the label because at most one signal per kind stands
  // on a ticket, which makes it the block's own name rather than a repetition.
  const kind = typeof signal["kind"] === "string" ? terminalSafeInline(signal["kind"]) : "-";
  return [`${row}  detail=${prose.cite(`signal ${kind} detail`, signal["detail"])}`];
}

function renderTicketComment(
  comment: Record<string, unknown>,
  prose: TicketLogProseCollector,
): string[] {
  const metadata = [
    typeof comment["ticket"] === "string" ? terminalSafeInline(comment["ticket"]) : "-",
    typeof comment["actor"] === "string" ? terminalSafeInline(comment["actor"]) : "-",
    typeof comment["session"] === "string"
      ? `session=${terminalSafeInline(comment["session"])}`
      : null,
    typeof comment["createdAt"] === "number" ? `at=${comment["createdAt"]}` : null,
  ].filter((value): value is string => value !== null);
  const row = `comment  ${metadata.join("  ")}`;
  if (typeof comment["body"] !== "string") return [row];
  return [`${row}  body=${prose.cite("ticket comment", comment["body"], true)}`];
}

/** Rows first, then the one envelope that carries every prose block they cite. */
function ticketLogLines(
  response: string,
  rows: readonly string[],
  prose: TicketLogProseCollector,
): string[] {
  const blocks = prose.blocks();
  if (blocks.length === 0) return [...rows];
  const truncations = blocks
    .filter((block) => block.truncated)
    .map(
      (block) =>
        `The ${block.label} in ${block.ref} was truncated to its first ${TICKET_SHOW_PROSE_MAX_CHARS} characters; use --full or --json for the rest.`,
    );
  return [
    ...rows,
    ...truncations,
    ...untrustedProseResponseLines({
      response,
      blocks: blocks.map(({ ref, label, text }) => ({ label: `${ref} ${label}`, text })),
    }),
  ];
}

function renderDetail(data: unknown, full: boolean): string | null {
  if (!isRecord(data) || !isRecord(data["ticket"])) return null;
  const ticket = data["ticket"];
  const first = ticketLine(ticket);
  if (first === null) return null;
  const lines = [first];
  const prose = ticketLogProse(full);
  for (const key of ["priority", "harness", "baseBranch", "branch"] as const) {
    const value = ticket[key];
    if (typeof value === "string") lines.push(`${key}  ${terminalSafeInline(value)}`);
  }
  if (typeof ticket["body"] === "string" && ticket["body"].length > 0) {
    lines.push("", ticket["body"]);
  }
  // Signals lead the three logs because they are the only one that says where
  // the ticket STANDS (VC-85): at most one line per kind, and the line an
  // orchestrator polling this ticket came to read.
  for (const signal of recordsAt(data, "signals") ?? []) {
    lines.push(...renderTicketSignal(signal, prose));
  }
  for (const event of recordsAt(data, "events") ?? []) {
    lines.push(...renderTicketEvent(event, prose));
  }
  for (const comment of recordsAt(data, "comments") ?? []) {
    lines.push(...renderTicketComment(comment, prose));
  }
  return ticketLogLines("ticket show response", lines, prose).join("\n");
}

/** A nullable ahead/behind/unpushed count: `-` when unknown, else the number. */
function countCell(value: unknown): string {
  return value === null || value === undefined ? "-" : terminalSafeInline(value);
}

/**
 * A chat Session's liveness cell: its state word, and the reason that state
 * carries when it has one.
 *
 * One helper for the list row and the peek header, because they are the same
 * cell read at two distances and VC-86's rule is that they say the same thing.
 * At most one reason can apply: `waitingOn` rides `waiting` and
 * `interruptedReason` rides `interrupted` (VC-324), and main pins each to its
 * own state before it is sent. `on` for the errand a person can run, a
 * parenthetical for the post-mortem — nobody is being asked to go and do
 * `crash-recovered`.
 */
function sessionStateCell(session: Record<string, unknown>): unknown {
  const status = session["status"];
  const waitingOn = session["waitingOn"];
  const interruptedReason = session["interruptedReason"];
  const detail = session["interruption"];
  const category = isRecord(detail) ? detail["category"] : null;
  const suffix = typeof category === "string" ? `; ${category}` : "";
  const cell =
    typeof waitingOn === "string"
      ? `${status} on ${waitingOn}${suffix}`
      : typeof interruptedReason === "string"
        ? `${status} (${interruptedReason}${suffix})`
        : status;
  const pending = session["pendingSubagents"];
  return Array.isArray(pending) && pending.length > 0
    ? `${cell}, waiting on ${pending.length} subagents: ${pending.join(", ")}`
    : cell;
}

/** A wire origin (Session ids already public handles) as one line; `null` is unknown, never the user. */
function originText(value: unknown): string {
  return formatSessionOrigin(readSessionOrigin(value));
}

/**
 * Who started a Session, from the `startedBy` cell. A Run's name is quoted by
 * the shared formatter; a Run that named no Run id (a launch recorded before
 * the id was kept) says what it knows and no more.
 */
function startedByText(value: unknown): string {
  if (!isRecord(value)) return formatSessionOrigin(null);
  if (value["kind"] === "user") return formatSessionOrigin({ kind: "user" });
  if (value["kind"] === "automation") {
    const name = typeof value["automationName"] === "string" ? value["automationName"] : null;
    return typeof value["automationRunId"] === "string"
      ? formatSessionOrigin({
          kind: "automation",
          automationRunId: value["automationRunId"],
          automationName: name,
        })
      : `Automation${name === null ? "" : ` ${JSON.stringify(name)}`}`;
  }
  if (value["kind"] === "session" && typeof value["parentSessionId"] === "string") {
    const session = formatSessionOrigin({ kind: "session", sessionId: value["parentSessionId"] });
    return typeof value["parentTitle"] === "string"
      ? `${session} (${value["parentTitle"]})`
      : session;
  }
  return formatSessionOrigin(null);
}

/** `started by <who>` for a list row that something other than a person started. */
function sessionStartedByCell(session: Record<string, unknown>): string | null {
  const startedBy = session["startedBy"];
  return isRecord(startedBy) && startedBy["kind"] !== "user"
    ? `started by ${startedByText(startedBy)}`
    : null;
}

/** How many of a Session's resumptions `session show` prints; the rest are counted. */
const SESSION_RESUMPTIONS_SHOWN = 5;

/**
 * Who asked for a chat Session's latest turn, from the `latestTurn` cell:
 * `null` before any turn, and an unknown origin for a turn no door attributed.
 */
function latestTurnText(value: unknown): string | null {
  if (!isRecord(value)) return null;
  return `by ${originText(value["origin"])}${value["resumedAfterStop"] === true ? " (resumed after stop)" : ""}`;
}

/** Successful reattachment is attributed to its opener, not the next message's sender. */
function resumedByText(session: Record<string, unknown>): string | null {
  const attachment = session["latestAttachment"];
  if (isRecord(attachment)) {
    return attachment["reattached"] === true
      ? `resumed by ${originText(attachment["origin"])}`
      : null;
  }
  // Read older hosts that reported only turn chronology.
  const turn = session["latestTurn"];
  return isRecord(turn) && turn["resumedAfterStop"] === true
    ? `resumed by ${originText(turn["origin"])}`
    : null;
}

function sessionSignalLine(signal: unknown): string {
  if (!isRecord(signal)) return "signal  -";
  return `signal  ${[signal["kind"], signal["reason"], signal["at"]]
    .map((value) => terminalSafeInline(value ?? "-"))
    .join(" · ")}`;
}

function renderSessionShow(data: Record<string, unknown>): string | null {
  if (typeof data["id"] !== "string" || typeof data["status"] !== "string") return null;
  const lines = [
    `${terminalSafeInline(data["id"])}  ${terminalSafeInline(sessionStateCell(data))}  ${terminalSafeInline(data["title"])}`,
  ];
  for (const field of ["kind", "role", "ticket", "project", "harness"] as const) {
    if (field in data) lines.push(`${field}  ${terminalSafeInline(data[field] ?? "-")}`);
  }
  if ("startedBy" in data)
    lines.push(`started-by  ${terminalSafeInline(startedByText(data["startedBy"]))}`);
  const latestTurn = latestTurnText(data["latestTurn"]);
  if (latestTurn !== null) lines.push(`latest-turn  ${terminalSafeInline(latestTurn)}`);
  const attachment = data["latestAttachment"];
  if (isRecord(attachment)) {
    lines.push(
      `latest-attachment  by ${terminalSafeInline(originText(attachment["origin"]))}${attachment["reattached"] === true ? " (reattached)" : ""}`,
    );
  }
  const resumptions = recordsAt(data, "resumptions") ?? [];
  if (resumptions.length > SESSION_RESUMPTIONS_SHOWN) {
    lines.push(`resumed  ${resumptions.length - SESSION_RESUMPTIONS_SHOWN} earlier not shown`);
  }
  for (const resumption of resumptions.slice(-SESSION_RESUMPTIONS_SHOWN)) {
    lines.push(
      `resumed  ${typeof resumption["attachment"] === "string" ? `attachment ${terminalSafeInline(resumption["attachment"])}` : `turn ${terminalSafeInline(resumption["turn"])}`}  by ${terminalSafeInline(originText(resumption["origin"]))}`,
    );
  }
  const parent = data["parentSession"];
  if (isRecord(parent))
    lines.push(
      `parent  ${terminalSafeInline(parent["id"])}  ${terminalSafeInline(parent["title"] ?? "-")}`,
    );
  for (const child of recordsAt(data, "children") ?? []) {
    lines.push(
      `child  ${terminalSafeInline(child["id"])}  ${terminalSafeInline(child["role"])}  ${terminalSafeInline(child["status"])}  ${terminalSafeInline(child["title"])}`,
    );
  }
  if ("model" in data) lines.push(`model  ${terminalSafeInline(sessionModelCell(data) ?? "-")}`);
  lines.push(`cost  ${usdCell(data)}  tokens ${usageCountCell(data["tokens"])}`);
  lines.push(
    `created  ${ageText(data["ageMs"])} ago`,
    `last activity  ${ageText(data["lastActivityAgeMs"])} ago`,
    sessionSignalLine(data["signal"]),
  );
  return lines.join("\n");
}

/** Free-form provider text gets the same trust envelope as another Session's answer. */
function sessionStopLines(session: Record<string, unknown>): string[] {
  if (!isRecord(session["interruption"])) return [];
  const detail = decodeSessionStopDetail(session["interruption"], "interruption");
  return [
    `${sessionStopSummary(detail)}; retry: ${detail.retry}; reset: ${detail.resetsAt ?? "not stated"}.`,
    ...untrustedProseResponseLines({
      response: "provider stop detail",
      blocks: [
        {
          label: "provider's error",
          text: terminalSafeInline(
            JSON.stringify({
              type: detail.providerType,
              message: detail.message,
              httpStatus: detail.httpStatus,
            }),
          ),
        },
      ],
    }),
  ];
}

/**
 * An elapsed span at the precision a peek is read at: seconds while something
 * is happening, minutes while it is thinking, hours once it has stopped. The
 * caller is deciding whether to look closer, not measuring anything.
 */
function ageText(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "-";
  const seconds = Math.floor(value / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

/**
 * A chat Session's peek: one activity line, then one line per transcript
 * message. The activity line leads because it answers the question the command
 * was run to ask — alive, doing what, since when — and the tail below it is
 * evidence, kept to a line each so a peek costs the caller a screen, not a
 * conversation.
 */
function renderChatPeek(data: Record<string, unknown>, transcript: readonly unknown[]): string {
  const unreadable = data["unreadable"];
  const header = [
    `${terminalSafeInline(data["session"])}  ${terminalSafeInline(sessionStateCell(data))}`,
    `last ${ageText(data["lastActivityAgeMs"])}`,
    `turn ${countCell(data["turns"])} depth ${countCell(data["turnDepth"])}`,
    ...(typeof unreadable === "number" && unreadable > 0 ? [`${unreadable} unreadable`] : []),
    ...sessionOriginHeaderCells(data),
  ].join("  ");
  return [
    header,
    ...sessionStopLines(data),
    ...transcript.filter(isRecord).map(transcriptLine),
  ].join("\n");
}

/** Origin cells shared by terminal and chat peek headers. */
function sessionOriginHeaderCells(data: Record<string, unknown>): string[] {
  const resumed = resumedByText(data);
  return [
    ...(data["startedBy"] === undefined
      ? []
      : [terminalSafeInline(`started by ${startedByText(data["startedBy"])}`)]),
    ...(resumed === null ? [] : [terminalSafeInline(resumed)]),
  ];
}

/**
 * A chat Session's answer (VC-9): one line of Volli's facts — handle, Role,
 * state, turns — then the last assistant message inside the untrusted-prose
 * envelope, because it is another Session's words and the caller is most often
 * the parent that delegated to it.
 */
function renderSessionAnswer(data: Record<string, unknown>): string {
  const unreadable = data["unreadable"] === true;
  const header = [
    `${terminalSafeInline(data["session"])}  ${terminalSafeInline(data["state"])}`,
    ...(typeof data["role"] === "string" ? [terminalSafeInline(data["role"])] : []),
    `turns ${countCell(data["turns"])}`,
    ...(typeof data["title"] === "string" ? [terminalSafeInline(data["title"])] : []),
  ].join("  ");
  const answer = data["answer"];
  const signalLines = isRecord(data["signal"]) ? [sessionSignalLine(data["signal"])] : [];
  if (typeof answer !== "string") {
    return [
      header,
      unreadable
        ? "Its last message could not be read from the transcript store."
        : "It has said nothing yet.",
      ...signalLines,
    ].join("\n");
  }
  return [
    header,
    ...untrustedProseResponseLines({
      response: "session answer response",
      blocks: [{ label: "final message", text: answer }],
    }),
    ...signalLines,
  ].join("\n");
}

/** One transcript message: how long ago, who, which tools, what it said. */
function transcriptLine(entry: Record<string, unknown>): string {
  const tools = Array.isArray(entry["tools"])
    ? entry["tools"].filter((tool): tool is string => typeof tool === "string")
    : [];
  const text = typeof entry["text"] === "string" ? entry["text"] : "";
  const said = `${tools.length > 0 ? `[${tools.map(terminalSafeInline).join(" ")}]` : ""}${
    tools.length > 0 && text.length > 0 ? " " : ""
  }${terminalSafeInline(text)}`;
  return `${ageText(entry["ageMs"])}  ${terminalSafeInline(entry["role"])}${said.length > 0 ? `  ${said}` : ""}`;
}

/** The worktree.status snapshot: branch→base, worktree path, dirty/sequencer/sync. */
function renderWorktreeStatus(data: Record<string, unknown>): string {
  const branch = typeof data["branch"] === "string" ? data["branch"] : "(detached)";
  const base = typeof data["baseBranch"] === "string" ? data["baseBranch"] : "(unknown base)";
  const lines = [
    `${terminalSafeInline(data["ticket"])}  ${terminalSafeInline(branch)} → ${terminalSafeInline(base)}`,
    `worktree  ${terminalSafeInline(data["worktreePath"])}`,
    `uncommitted  ${data["uncommitted"] === true ? "yes" : "no"}`,
  ];
  // The sequencer line is exceptional state — shown only mid merge/rebase.
  if (data["sequencerActive"] === true) lines.push("sequencer  active");
  lines.push(
    `ahead ${countCell(data["aheadOfBase"])}  behind ${countCell(data["behindBase"])}  unpushed ${countCell(data["unpushed"])}`,
  );
  return lines.join("\n");
}

/** One diff --stat row: `+ins -del`, `bin` for binaries, `(untracked)` for new files. */
function diffFileLine(file: Record<string, unknown>): string {
  const path = terminalSafeInline(file["path"]);
  if (file["untracked"] === true) return `  ${path}  (untracked)`;
  if (file["insertions"] === null || file["deletions"] === null) return `  ${path}  bin`;
  return `  ${path}  +${terminalSafeInline(file["insertions"])} -${terminalSafeInline(file["deletions"])}`;
}

/**
 * The worktree.diff --stat summary: a header (mode, base for merge-base, totals),
 * the already-capped per-file rows, and an `… and N more files` rollup when the
 * handler omitted rows to hold the token budget.
 */
function renderWorktreeDiff(data: Record<string, unknown>): string {
  const mode = terminalSafeInline(data["mode"]);
  const against =
    data["mode"] === "merge-base" && typeof data["baseBranch"] === "string"
      ? ` vs ${terminalSafeInline(data["baseBranch"])}`
      : "";
  const totalFiles = countCell(data["totalFiles"]);
  const header = `${terminalSafeInline(data["ticket"])}  ${mode}${against}  ${totalFiles} files  +${terminalSafeInline(data["insertions"])} -${terminalSafeInline(data["deletions"])}`;
  const files = Array.isArray(data["files"]) ? data["files"].filter(isRecord) : [];
  const lines = [header, ...files.map(diffFileLine)];
  const omitted = data["omittedFiles"];
  if (typeof omitted === "number" && omitted > 0) {
    lines.push(`  … and ${terminalSafeInline(omitted)} more files`);
  }
  return lines.join("\n");
}

/**
 * The worktree.sync report (VC-185): one outcome line, then only what that
 * outcome has to say.
 *
 * `status` leads because it is what a reader (and a script) branches on, and
 * because the four outcomes want four different second halves: a merge names
 * what moved, a conflict names the paths and the way out, an up-to-date branch
 * has nothing more to say, and an abort says only that it undid one.
 *
 * The conflict block carries the recovery command literally. That is the whole
 * "decide and document the abort story" clause: a session reading its own
 * conflict is exactly the reader who needs to know that `--abort` exists, and
 * that nothing has cleaned up behind the failed merge.
 */
function renderWorktreeSync(data: Record<string, unknown>): string {
  const branch = typeof data["branch"] === "string" ? data["branch"] : "(detached)";
  const header = `${terminalSafeInline(data["ticket"])}  ${terminalSafeInline(data["status"])}  ${terminalSafeInline(branch)} ← ${terminalSafeInline(data["mergedRef"])}`;
  const lines = [header];

  const conflicts = Array.isArray(data["conflicts"])
    ? data["conflicts"].filter((path): path is string => typeof path === "string")
    : [];
  if (conflicts.length > 0) {
    lines.push(`  conflicts  ${conflicts.length}`);
    for (const path of conflicts) lines.push(`    ${terminalSafeInline(path)}`);
    lines.push(
      `  Resolve them here and commit, or volli worktree sync ${terminalSafeInline(data["ticket"])} --abort.`,
    );
    return lines.join("\n");
  }

  if (data["status"] !== "merged") return lines.join("\n");
  // A merge that landed unmeasured says so. Printing `0 commits  0 files` would
  // be a measurement claiming nothing moved, which is the one thing it is not.
  if (data["totalFiles"] === null || data["totalFiles"] === undefined) {
    lines.push("  merged, but what moved could not be measured");
    return lines.join("\n");
  }
  lines.push(
    `  ${countCell(data["commits"])} commits  ${countCell(data["totalFiles"])} files  +${terminalSafeInline(data["insertions"])} -${terminalSafeInline(data["deletions"])}`,
  );
  const files = Array.isArray(data["files"]) ? data["files"].filter(isRecord) : [];
  for (const file of files) lines.push(diffFileLine(file));
  const omitted = data["omittedFiles"];
  if (typeof omitted === "number" && omitted > 0) {
    lines.push(`  … and ${terminalSafeInline(omitted)} more files`);
  }
  return lines.join("\n");
}

/** How many of one pair's shared paths print before the rest are rolled up. */
const COLLISION_PATH_CAP = 20;

/**
 * The conflicts radar (VC-185): what was compared, then one block per pair of
 * tickets that will collide.
 *
 * The header counts first because the empty case is the common one and it is
 * only reassuring WITH a denominator — "no overlapping paths" across twelve
 * worktrees is a clean bill, and across zero worktrees is a scan that found
 * nothing to look at. Those are different answers and print differently.
 *
 * Skipped worktrees print last and always. A radar that quietly drops a
 * worktree it could not read gives the healthy answer for a collision it never
 * examined.
 */
function renderConflicts(data: Record<string, unknown>): string {
  const scanned = typeof data["scanned"] === "number" ? data["scanned"] : 0;
  const overlaps = recordsAt(data, "overlaps") ?? [];
  const pairs = recordsAt(data, "pairs") ?? [];
  const skipped = recordsAt(data, "skipped") ?? [];

  const lines: string[] = [];
  if (scanned === 0) {
    lines.push("no active worktrees to compare");
  } else {
    const count =
      overlaps.length === 0
        ? "no overlapping paths"
        : `${overlaps.length} overlapping ${overlaps.length === 1 ? "path" : "paths"}`;
    lines.push(`${terminalSafeInline(scanned)} worktrees  ${count}`);
  }

  for (const pair of pairs) {
    const tickets = Array.isArray(pair["tickets"])
      ? pair["tickets"].filter((ticket): ticket is string => typeof ticket === "string")
      : [];
    const paths = Array.isArray(pair["paths"])
      ? pair["paths"].filter((path): path is string => typeof path === "string")
      : [];
    lines.push(
      `${tickets.map(terminalSafeInline).join(" ")}  ${paths.length} ${paths.length === 1 ? "path" : "paths"}`,
    );
    for (const path of paths.slice(0, COLLISION_PATH_CAP)) {
      lines.push(`  ${terminalSafeInline(path)}`);
    }
    if (paths.length > COLLISION_PATH_CAP) {
      lines.push(`  … and ${paths.length - COLLISION_PATH_CAP} more paths`);
    }
  }

  for (const entry of skipped) {
    lines.push(
      `  skipped ${terminalSafeInline(entry["ticket"])}  ${terminalSafeInline(entry["reason"])}`,
    );
  }
  return lines.join("\n");
}

/**
 * A chat row's model, as one cell: `fast · anthropic/haiku-4.5 · low` where
 * the start named a tier, `anthropic/haiku-4.5 · low` where a person or an
 * exact id chose it (VC-259). The tier leads because it is the fact that
 * tells two rows on the same model apart, and the level trails as it does in
 * the model.list table. A terminal row, or a chat that has not recorded a
 * policy yet, has no cell rather than a dash: the cells before the title are
 * filtered, not padded, and this one follows that rule.
 */
function sessionModelCell(session: Record<string, unknown>): string | null {
  if (typeof session["model"] !== "string") return null;
  return [session["tier"], session["model"], session["reasoning"]]
    .filter((value): value is string => typeof value === "string")
    .join(" · ");
}

/**
 * One tier row of the model.list table, in the cells the printer aligns.
 *
 * `model` is null for two different reasons and the row must say which: a
 * tier NO rung configures (`resolvedFrom` null too) is `unset`, the state a
 * Session start would be refused in; a tier that resolved to a model the
 * profile can no longer run (`resolvedFrom` kept, model withheld) is
 * `not available`, a sign-in away from working. Collapsing them into one
 * word would send someone to Settings to configure a row they already had.
 */
interface ModelTierCells {
  tier: string;
  model: string;
  reasoning: string;
  via: string;
}

function modelTierCells(row: Record<string, unknown>): ModelTierCells {
  const tier = terminalSafeInline(row["tier"]);
  const resolvedFrom = typeof row["resolvedFrom"] === "string" ? row["resolvedFrom"] : null;
  if (typeof row["model"] !== "string") {
    return {
      tier,
      model: resolvedFrom === null ? "unset" : "not available",
      reasoning: "",
      via: "",
    };
  }
  return {
    tier,
    model: terminalSafeInline(row["model"]),
    reasoning: typeof row["reasoning"] === "string" ? terminalSafeInline(row["reasoning"]) : "",
    // Inherited rows name the rung that supplied the model — the same fact
    // the Settings row states when it is unset. An explicit row says nothing.
    via:
      resolvedFrom !== null && resolvedFrom !== row["tier"]
        ? `via ${terminalSafeInline(resolvedFrom)}`
        : "",
  };
}

/**
 * A merge preview, or the receipt for one that ran (VC-310).
 *
 * The affected tickets are the whole point of the preview, so they are listed
 * rather than counted — a number cannot be checked against what a person
 * expected, and this is the last screen before a destructive write.
 */
function renderLabelMerge(data: Record<string, unknown>): string | null {
  const tickets = recordsAt(data, "tickets");
  if (tickets === null) return null;
  const from = terminalSafeInline(data["from"]);
  const into = terminalSafeInline(data["into"]);
  const applied = data["applied"] === true;
  const headline = applied
    ? `Merged ${from} into ${into} across ${tickets.length} ticket(s).`
    : `${from} → ${into} would change ${tickets.length} ticket(s).`;
  const lines = tickets.map(
    (ticket) =>
      `  ${terminalSafeInline(ticket["id"])}${ticket["archived"] === true ? "  archived" : ""}  ${terminalSafeInline(ticket["title"])}`,
  );
  const next = typeof data["next"] === "string" ? [terminalSafeInline(data["next"])] : [];
  return [headline, ...lines, ...next].join("\n");
}

/**
 * The model.list catalog: the app default first, then the tier table — one
 * aligned line per tier saying which model it resolves to and through which
 * rung — then one header line per provider with its copyable
 * `provider/model` rows and reasoning levels beneath it, and honest rollups
 * for unavailable providers and models inside a shown provider. The command
 * never offers that signed-out catalog to an agent, so the rollups explain the
 * smaller answer without advertising it.
 *
 * The `default` line is the tier table's `ticket` row under the name older
 * callers copy from; both print, and the table's widths include it so the two
 * read as one block.
 */
function renderModelList(data: Record<string, unknown>): string | null {
  const providers = recordsAt(data, "providers");
  if (providers === null) return null;
  const def = data["default"];
  const defaultCells: ModelTierCells =
    isRecord(def) && typeof def["model"] === "string"
      ? {
          tier: "default",
          model: terminalSafeInline(def["model"]),
          reasoning: terminalSafeInline(def["reasoning"]),
          via: "",
        }
      : { tier: "default", model: "-", reasoning: "", via: "" };
  // A response from an app that predates the table simply has no tier rows.
  const tierRows = [defaultCells, ...(recordsAt(data, "tiers") ?? []).map(modelTierCells)];
  const tierWidth = Math.max(...tierRows.map((row) => row.tier.length));
  const modelWidth = Math.max(...tierRows.map((row) => row.model.length));
  const reasoningWidth = Math.max(...tierRows.map((row) => row.reasoning.length));
  const lines = tierRows.map((row) =>
    [
      row.tier.padEnd(tierWidth),
      row.model.padEnd(modelWidth),
      row.reasoning.padEnd(reasoningWidth),
      row.via,
    ]
      .join("  ")
      .trimEnd(),
  );
  for (const provider of providers) {
    lines.push(
      `${terminalSafeInline(provider["id"])}  ${terminalSafeInline(provider["label"])}  ${terminalSafeInline(provider["state"])}`,
    );
    const models = Array.isArray(provider["models"]) ? provider["models"].filter(isRecord) : [];
    for (const model of models) {
      const levels = Array.isArray(model["reasoning"])
        ? model["reasoning"].filter((level): level is string => typeof level === "string")
        : [];
      // The command holds only available models, so the state cell earns its
      // width exactly when it says something other than "available".
      const state = model["state"] === "available" ? "" : `  ${terminalSafeInline(model["state"])}`;
      lines.push(
        `  ${terminalSafeInline(model["model"])}  ${levels.length > 0 ? levels.map(terminalSafeInline).join("|") : "-"}${state}`,
      );
    }
    // Models the command withheld inside this shown provider get the same
    // honesty counter the provider rollup has — nothing disappears silently.
    const omittedModels = provider["omittedModels"];
    if (typeof omittedModels === "number" && omittedModels > 0) {
      lines.push(`  … and ${terminalSafeInline(omittedModels)} more models not available`);
    }
  }
  // "not available", not "not signed in": a provider can be signed in and
  // still be withheld here (probe failure, refresh error) — the wording must
  // stay honest in both cases.
  const omitted = data["omittedProviders"];
  if (typeof omitted === "number" && omitted > 0) {
    lines.push(`… and ${terminalSafeInline(omitted)} more providers not available`);
  }
  return lines.join("\n");
}

/**
 * A metered total, written so it cannot be read as more than it is.
 *
 * The hedge is one glyph, the same notation the app's rails use, because the
 * two surfaces quote the same money and a reader who learns it in one has
 * learned it in the other:
 *
 *     $8.42     provider-reported and wholly priced — the only bare case
 *     ~$8.42    a catalogue estimate, or a mix of bases
 *     ~$8.42+   partial: at least this much of the window was priced
 *     —         operations happened and none could be priced
 *
 * `unavailable` never prints bare and never prints `$0.00`. A basis Volli
 * cannot vouch for is hedged like an estimate and NAMED differently below, on
 * the basis line — calling it "estimated" would claim we know it came from a
 * price catalogue, which is exactly what `unavailable` says we do not know.
 */
function usdCell(data: Record<string, unknown>): string {
  const cost = data["costUsd"];
  if (typeof cost !== "number" || !Number.isFinite(cost)) return "\u2014";
  const prefix = data["costBasis"] === "provider-reported" ? "" : "~";
  const suffix = data["costCoverage"] === "partial" ? "+" : "";
  // `<$0.01` rather than `$0.00`: rounding a real charge to zero prints the
  // one sentence this whole feature exists to prevent.
  const amount =
    cost > 0 && cost < 0.01
      ? "<$0.01"
      : `$${cost.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return `${prefix}${amount}${suffix}`;
}

/** Cache reads as a share of all prompt tokens. Never called a hit rate. */
function cachedShareCell(data: Record<string, unknown>): string {
  const share = data["cachedInputShare"];
  if (typeof share !== "number" || !Number.isFinite(share)) return "-";
  const percent = share * 100;
  return percent > 0 && percent < 1 ? "<1%" : `${Math.round(percent)}%`;
}

function usageCountCell(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * What kind of number the cost is, in words rather than in a glyph.
 *
 * Three answers, not two. `provider-reported` is the backend's own accounting;
 * `catalog-estimate` (and a `mixed` total containing one) is priced locally at
 * list; and `unavailable` is a cost from an executor whose pricing Volli cannot
 * vouch for — real tokens, a real number, and no claim about where it came
 * from. Printing that third case as "estimated" would assert a provenance the
 * ledger explicitly refused to assert.
 */
function basisWord(basis: unknown): string {
  if (basis === "provider-reported") return "provider-reported";
  if (basis === "unavailable") return "unverified-basis";
  return "estimated";
}

/**
 * The basis line: what kind of number the cost is, and how much of the report
 * it covers.
 *
 * A report with no operations at all gets neither. "unverified-basis 0 of 0
 * operations priced" describes the basis of a number that does not exist — the
 * summary's `unavailable` there means nothing was metered, not that something
 * was metered unverifiably, and the two must not print the same words.
 */
function basisLine(data: Record<string, unknown>): string {
  const requests = usageCountCell(data["requestCount"]);
  if (requests === 0) return "basis  no metered model calls";
  const priced = usageCountCell(data["pricedRequestCount"]);
  return `basis  ${basisWord(data["costBasis"])}  ${priced} of ${requests} operations priced`;
}

/**
 * `volli cost` — the scope, the money, the four token classes, and what the
 * profile cannot answer.
 *
 * Key-value lines like `identify`, so an agent reads it with `grep` and a
 * person reads it top to bottom. THE TOKEN LINE AND THE COST LINE ARE APART on
 * purpose: cost is recorded per operation and never per class, so a reader who
 * saw "78% cached" on the same line as a dollar figure could conclude that 78%
 * of the money was cache — which is roughly backwards, cache reads billing at
 * about a tenth of an uncached input token.
 */
function renderCostReport(data: Record<string, unknown>): string {
  const since = data["since"];
  const lines = [
    `scope  ${terminalSafeInline(data["scope"])}`,
    `since  ${typeof since === "number" ? terminalSafeInline(new Date(since).toISOString()) : "all time"}`,
    `cost  ${usdCell(data)}`,
    basisLine(data),
    `tokens  ${usageCountCell(data["totalTokens"])}  input ${usageCountCell(data["inputTokens"])}  cache-read ${usageCountCell(data["cacheReadTokens"])}  cache-write ${usageCountCell(data["cacheWriteTokens"])}  output ${usageCountCell(data["outputTokens"])}`,
    `cached  ${cachedShareCell(data)}`,
    `sessions  ${usageCountCell(data["meteredSessionCount"])} metered`,
  ];
  // Only when it changes the reading. A complete report saying so spends a
  // line to say nothing; a partial one that omitted it would let a floor read
  // as a total.
  if (data["coverage"] === "partial") {
    const from = data["meteredFrom"];
    lines.push(
      `coverage  partial${
        typeof from === "number"
          ? ` — this profile has metered since ${terminalSafeInline(new Date(from).toISOString())}`
          : ""
      }`,
    );
  }
  const groups = recordsAt(data, "groups") ?? [];
  for (const group of groups) {
    // `-` for the null key, which is a real group: spend that belongs to no
    // Ticket. Dropping it would make the rows add up to less than the total.
    const label = group["label"];
    lines.push(
      `  ${terminalSafeInline(label === null || label === undefined ? "-" : label)}  ${usdCell(group)}  ${usageCountCell(group["totalTokens"])} tokens  ${cachedShareCell(group)} cached  ${usageCountCell(group["requestCount"])} operations`,
    );
  }
  return lines.join("\n");
}

/**
 * How often a section's bytes are re-bought, as one cell beside what they cost.
 *
 * Class and placement travel together rather than as two columns, because
 * neither is worth much alone: "session-static" prices very differently on the
 * two sides of the Cache Prefix, and the side alone says nothing about how
 * often anything is paid. The prefix side is the common case and stays
 * unmarked — the same bargain `renderModelList` strikes with its state cell,
 * where a cell earns its width exactly when it says something other than the
 * default.
 *
 * Absent entirely when the server named no class, so an older or partial reply
 * renders as the breakdown it is instead of a row claiming "undefined".
 */
function cacheClassCell(section: Record<string, unknown>): string {
  const cacheClass = section["cacheClass"];
  if (typeof cacheClass !== "string") return "";
  const side = section["placement"] === "message" ? ", message-side" : "";
  return `  ${terminalSafeInline(cacheClass)}${side}`;
}

/**
 * The prompt.baseline report: one header with the honest rollup, one row per
 * composed section carrying what it costs and how often it is bought again, and
 * the named remainder the estimate deliberately excludes.
 */
function renderPromptBaseline(data: Record<string, unknown>): string | null {
  const sections = recordsAt(data, "sections");
  const total = data["total"];
  if (sections === null || !isRecord(total)) return null;
  const header = `prompt baseline  ${terminalSafeInline(data["role"])}  ~${terminalSafeInline(total["tokens"])} tokens  ${terminalSafeInline(total["chars"])} chars  (est. at ${terminalSafeInline(data["charsPerToken"])} chars/token)`;
  const rows = sections.map(
    (section) =>
      `  ${terminalSafeInline(section["id"])}  ~${terminalSafeInline(section["tokens"])} tokens  ${terminalSafeInline(section["chars"])} chars${cacheClassCell(section)}`,
  );
  const excluded =
    typeof data["excluded"] === "string"
      ? [`excluded  ${terminalSafeInline(data["excluded"])}`]
      : [];
  return [header, ...rows, ...excluded].join("\n");
}

function renderStableLines(command: string, data: unknown, full: boolean): string | null {
  if (!isRecord(data)) return null;
  if (command === "prompt.baseline") return renderPromptBaseline(data);
  if (command === "worktree.status") return renderWorktreeStatus(data);
  if (command === "worktree.diff") return renderWorktreeDiff(data);
  if (command === "worktree.sync") return renderWorktreeSync(data);
  if (command === "conflicts") return renderConflicts(data);
  if (["ticket.create", "ticket.update", "ticket.move"].includes(command)) {
    return renderTicketResult(data);
  }
  if (command === "ticket.show") return renderDetail(data, full);
  if (command === "ticket.archive" && isRecord(data["ticket"])) {
    const id = data["ticket"]["id"];
    return typeof id === "string" ? `${terminalSafeInline(id)}  archived` : null;
  }
  if (command === "ticket.comment" && isRecord(data["comment"])) {
    const ticket = data["comment"]["ticket"];
    return typeof ticket === "string" ? `${terminalSafeInline(ticket)}  comment added` : null;
  }
  // The receipt echoes the recorded verdict rather than saying "signal added":
  // what was written is the whole content of the acknowledgement, and a signer
  // reading it back is how a wrong `--kind` gets caught one line later.
  if (command === "ticket.signal" && isRecord(data["signal"])) {
    const signal = data["signal"];
    return typeof signal["ticket"] === "string" ? ticketSignalLine(signal) : null;
  }
  if (command === "project.list") {
    const projects = recordsAt(data, "projects");
    return (
      projects
        ?.map(
          (project) =>
            `${terminalSafeInline(project["prefix"])}  ${terminalSafeInline(project["name"])}  ${terminalSafeInline(project["path"])}  ${terminalSafeInline(project["tickets"])} tickets`,
        )
        .join("\n") ?? null
    );
  }
  if (command === "model.list") return renderModelList(data);
  if (command === "cost") return renderCostReport(data);
  if (command === "label.list") {
    const labels = recordsAt(data, "labels");
    return (
      labels
        ?.map(
          (label) =>
            `${terminalSafeInline(label["name"])}  ${terminalSafeInline(label["tickets"])} tickets`,
        )
        .join("\n") ?? null
    );
  }
  if (command === "label.merge") return renderLabelMerge(data);
  if (command === "session.show") return renderSessionShow(data);
  if (command === "session.list") {
    const sessions = recordsAt(data, "sessions");
    const rows =
      sessions
        ?.map(
          (session) =>
            [
              ...[
                session["id"],
                session["kind"],
                // The liveness cell (VC-86): peek's own vocabulary — the state,
                // with its reason inline so "waiting" never hides the one thing
                // the caller could act on.
                sessionStateCell(session),
                // Age of the newest durable fact — the signal a wedge hides in.
                // Absent only on a legacy or malformed row, never rendered as "-".
                typeof session["lastActivityAgeMs"] === "number"
                  ? `last ${ageText(session["lastActivityAgeMs"])}`
                  : null,
                session["ticket"],
                sessionModelCell(session),
                // Said only where it informs: a person-started Session is the
                // common row and keeps its width. A Run, a parent Session and
                // a resume after a stop each get one cell, before the cost
                // cells so the title stays last.
                sessionStartedByCell(session),
                resumedByText(session),
              ]
                .filter((value) => value !== null && value !== undefined)
                .map(terminalSafeInline),
              // Cost and tokens sit BEFORE the title and are never filtered out,
              // because the title is free text that may contain spaces and has
              // to stay the last cell for anything downstream to cut on. An
              // unmetered Session prints `—  0`, which reads as unmeasured; a
              // filtered-out cell would silently shift every column left.
              usdCell(session),
              terminalSafeInline(usageCountCell(session["tokens"])),
              terminalSafeInline(session["title"]),
            ].join("  ") +
            (sessionStopLines(session).length === 0
              ? ""
              : `\n${sessionStopLines(session).join("\n")}`),
        )
        .join("\n") ?? null;
    if (rows === null) return null;
    const hidden = data["hidden"];
    return typeof hidden === "number" && hidden > 0
      ? `${rows}${rows.length > 0 ? "\n" : ""}${hidden} older sessions hidden; --all or --since shows them.`
      : rows;
  }
  if (command === "session.answer") {
    if (typeof data["session"] !== "string" || typeof data["state"] !== "string") return null;
    return renderSessionAnswer(data);
  }
  if (command === "session.peek") {
    if (typeof data["session"] !== "string" || typeof data["status"] !== "string") return null;
    // A chat peek is told apart by what it carries, not by a `kind` word: the
    // terminal reply is a status/origin line plus raw output, while a chat's
    // is an activity line plus a transcript.
    if (Array.isArray(data["transcript"])) return renderChatPeek(data, data["transcript"]);
    const output = typeof data["output"] === "string" ? data["output"] : "";
    const header = [
      `${terminalSafeInline(data["session"])}  ${terminalSafeInline(sessionStateCell(data))}`,
      ...sessionOriginHeaderCells(data),
    ].join("  ");
    return `${header}${output.length > 0 ? `\n${output}` : ""}`;
  }
  // The dedicated event log reads the same rows `ticket show` does, at ten
  // times the default count, so it takes the same formatter and the same
  // bound rather than a second dialect of the same answer.
  if (command === "ticket.events") {
    const events = recordsAt(data, "events");
    if (events === null) return null;
    const prose = ticketLogProse(full);
    const rows = events.flatMap((event) => renderTicketEvent(event, prose));
    return ticketLogLines("ticket events response", rows, prose).join("\n");
  }
  if (command === "identify") {
    const keys = [
      "project",
      "ticket",
      "session",
      "worktree",
      "worktreePath",
      // Present only when the agent is working outside its ticket's worktree
      // (VC-98). Ordered directly after the path it contradicts, so the two
      // read as one statement rather than a fact and an unrelated aside.
      "warning",
      "socket",
      "appVersion",
    ] as const;
    const lines = keys
      .filter((key) => key in data)
      .map((key) => {
        if (key === "project") return `project  ${renderIdentifyProject(data["project"])}`;
        const value = data[key];
        return `${key}  ${value === null || value === undefined ? "-" : terminalSafeInline(value)}`;
      });
    // The env block (VC-94): the environment the session will run in, keyed
    // like every other line so an agent reads it in the same pass it reads
    // its identity. `-` means measured and not found; a missing block means
    // the answering process had no env facts at all.
    if (isRecord(data["env"])) {
      const env = data["env"];
      const envValue = (value: unknown): string =>
        value === null || value === undefined ? "-" : terminalSafeInline(value);
      lines.push(`env.path  ${envValue(env["path"])}`);
      lines.push(`env.provenance  ${envValue(env["provenance"])}`);
      // The second pass's answer, directly under the first (VC-94's A3): the
      // two are separate facts about one PATH, so they read as one statement
      // rather than a fact and an unrelated aside. `pending` here means the
      // interactive shell has not been folded in yet.
      lines.push(`env.interactiveProvenance  ${envValue(env["interactiveProvenance"])}`);
      const tools = isRecord(env["tools"]) ? env["tools"] : {};
      for (const tool of SESSION_ENV_TOOLS) {
        lines.push(`env.tools.${tool}  ${envValue(tools[tool])}`);
      }
      // Which of those measurements this project actually needs (VC-157).
      // Printed after them so a reader takes the list as a filter over what
      // they just read: a `-` above a name absent from this line is a tool
      // nothing here runs, not a fault. `-` here means the project implies
      // no tool at all — a folder that is neither repository nor workspace.
      //
      // A field that is not an array at all is a different fact: an answering
      // process that never established requirements. That prints no line,
      // rather than a `-` claiming it looked and found none — the same
      // measured-versus-unmeasured discipline the block keeps everywhere else.
      const requiredTools = env["requiredTools"];
      if (Array.isArray(requiredTools)) {
        lines.push(
          `env.requiredTools  ${
            requiredTools.length === 0 ? "-" : requiredTools.map(terminalSafeInline).join(" ")
          }`,
        );
      }
      lines.push(`env.dependencies  ${envValue(env["dependencies"])}`);
    }
    if (data["degraded"] === true) lines.push("degraded  true");
    return lines.join("\n");
  }
  if (command === "session.start") {
    // The short id leads: it is the acceptance's one required output and the
    // handle every follow-up (session list/peek) addresses by. `state` names a
    // failed attach honestly — the Session is durable and the app carries its
    // Retry — and the model/reasoning pair echoes what the session records.
    return `${terminalSafeInline(data["session"])}  ${terminalSafeInline(data["ticket"])}  ${terminalSafeInline(data["state"])}  ${terminalSafeInline(data["model"])} ${terminalSafeInline(data["reasoning"])}`;
  }
  if (command === "session.done" || command === "session.blocked") {
    return `${terminalSafeInline(data["session"])}  ${terminalSafeInline(data["signal"])}`;
  }
  if (command === "session.link") {
    return `${terminalSafeInline(data["session"])}  linked ${terminalSafeInline(data["harnessSessionId"])}`;
  }
  if (command === "session.harness") {
    // The one verb whose stdout is consumed by a shell rather than read: the
    // wrapper runs this in `$(…)` and prepends the result to the harness's own
    // argv. So a mint prints the bare id and nothing else, and an announce —
    // fired detached into /dev/null — prints nothing at all. A status line here
    // would become a command-line word for the agent.
    const harnessSessionId = data["harnessSessionId"];
    return typeof harnessSessionId === "string" ? terminalSafeInline(harnessSessionId) : "";
  }
  if (command === "notify") return data["notified"] === true ? "notified" : null;
  if (command === "app.launch") {
    return data["alreadyRunning"] === true ? "Volli is already running" : "Volli launched";
  }
  return null;
}

/**
 * Renders server JSON directly or as the command's stable text contract.
 * See {@link RenderOptions} for the v1 TTY/pipe-identical output contract.
 */
const isString = (field: unknown): field is string => typeof field === "string";
const isStringArray = (field: unknown): boolean => Array.isArray(field) && field.every(isString);

/**
 * The repair block, believed only when every field it renders is present and
 * shaped as main sends it. Anything else renders as no repair rather than as
 * a half-invented one — the report speaks only measured facts.
 */
function sessionEnvRepair(value: unknown): SessionEnvRepair | undefined {
  if (!isRecord(value)) return undefined;
  return isString(value["path"]) &&
    isString(value["provenance"]) &&
    isString(value["interactiveProvenance"]) &&
    isStringArray(value["added"]) &&
    isStringArray(value["interactiveAdded"])
    ? (value as unknown as SessionEnvRepair)
    : undefined;
}

/**
 * One reported check, made safe to print.
 *
 * The reply is whichever app build answers the socket, not this CLI's own
 * version, so a finding may predate the failure titles VC-293 made required.
 * Marking its passing claim as not having held keeps the report readable
 * without presenting that claim as true; inventing `undefined` as a heading
 * would not.
 */
function doctorCheck(value: unknown): DoctorCheck | null {
  if (!isRecord(value)) return null;
  const { id, title, status, detail, remedy, failureTitle } = value;
  if (
    typeof id !== "string" ||
    typeof title !== "string" ||
    (status !== "ok" && status !== "warn" && status !== "fail") ||
    typeof detail !== "string" ||
    (remedy !== undefined && typeof remedy !== "string") ||
    (failureTitle !== undefined && typeof failureTitle !== "string")
  ) {
    return null;
  }
  if (status === "ok") return value as unknown as DoctorCheck;
  return {
    ...value,
    failureTitle: failureTitle ?? legacyDoctorFailureTitle(title),
    remedy: remedy ?? LEGACY_DOCTOR_REMEDY,
  } as unknown as DoctorCheck;
}

interface NormalizedDoctorReport {
  checks: DoctorCheck[];
  summary: string;
  pathRepair: SessionEnvRepair | undefined;
  data: Record<string, unknown>;
}

/** `doctor`'s reply is already a report; only its shape needs checking and normalizing. */
function normalizeDoctorReport(data: unknown): NormalizedDoctorReport | null {
  if (!isRecord(data)) return null;
  const { checks: rawChecks, summary } = data;
  if (!Array.isArray(rawChecks) || typeof summary !== "string") return null;
  const checks: DoctorCheck[] = [];
  for (const rawCheck of rawChecks) {
    const check = doctorCheck(rawCheck);
    if (check === null) return null;
    checks.push(check);
  }
  return {
    checks,
    summary,
    pathRepair: sessionEnvRepair(data["pathRepair"]),
    data: { ...data, checks },
  };
}

function doctorReport(data: unknown): string | null {
  const report = normalizeDoctorReport(data);
  return report === null
    ? null
    : renderDoctorReport(report.checks, report.summary, report.pathRepair);
}

function renderCliTextSuccess(command: string, data: unknown, full: boolean): string {
  if (command === "doctor") {
    const report = doctorReport(data);
    if (report !== null) return report;
  }
  if (command === "ticket.brief" && typeof data === "object" && data !== null) {
    const prompt = (data as { prompt?: unknown }).prompt;
    if (typeof prompt === "string") return prompt.endsWith("\n") ? prompt : `${prompt}\n`;
  }
  if (command === "board") {
    const rendered = renderBoard(data);
    if (rendered !== null) return rendered;
  }
  if (command === "ticket.list") {
    const tickets = ticketList(data);
    if (tickets !== null) {
      return tickets
        .map((ticket) => {
          const labels =
            ticket.labels.length === 0
              ? ""
              : `  [${ticket.labels.map(terminalSafeInline).join(", ")}]`;
          return `${terminalSafeInline(ticket.id)}  ${terminalSafeInline(TICKET_STATUS_LABELS[ticket.status])}  ${terminalSafeInline(ticket.title)}${labels}`;
        })
        .join("\n")
        .concat(tickets.length === 0 ? "" : "\n");
    }
  }
  const stable = renderStableLines(command, data, full);
  if (stable !== null) return stable.length === 0 ? "" : `${stable}\n`;
  return `${terminalSafeJson(data)}\n`;
}

export function renderCliSuccess(command: string, data: unknown, options: RenderOptions): string {
  if (options.json) {
    const normalized = command === "doctor" ? normalizeDoctorReport(data)?.data : undefined;
    return `${terminalSafeJson(normalized ?? data)}\n`;
  }
  if (isAgentMutationPlan(data)) {
    const writes =
      data.durableWrites.length === 0
        ? ["  - none"]
        : data.durableWrites.map((write) => `  - ${write.summary}`);
    const human =
      data.humanVisibleEffects.length === 0
        ? ["  - none"]
        : data.humanVisibleEffects.map((effect) => `  - ${effect}`);
    const nonEffects = data.nonEffects.map((effect) => `  - ${effect}`);
    return terminalSafeText(
      [
        "Side-effect preview",
        `Verb: ${data.verb}`,
        `Target: ${data.target.label} (${data.target.kind})`,
        "Durable writes:",
        ...writes,
        "Human-visible effects:",
        ...human,
        "Explicit non-effects:",
        ...nonEffects,
        data.caveat,
        "",
      ].join("\n"),
    );
  }
  return terminalSafeText(renderCliTextSuccess(command, data, options.full === true));
}

export interface RenderErrorOptions {
  json?: boolean;
}

/** One-line plain refusal or stable structured JSON on stderr. */
export function renderCliError(error: AgentError, options: RenderErrorOptions = {}): string {
  // Accept a response from a pre-VC-91 app without turning a useful refusal
  // into SOCKET_PROTOCOL. New producers always supply both structured fields.
  const compatible = error as AgentError & { reason?: string; next?: string | null };
  const reason = compatible.reason ?? compatible.message;
  const next = Object.hasOwn(compatible, "next")
    ? (compatible.next ?? null)
    : ERROR_RECOVERY[compatible.code].next;
  if (options.json === true) {
    return `${terminalSafeJson({ error: { code: error.code, message: compatible.message, reason, next } })}\n`;
  }
  const recovery =
    next === null
      ? "Next: none is safe from this evidence; inspect current durable state before retrying."
      : `Next: ${next}`;
  return `error[${error.code}] ${terminalSafeInline(reason)} ${terminalSafeInline(recovery)}\n`;
}

export function exitCodeForError(code: AgentErrorCode): 1 | 2 | 3 {
  if (code === "APP_UNREACHABLE") return 3;
  if (
    code === "USAGE" ||
    code === "INVALID_REQUEST" ||
    code === "UNSUPPORTED_COMMAND" ||
    code === "WRONG_DOOR"
  ) {
    return 2;
  }
  return 1;
}
