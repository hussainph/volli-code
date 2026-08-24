/**
 * `volli cost` — what a pass cost, and where it went (VC-87).
 *
 * READ TIER, and that is the design rather than a consequence of it. VC-92's
 * staging: an orchestrator sampling spend should never pay context rent for the
 * privilege, so this is a CLI verb any caller may run and compose in a shell —
 * not a named tool sitting in every Role bundle's prompt, costing model context
 * on every turn whether or not anyone asks.
 *
 * ONE INDEXED READ. The answer comes from the usage projection, which is a fact
 * index over `usage.recorded` events, so nothing here folds a Session history
 * or opens a transcript artifact. That is the difference between a cost
 * question cheap enough to ask in a loop and one nobody asks twice.
 *
 * WHAT THIS IS NOT, and neither belongs here later:
 *
 * - It is not an account meter. What an API organization has spent or has left
 *   is a different fact with a different credential, a different scope and an
 *   `asOf`, and folding it into this total would let a catalogue estimate be
 *   read as a bill. That is `volli account usage`, unbuilt.
 * - It is not a budget control. A cap a Session can write is decoration, so
 *   setting one is app-owned policy (VC-44) and a cap that trips rides
 *   `ticket.signal` (VC-85).
 */

import {
  displayTicketId,
  isSessionUsageGrouping,
  sessionUsageWindowSince,
  shortSessionId,
} from "@volli/shared";
import type {
  AgentRequest,
  AgentResponse,
  SessionUsageGrouping,
  SessionUsageReport,
  SessionUsageScope,
  SessionUsageWindow,
  SessionUsageSummary,
  Project,
  SessionProjection,
} from "@volli/shared";

import { getTicketRow } from "../db/tickets-repo";
import { failure } from "./context";
import type { AgentCommandContext } from "./context";
import { projectForCreate, ticketForDisplayId } from "./resolution";

/**
 * A raw socket request can carry any `--since` shape, including one the CLI
 * parser would have refused. Checked here rather than trusted, because the two
 * doors are not the same door: the parser guards typed argv, and this guards
 * whatever a process wrote to the socket.
 */
function readWindow(value: unknown): SessionUsageWindow | null | "invalid" {
  if (value === undefined) return null;
  if (typeof value !== "object" || value === null) return "invalid";
  const window = value as Partial<SessionUsageWindow>;
  if (window.kind === "instant") {
    const { epochMs } = window as { epochMs: unknown };
    return typeof epochMs === "number" && Number.isFinite(epochMs)
      ? { kind: "instant", epochMs }
      : "invalid";
  }
  if (window.kind === "duration") {
    const { ms } = window as { ms: unknown };
    return typeof ms === "number" && Number.isFinite(ms) && ms >= 0
      ? { kind: "duration", ms }
      : "invalid";
  }
  return "invalid";
}

/**
 * A Session by its short public handle, terminal or chat.
 *
 * Deliberately not `sessionForPublicId`, which answers only for Sessions that
 * ever opened a PTY. A chat Session is the one that actually spends money, so
 * a cost verb that could not address one would refuse the common case.
 */
function sessionForCostHandle(
  projections: readonly SessionProjection[],
  selector: unknown,
): { ok: true; sessionId: string } | { ok: false; response: AgentResponse } {
  if (typeof selector !== "string" || selector.length === 0) {
    return { ok: false, response: failure("INVALID_REQUEST", "A session id is required.") };
  }
  const matches = projections.filter(
    (projection) => shortSessionId(projection.session.id) === selector,
  );
  if (matches.length > 1) {
    return {
      ok: false,
      response: failure("AMBIGUOUS_CONTEXT", `Session id ${selector} is ambiguous.`),
    };
  }
  const match = matches[0];
  return match
    ? { ok: true, sessionId: match.session.id }
    : { ok: false, response: failure("SESSION_NOT_FOUND", `No session matches ${selector}.`) };
}

/** The wire shape of one summary. Flat, so an agent can `jq` a field without a path. */
function usageWire(summary: SessionUsageSummary): Record<string, unknown> {
  return {
    // Money first, and always three fields rather than one: the number, what
    // kind of number it is, and how much of the report it covers. A caller
    // reading only `costUsd` would print a floor as a total.
    costUsd: summary.knownCostUsd,
    costBasis: summary.costBasis,
    costCoverage: summary.costCoverage,
    // Non-overlapping classes, each named for what it is. `inputTokens` is
    // specifically the part NOT served from cache, so it is never a total.
    inputTokens: summary.inputTokens,
    outputTokens: summary.outputTokens,
    cacheReadTokens: summary.cacheReadTokens,
    cacheWriteTokens: summary.cacheWriteTokens,
    totalTokens:
      summary.inputTokens +
      summary.outputTokens +
      summary.cacheReadTokens +
      summary.cacheWriteTokens,
    cachedInputShare: summary.cachedInputShare,
    requestCount: summary.requestCount,
    pricedRequestCount: summary.pricedRequestCount,
  };
}

/**
 * A group as a reader may address it: a Ticket display id, a short Session
 * handle, `provider/model`, or a UTC day — and a word for it when it has no
 * handle.
 *
 * NO INTERNAL ID CROSSES, here as on every other verb. A Session's public
 * handle is its short id and a Ticket's is its display id; the stored UUIDs are
 * not addressable and printing one teaches a caller to try.
 *
 * Three different nulls have to stay apart, which is why `label` exists beside
 * `key`:
 *
 * - Spend on NO Ticket is `key: null, label: null`. It is a real group — a
 *   Project Session's bill — and dropping it would make the rows add up to
 *   less than the total printed above them.
 * - Spend on a Ticket that has since been HARD-DELETED is `key: null,
 *   label: "(deleted ticket)"`. The attribution survived in the fact, so the
 *   money is still counted; what is gone is anything a reader could open. An
 *   archived Ticket is not this case — it keeps its row and its display id.
 * - Every other group has both.
 */
function groupIdentity(
  key: string | null,
  groupBy: SessionUsageGrouping,
  context: { db: AgentCommandContext["options"]["db"]; projectById: ReadonlyMap<string, Project> },
): { key: string | null; label: string | null } {
  if (key === null) return { key: null, label: null };
  if (groupBy === "session") {
    const short = shortSessionId(key);
    return { key: short, label: short };
  }
  if (groupBy !== "ticket") return { key, label: key };
  // `getTicketRow` rather than `getTicket`: an archived Ticket keeps its row,
  // and its bill is exactly what someone asks about after a pass finishes.
  const ticket = getTicketRow(context.db, key);
  const project = ticket ? context.projectById.get(ticket.project_id) : undefined;
  if (ticket === undefined || project === undefined) {
    return { key: null, label: "(deleted ticket)" };
  }
  const displayId = displayTicketId(project.ticketPrefix, ticket.ticket_number);
  return { key: displayId, label: displayId };
}

/** `volli cost` — the local Session/Ticket/project rollup. */
export async function costVerb(
  context: AgentCommandContext,
  request: AgentRequest,
): Promise<AgentResponse> {
  const { options, projects, projections, envSession, sessionEngine, now } = context;

  const groupByArg = request.args["groupBy"];
  if (groupByArg !== undefined && !isSessionUsageGrouping(groupByArg)) {
    return failure("INVALID_REQUEST", `Invalid grouping ${JSON.stringify(groupByArg)}.`);
  }
  const groupBy = groupByArg;

  const window = readWindow(request.args["since"]);
  if (window === "invalid") {
    return failure(
      "INVALID_REQUEST",
      "since must be an RFC 3339 instant or a look-back like 7d, 24h or 90m.",
    );
  }

  const ticketSelector = request.args["ticket"];
  const sessionSelector = request.args["session"];
  const allProjects = request.args["allProjects"] === true;
  const named = [ticketSelector, sessionSelector].filter((value) => value !== undefined).length;
  if (named + (allProjects ? 1 : 0) > 1) {
    return failure(
      "INVALID_REQUEST",
      "cost takes one of --ticket, --session or --all-projects, not several.",
    );
  }

  let scope: SessionUsageScope;
  let scopeLabel: string;
  if (allProjects) {
    scope = { kind: "all" };
    scopeLabel = "all projects";
  } else if (sessionSelector !== undefined) {
    const resolved = sessionForCostHandle(projections, sessionSelector);
    if (!resolved.ok) return resolved.response;
    scope = { kind: "session", sessionId: resolved.sessionId };
    scopeLabel = `session ${shortSessionId(resolved.sessionId)}`;
  } else if (ticketSelector !== undefined) {
    // Archived tickets are allowed: an archived Ticket's bill is exactly the
    // question someone asks after a pass finishes, and refusing it would make
    // the verb useless at the one moment it is most wanted.
    const resolved = ticketForDisplayId(options.db, projects, ticketSelector, {
      allowArchived: true,
    });
    if (!resolved.ok) return resolved.response;
    // An explicit --project alongside --ticket must agree — the same refusal
    // `session.list` makes, in the same words, because letting the ticket's
    // project silently win is how a caller comes to trust the wrong total.
    if (request.args["project"] !== undefined) {
      const selected = projectForCreate(options.db, projects, envSession, request);
      if (!selected.ok) return selected.response;
      if (selected.project.id !== resolved.project.id) {
        return failure(
          "CONTEXT_MISMATCH",
          `Ticket ${String(ticketSelector)} belongs to project ${resolved.project.name}, not the requested project ${selected.project.name}.`,
        );
      }
    }
    scope = { kind: "ticket", ticketId: resolved.ticket.id };
    scopeLabel = `ticket ${displayTicketId(resolved.project.ticketPrefix, resolved.ticket.ticketNumber)}`;
  } else {
    const resolved = projectForCreate(options.db, projects, envSession, request);
    if (!resolved.ok) return resolved.response;
    scope = { kind: "project", projectId: resolved.project.id };
    scopeLabel = `project ${resolved.project.name}`;
  }

  const since = window === null ? undefined : sessionUsageWindowSince(window, now());
  const report: SessionUsageReport = await sessionEngine.reportUsage({
    scope,
    ...(since === undefined ? {} : { since }),
    ...(groupBy === undefined ? {} : { groupBy }),
  });

  const projectById = new Map(projects.map((project) => [project.id, project]));
  return {
    v: 1,
    ok: true,
    data: {
      scope: scopeLabel,
      // The window as an INSTANT, not as the word the caller typed. `7d` means
      // a different span depending on when it was asked, and an answer that
      // echoed the word back could not be compared with another one.
      since: since ?? null,
      ...usageWire(report.total),
      meteredSessionCount: report.meteredSessionCount,
      // What this profile is able to answer at all. An empty report from a
      // profile that started metering yesterday and an empty report from a
      // project nobody ran are the same rows and different facts.
      coverage: report.history.complete ? "complete" : "partial",
      meteredFrom: report.history.meteredFrom === 0 ? null : report.history.meteredFrom,
      groups:
        groupBy === undefined
          ? []
          : report.groups.map((group) =>
              // Assigned rather than spread (oxc(no-map-spread)); each target
              // is a fresh literal, so the rows stay independent.
              Object.assign(
                { groupBy },
                groupIdentity(group.key, groupBy, { db: options.db, projectById }),
                usageWire(group.usage),
              ),
            ),
    },
  };
}
