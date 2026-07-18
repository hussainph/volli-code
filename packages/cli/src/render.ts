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
    return `${value["name"]} (${value["prefix"]})`;
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
      const labelText = labels.length > 0 ? `  [${labels.join(", ")}]` : "";
      return `${String(ticket["id"])}  ${titleCase(String(ticket["priority"]))}  ${String(ticket["title"])}${labelText}`;
    });
    const normalizedStatus = status as TicketStatus;
    sections.push(
      `${TICKET_STATUS_LABELS[normalizedStatus] ?? titleCase(status)}\n${lines.join("\n")}`,
    );
  }
  const header = `${project["name"]} (${project["prefix"]})`;
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
  const labelText = labels.length > 0 ? `  [${labels.join(", ")}]` : "";
  return `${ticket["id"]}  ${TICKET_STATUS_LABELS[status] ?? titleCase(status)}  ${ticket["title"]}${labelText}`;
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
    if (typeof value === "string") lines.push(`${key}  ${value}`);
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

function renderStableLines(command: string, data: unknown): string | null {
  if (!isRecord(data)) return null;
  if (["ticket.create", "ticket.update", "ticket.move"].includes(command)) {
    return renderTicketResult(data);
  }
  if (command === "ticket.show") return renderDetail(data);
  if (command === "ticket.archive" && isRecord(data["ticket"])) {
    const id = data["ticket"]["id"];
    return typeof id === "string" ? `${id}  archived` : null;
  }
  if (command === "ticket.comment" && isRecord(data["comment"])) {
    const ticket = data["comment"]["ticket"];
    return typeof ticket === "string" ? `${ticket}  comment added` : null;
  }
  if (command === "project.list") {
    const projects = recordsAt(data, "projects");
    return (
      projects
        ?.map(
          (project) =>
            `${String(project["prefix"])}  ${String(project["name"])}  ${String(project["path"])}  ${String(project["tickets"])} tickets`,
        )
        .join("\n") ?? null
    );
  }
  if (command === "label.list") {
    const labels = recordsAt(data, "labels");
    return (
      labels
        ?.map((label) => `${String(label["name"])}  ${String(label["tickets"])} tickets`)
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
            .map(String)
            .join("  "),
        )
        .join("\n") ?? null
    );
  }
  if (command === "session.peek") {
    if (typeof data["session"] !== "string" || typeof data["status"] !== "string") return null;
    const output = typeof data["output"] === "string" ? data["output"] : "";
    return `${data["session"]}  ${data["status"]}${output.length > 0 ? `\n${output}` : ""}`;
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
        return `${key}  ${value === null || value === undefined ? "-" : String(value)}`;
      });
    if (data["degraded"] === true) lines.push("degraded  true");
    return lines.join("\n");
  }
  if (command === "session.done" || command === "session.blocked") {
    return `${String(data["session"])}  ${String(data["signal"])}`;
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
export function renderCliSuccess(command: string, data: unknown, options: RenderOptions): string {
  if (options.json) return `${JSON.stringify(data)}\n`;
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
          const labels = ticket.labels.length === 0 ? "" : `  [${ticket.labels.join(", ")}]`;
          return `${ticket.id}  ${TICKET_STATUS_LABELS[ticket.status]}  ${ticket.title}${labels}`;
        })
        .join("\n")
        .concat(tickets.length === 0 ? "" : "\n");
    }
  }
  const stable = renderStableLines(command, data);
  if (stable !== null) return stable.length === 0 ? "" : `${stable}\n`;
  return `${JSON.stringify(data)}\n`;
}

export function renderCliError(error: AgentError): string {
  return `error[${error.code}] ${error.message}\n`;
}

export function exitCodeForError(code: AgentErrorCode): 1 | 2 | 3 {
  if (code === "APP_UNREACHABLE") return 3;
  if (code === "USAGE" || code === "INVALID_REQUEST" || code === "UNSUPPORTED_COMMAND") return 2;
  return 1;
}
