import { randomUUID } from "node:crypto";

import {
  ERROR_RECOVERY,
  isAgentMutationPlan,
  SESSION_ENV_TOOLS,
  TICKET_STATUS_LABELS,
  untrustedProseLines,
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

/** The most prose one ticket-show row may hand an agent in text mode. */
export const TICKET_SHOW_PROSE_MAX_CHARS = 1_000;

/** The verdict columns shared by ticket.signal's receipt and ticket show's latest-signal rows. */
function ticketSignalLine(signal: Record<string, unknown>): string {
  return ["ticket", "kind", "verdict"]
    .map((field) => (typeof signal[field] === "string" ? terminalSafeInline(signal[field]) : "-"))
    .join("  ");
}

/** A text-mode ticket show must not let one prose row consume the caller's context. */
function boundedUntrustedProse(kind: string, prose: string): string[] {
  const truncated = prose.length > TICKET_SHOW_PROSE_MAX_CHARS;
  const shown = truncated ? prose.slice(0, TICKET_SHOW_PROSE_MAX_CHARS) : prose;
  return [
    ...(truncated
      ? [`The ${kind} was truncated to its first ${TICKET_SHOW_PROSE_MAX_CHARS} characters.`]
      : []),
    ...untrustedProseLines(kind, shown, randomUUID(), "ticket show response"),
  ];
}

/** The event payload crosses the socket under `payload`; tolerate old test fixtures that put it at top level. */
function ticketEventPayload(event: Record<string, unknown>): Record<string, unknown> {
  return isRecord(event["payload"]) ? event["payload"] : event;
}

/** One scalar or scalar list as a scan-friendly event field; nested records stay out of a text row. */
function ticketEventValue(value: unknown): string | null {
  if (value === null) return "-";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return terminalSafeInline(value);
  }
  if (Array.isArray(value)) {
    const values = value.map(ticketEventValue);
    return values.every((entry) => entry !== null) ? values.join(",") : null;
  }
  return null;
}

/** One durable event as columns rather than an opaque JSON object. */
function ticketEventLine(event: Record<string, unknown>): string {
  const payload = ticketEventPayload(event);
  const kind = typeof payload["kind"] === "string" ? terminalSafeInline(payload["kind"]) : "-";
  const facts = Object.entries(payload).flatMap(([field, value]) => {
    // Signal detail is prose. It travels below in its own nonce-delimited
    // envelope rather than escaping this formatted event line.
    if (field === "kind" || field === "detail") return [];
    const rendered = ticketEventValue(value);
    return rendered === null ? [] : [`${field}=${rendered}`];
  });
  const metadata: string[] = [];
  if (typeof event["actor"] === "string") {
    metadata.push(`actor=${terminalSafeInline(event["actor"])}`);
  }
  if (isRecord(event["actorContext"]) && typeof event["actorContext"]["session"] === "string") {
    metadata.push(`session=${terminalSafeInline(event["actorContext"]["session"])}`);
  }
  if (typeof event["createdAt"] === "number") metadata.push(`at=${event["createdAt"]}`);
  return ["event", kind, ...facts, ...metadata].join("  ");
}

function renderTicketEvent(event: Record<string, unknown>): string[] {
  const payload = ticketEventPayload(event);
  const lines = [ticketEventLine(event)];
  if (
    payload["kind"] === "signaled" &&
    typeof payload["detail"] === "string" &&
    payload["detail"].trim().length > 0
  ) {
    lines.push(...boundedUntrustedProse("signal detail", payload["detail"]));
  }
  return lines;
}

function renderTicketSignal(signal: Record<string, unknown>): string[] {
  const lines = [`signal  ${ticketSignalLine(signal)}`];
  if (typeof signal["detail"] === "string" && signal["detail"].trim().length > 0) {
    lines.push(...boundedUntrustedProse("signal detail", signal["detail"]));
  }
  return lines;
}

function renderTicketComment(comment: Record<string, unknown>): string[] {
  const metadata = [
    typeof comment["ticket"] === "string" ? terminalSafeInline(comment["ticket"]) : "-",
    typeof comment["actor"] === "string" ? terminalSafeInline(comment["actor"]) : "-",
    typeof comment["session"] === "string"
      ? `session=${terminalSafeInline(comment["session"])}`
      : null,
    typeof comment["createdAt"] === "number" ? `at=${comment["createdAt"]}` : null,
  ].filter((value): value is string => value !== null);
  const lines = [`comment  ${metadata.join("  ")}`];
  if (typeof comment["body"] === "string") {
    lines.push(...boundedUntrustedProse("ticket comment", comment["body"]));
  }
  return lines;
}

function renderDetail(data: unknown): string | null {
  if (!isRecord(data) || !isRecord(data["ticket"])) return null;
  const ticket = data["ticket"];
  const first = ticketLine(ticket);
  if (first === null) return null;
  const lines = [first];
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
    lines.push(...renderTicketSignal(signal));
  }
  for (const event of recordsAt(data, "events") ?? []) {
    lines.push(...renderTicketEvent(event));
  }
  for (const comment of recordsAt(data, "comments") ?? []) {
    lines.push(...renderTicketComment(comment));
  }
  return lines.join("\n");
}

/** A nullable ahead/behind/unpushed count: `-` when unknown, else the number. */
function countCell(value: unknown): string {
  return value === null || value === undefined ? "-" : terminalSafeInline(value);
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
  const waitingOn = data["waitingOn"];
  const unreadable = data["unreadable"];
  const header = [
    `${terminalSafeInline(data["session"])}  ${terminalSafeInline(data["status"])}${
      typeof waitingOn === "string" ? ` on ${terminalSafeInline(waitingOn)}` : ""
    }`,
    `last ${ageText(data["lastActivityAgeMs"])}`,
    `turn ${countCell(data["turns"])} depth ${countCell(data["turnDepth"])}`,
    ...(typeof unreadable === "number" && unreadable > 0 ? [`${unreadable} unreadable`] : []),
  ].join("  ");
  return [header, ...transcript.filter(isRecord).map(transcriptLine)].join("\n");
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
 * The model.list catalog: the app default first, then one header line per
 * provider with its copyable `provider/model` rows and reasoning levels
 * beneath it, and honest rollups for everything the default view withholds
 * (unavailable providers, and unavailable models inside a shown provider —
 * they are behind --all, not missing).
 */
function renderModelList(data: Record<string, unknown>): string | null {
  const providers = recordsAt(data, "providers");
  if (providers === null) return null;
  const def = data["default"];
  const lines = [
    isRecord(def) && typeof def["model"] === "string"
      ? `default  ${terminalSafeInline(def["model"])}  ${terminalSafeInline(def["reasoning"])}`
      : "default  -",
  ];
  for (const provider of providers) {
    lines.push(
      `${terminalSafeInline(provider["id"])}  ${terminalSafeInline(provider["label"])}  ${terminalSafeInline(provider["state"])}`,
    );
    const models = Array.isArray(provider["models"]) ? provider["models"].filter(isRecord) : [];
    for (const model of models) {
      const levels = Array.isArray(model["reasoning"])
        ? model["reasoning"].filter((level): level is string => typeof level === "string")
        : [];
      // The default view holds only available models, so the state cell earns
      // its width exactly when it says something other than "available".
      const state = model["state"] === "available" ? "" : `  ${terminalSafeInline(model["state"])}`;
      lines.push(
        `  ${terminalSafeInline(model["model"])}  ${levels.length > 0 ? levels.map(terminalSafeInline).join("|") : "-"}${state}`,
      );
    }
    // Models the default view withheld inside this shown provider get the same
    // honesty counter the provider rollup has — nothing disappears silently.
    const omittedModels = provider["omittedModels"];
    if (typeof omittedModels === "number" && omittedModels > 0) {
      lines.push(
        `  … and ${terminalSafeInline(omittedModels)} more models not available (use --all)`,
      );
    }
  }
  // "not available", not "not signed in": a provider can be signed in and
  // still be withheld here (probe failure, refresh error) — the wording must
  // stay honest in both cases.
  const omitted = data["omittedProviders"];
  if (typeof omitted === "number" && omitted > 0) {
    lines.push(`… and ${terminalSafeInline(omitted)} more providers not available (use --all)`);
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

function renderStableLines(command: string, data: unknown): string | null {
  if (!isRecord(data)) return null;
  if (command === "prompt.baseline") return renderPromptBaseline(data);
  if (command === "worktree.status") return renderWorktreeStatus(data);
  if (command === "worktree.diff") return renderWorktreeDiff(data);
  if (["ticket.create", "ticket.update", "ticket.move"].includes(command)) {
    return renderTicketResult(data);
  }
  if (command === "ticket.show") return renderDetail(data);
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
  if (command === "session.list") {
    const sessions = recordsAt(data, "sessions");
    return (
      sessions
        ?.map((session) =>
          [
            ...[session["id"], session["kind"], session["status"], session["ticket"]]
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
          ].join("  "),
        )
        .join("\n") ?? null
    );
  }
  if (command === "session.peek") {
    if (typeof data["session"] !== "string" || typeof data["status"] !== "string") return null;
    // A chat peek is told apart by what it carries, not by a `kind` word: the
    // terminal reply is a status line plus raw output and stays byte-for-byte
    // what it always was, while a chat's is an activity line plus a transcript.
    if (Array.isArray(data["transcript"])) return renderChatPeek(data, data["transcript"]);
    const output = typeof data["output"] === "string" ? data["output"] : "";
    return `${terminalSafeInline(data["session"])}  ${terminalSafeInline(data["status"])}${output.length > 0 ? `\n${output}` : ""}`;
  }
  if (command === "ticket.events") {
    const events = recordsAt(data, "events");
    return events?.map((event) => JSON.stringify(event)).join("\n") ?? null;
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

/** `doctor`'s reply is already a report; only its shape needs checking. */
function doctorReport(data: unknown): string | null {
  if (!isRecord(data)) return null;
  const { checks, summary } = data;
  if (!Array.isArray(checks) || typeof summary !== "string") return null;
  return renderDoctorReport(checks as DoctorCheck[], summary, sessionEnvRepair(data["pathRepair"]));
}

function renderCliTextSuccess(command: string, data: unknown): string {
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
  const stable = renderStableLines(command, data);
  if (stable !== null) return stable.length === 0 ? "" : `${stable}\n`;
  return `${terminalSafeJson(data)}\n`;
}

export function renderCliSuccess(command: string, data: unknown, options: RenderOptions): string {
  if (options.json) return `${terminalSafeJson(data)}\n`;
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
  return terminalSafeText(renderCliTextSuccess(command, data));
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
