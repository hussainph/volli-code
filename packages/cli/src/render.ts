import { TICKET_STATUS_LABELS } from "@volli/shared";
import type { AgentError, AgentErrorCode, TicketStatus } from "@volli/shared";

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
  for (const event of recordsAt(data, "events") ?? [])
    lines.push(`event  ${JSON.stringify(event)}`);
  for (const comment of recordsAt(data, "comments") ?? []) {
    lines.push(`comment  ${JSON.stringify(comment)}`);
  }
  return lines.join("\n");
}

/** A nullable ahead/behind/unpushed count: `-` when unknown, else the number. */
function countCell(value: unknown): string {
  return value === null || value === undefined ? "-" : terminalSafeInline(value);
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

function renderStableLines(command: string, data: unknown): string | null {
  if (!isRecord(data)) return null;
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
          [session["id"], session["kind"], session["status"], session["ticket"], session["title"]]
            .filter((value) => value !== null && value !== undefined)
            .map(terminalSafeInline)
            .join("  "),
        )
        .join("\n") ?? null
    );
  }
  if (command === "session.peek") {
    if (typeof data["session"] !== "string" || typeof data["status"] !== "string") return null;
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
    if (data["degraded"] === true) lines.push("degraded  true");
    return lines.join("\n");
  }
  if (command === "session.done" || command === "session.blocked") {
    return `${terminalSafeInline(data["session"])}  ${terminalSafeInline(data["signal"])}`;
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
function renderCliTextSuccess(command: string, data: unknown): string {
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
  return terminalSafeText(renderCliTextSuccess(command, data));
}

export function renderCliError(error: AgentError): string {
  return `error[${error.code}] ${terminalSafeInline(error.message)}\n`;
}

export function exitCodeForError(code: AgentErrorCode): 1 | 2 | 3 {
  if (code === "APP_UNREACHABLE") return 3;
  if (code === "USAGE" || code === "INVALID_REQUEST" || code === "UNSUPPORTED_COMMAND") return 2;
  return 1;
}
