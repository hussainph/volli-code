import { TICKET_STATUS_LABELS } from "@volli/shared";
import type { AgentError, AgentErrorCode, TicketStatus } from "@volli/shared";

export interface RenderOptions {
  json: boolean;
  tty: boolean;
  noColor?: boolean;
}

interface TicketListItem {
  id: string;
  status: TicketStatus;
  title: string;
  labels: string[];
}

function ticketList(data: unknown): TicketListItem[] | null {
  if (typeof data !== "object" || data === null) return null;
  const tickets = (data as { tickets?: unknown }).tickets;
  if (!Array.isArray(tickets)) return null;
  return tickets as TicketListItem[];
}

/** Renders server JSON directly or as the command's stable text contract. */
export function renderCliSuccess(command: string, data: unknown, options: RenderOptions): string {
  if (options.json) return `${JSON.stringify(data)}\n`;
  if (command === "ticket.brief" && typeof data === "object" && data !== null) {
    const prompt = (data as { prompt?: unknown }).prompt;
    if (typeof prompt === "string") return prompt.endsWith("\n") ? prompt : `${prompt}\n`;
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
