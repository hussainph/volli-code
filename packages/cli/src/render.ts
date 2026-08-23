import { SESSION_ENV_TOOLS, TICKET_STATUS_LABELS } from "@volli/shared";
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
 * The prompt.baseline report: one header with the honest rollup, one row per
 * composed section, and the named remainder the estimate deliberately excludes.
 */
function renderPromptBaseline(data: Record<string, unknown>): string | null {
  const sections = recordsAt(data, "sections");
  const total = data["total"];
  if (sections === null || !isRecord(total)) return null;
  const header = `prompt baseline  ${terminalSafeInline(data["role"])}  ~${terminalSafeInline(total["tokens"])} tokens  ${terminalSafeInline(total["chars"])} chars  (est. at ${terminalSafeInline(data["charsPerToken"])} chars/token)`;
  const rows = sections.map(
    (section) =>
      `  ${terminalSafeInline(section["id"])}  ~${terminalSafeInline(section["tokens"])} tokens  ${terminalSafeInline(section["chars"])} chars`,
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
      const requiredTools = Array.isArray(env["requiredTools"]) ? env["requiredTools"] : [];
      lines.push(
        `env.requiredTools  ${
          requiredTools.length === 0 ? "-" : requiredTools.map(terminalSafeInline).join(" ")
        }`,
      );
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
