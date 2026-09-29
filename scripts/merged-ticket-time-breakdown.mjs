/**
 * Where a merged ticket's time went (VC-443): the breakdown of each cohort
 * ticket's window — first Session message to final merge — into mutually
 * exclusive categories, plus the second clock (first move to Doing → merge)
 * and the tool-call durations behind the in-turn silences.
 *
 * Not a runner of its own: `scripts/merged-ticket-time-to-merge.mjs` calls it
 * with the cohort it has already built, so the breakdown is over exactly the
 * tickets, windows and Session attribution the headline measures, and its
 * aggregates land in the same `aggregates.json`. The rules are in
 * `merged-ticket-time-to-merge-logic.mjs`; this file only reads, reduces and
 * assembles.
 *
 * READ-ONLY, like the runner. The ledger arrives already opened `readonly`;
 * the Pi session files are read, never written. What is read is reduced at the
 * door: a ledger event becomes its kind, its clock and the identifiers the
 * interval rules need; a failure Attention's detail text is classified in
 * memory and dropped; a bash command is classified in memory and dropped; a
 * ticket event yields only a status or a PR number (the `created` payload also
 * carries the title, which the query never selects). Nothing published
 * carries a command, a message, a path, or a time of day.
 */

import assert from "node:assert/strict";
import { closeSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";

import {
  BREAKDOWN_CATEGORIES,
  classifyFailure,
  decomposeTicket,
  describe,
  elapsedBand,
  FAILURE_ATTENTION_KINDS,
  FAILURE_CLASSES,
  FAILURE_ORIGIN,
  firstMoveToDoing,
  MINUTE_MS,
  prIntervalsFromCapture,
  prIntervalsFromLedger,
  quantile,
  attributeSilences,
  sessionTimeline,
  SILENCE_SENSITIVITY_MINUTES,
  statusTimeline,
  summariseDurations,
  toolCallCategory,
  toolCallDurations,
  unionIntervals,
  utcMonth,
} from "./merged-ticket-time-to-merge-logic.mjs";

const HOUR_MS = 3_600_000;

/** The exact capture the report's PR-open times came from; recorded in the artifact. */
export const PR_CAPTURE_COMMAND =
  "gh pr list --state merged --limit 1000 --json number,createdAt,mergedAt,headRefName";

/* -------------------------------------------------------------------- ledger */

/**
 * Every Session event in the ledger, every project, reduced to what the
 * interval rules read. All projects, because "another Session was running
 * while this ticket sat idle" is a question about the whole machine.
 *
 * Only these payload fields are ever extracted: a turn id, an interaction id,
 * an Attention's id and kind, whether a signal was the watchdog's, and — for a
 * failure Attention only — its detail, which `classifyFailure` reduces to a
 * class before the row is dropped.
 */
export function readSessionEvents(db) {
  const rows = db
    .prepare(
      `SELECT e.session_id AS sessionId, e.occurred_at AS at, q.kind AS kind,
              CASE
                WHEN q.kind IN ('turn.started','turn.completed','turn.interrupted')
                  THEN json_extract(e.payload, '$.turnId')
                WHEN q.kind = 'interaction.opened'
                  THEN json_extract(e.payload, '$.interaction.id')
                WHEN q.kind IN ('interaction.resolved','interaction.cancelled')
                  THEN json_extract(e.payload, '$.interactionId')
                WHEN q.kind = 'attention.raised'
                  THEN json_extract(e.payload, '$.attention.id')
                WHEN q.kind = 'attention.cleared'
                  THEN json_extract(e.payload, '$.attentionId')
              END AS ref,
              CASE WHEN q.kind = 'attention.raised'
                THEN json_extract(e.payload, '$.attention.kind') END AS attentionKind,
              CASE WHEN q.kind = 'attention.raised'
                THEN json_extract(e.payload, '$.attention.detail') END AS detail,
              CASE WHEN q.kind = 'session.signaled'
                THEN json_extract(e.payload, '$.reason') LIKE 'Watchdog:%' END AS watchdog
         FROM session_events e
         JOIN session_event_sequence q ON q.event_id = e.id
        ORDER BY e.session_id, e.sequence`,
    )
    .iterate();
  const bySession = new Map();
  for (const row of rows) {
    const event = { at: row.at, kind: row.kind };
    if (row.kind.startsWith("turn.")) event.turnId = row.ref;
    else if (row.kind.startsWith("interaction.")) event.interactionId = row.ref;
    else if (row.kind === "attention.raised" || row.kind === "attention.cleared") {
      event.attentionId = row.ref;
      if (row.kind === "attention.raised" && FAILURE_ATTENTION_KINDS.has(row.attentionKind)) {
        event.failureClass = classifyFailure(row.attentionKind, row.detail);
      }
    } else if (row.kind === "session.signaled") event.watchdog = row.watchdog === 1;
    if (!bySession.has(row.sessionId)) bySession.set(row.sessionId, []);
    bySession.get(row.sessionId).push(event);
  }
  return bySession;
}

/**
 * The project's ticket events the breakdown needs — status history and PR
 * links — keyed by display id. `json_extract` picks the status or url alone.
 */
export function readTicketEvents(db, projectId, prefix) {
  const rows = db
    .prepare(
      `SELECT t.ticket_number AS number, te.created_at AS at, te.kind AS kind,
              CASE WHEN te.kind = 'created' THEN json_extract(te.payload, '$.status') END AS status,
              CASE WHEN te.kind = 'status_changed' THEN json_extract(te.payload, '$.from') END AS fromStatus,
              CASE WHEN te.kind = 'status_changed' THEN json_extract(te.payload, '$.to') END AS toStatus,
              CASE WHEN te.kind IN ('pr_opened','pr_merged') THEN json_extract(te.payload, '$.url') END AS url
         FROM ticket_events te
         JOIN tickets t ON t.id = te.ticket_id
        WHERE t.project_id = ?
          AND te.kind IN ('created','status_changed','pr_opened','pr_merged')`,
    )
    .all(projectId);
  const byTicket = new Map();
  for (const row of rows) {
    const id = `${prefix}-${row.number}`;
    if (!byTicket.has(id)) byTicket.set(id, { status: [], pr: [] });
    const entry = byTicket.get(id);
    if (row.kind === "created" || row.kind === "status_changed") {
      entry.status.push({
        at: row.at,
        kind: row.kind,
        status: row.status ?? undefined,
        from: row.fromStatus ?? undefined,
        to: row.toStatus ?? undefined,
      });
    } else {
      const match = typeof row.url === "string" ? /\/pull\/(\d+)/.exec(row.url) : null;
      entry.pr.push({ at: row.at, kind: row.kind, pr: match ? Number(match[1]) : undefined });
    }
  }
  return byTicket;
}

/* ----------------------------------------------------------------- PR input */

/**
 * A `gh pr list` capture (see `PR_CAPTURE_COMMAND`), reduced to numbers,
 * branch names and epoch-ms clocks. The capture itself is an input, kept out
 * of the repository: it carries times of day.
 */
export function readPrCapture(path) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(raw)) throw new Error(`${path}: expected the JSON array gh pr list writes`);
  return raw.map((pr) => ({
    number: pr.number,
    headRefName: pr.headRefName ?? "",
    createdAt: Date.parse(pr.createdAt),
    mergedAt: pr.mergedAt ? Date.parse(pr.mergedAt) : undefined,
  }));
}

/* ------------------------------------------------------------- Pi sessions */

/**
 * Pi has written two storage formats into this directory, and a reader that
 * knows only one silently loses the other's Sessions:
 *
 * - the first (August): one JSON object per line; the header line carries
 *   `metadata.volliSessionId`;
 * - `storageVersion` 1 (September): the header has no metadata; the Volli
 *   Session id is a `volli.identity.v1` record on a following line, and
 *   entries arrive as JSON ARRAYS of records, one batch per line.
 *
 * Both reduce to the same records, so everything below reads a line as "one
 * record, or an array of them".
 */
function* piRecords(line) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return;
  }
  if (Array.isArray(parsed)) yield* parsed;
  else yield parsed;
}

/** The Volli Session id a Pi session file belongs to, from its opening lines. */
export function piSessionId(head) {
  for (const line of head.split("\n").slice(0, 8)) {
    for (const record of piRecords(line)) {
      const id =
        record?.metadata?.volliSessionId ??
        (record?.namespace === "volli.identity.v1" ? record.value?.volliSessionId : undefined);
      if (typeof id === "string") return id;
    }
  }
  return undefined;
}

/**
 * The tool-call records of one Pi session file, reduced to what
 * `toolCallDurations` reads: an assistant message's calls (id, tool name and,
 * for bash only, the command — classified by the caller and then dropped) and
 * each result's call id. Message text and tool output are never kept.
 */
export function piToolEntries(text) {
  const entries = [];
  for (const line of text.split("\n")) {
    if (!line.includes('"type":"message"')) continue;
    for (const record of piRecords(line)) {
      const message = record?.type === "message" ? record.message : undefined;
      if (message?.role === "assistant") {
        const toolCalls = (message.content ?? []).filter((c) => c?.type === "toolCall");
        if (toolCalls.length === 0) continue;
        entries.push({
          at: record.timestamp,
          role: "assistant",
          calls: toolCalls.map((c) => ({
            id: c.id,
            name: c.name,
            command: c.name === "bash" ? c.arguments?.command : undefined,
          })),
        });
      } else if (message?.role === "toolResult") {
        entries.push({ at: record.timestamp, role: "toolResult", toolCallId: message.toolCallId });
      }
    }
  }
  return entries;
}

/** The first 64 KiB of a file: enough for the header and identity lines. */
function readHead(path) {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, read).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * Tool-call durations for the cohort, from Pi's own session files. A file
 * belongs to a Session through its `volliSessionId`; a call counts when that
 * Session is attributed to a cohort ticket and the call returned inside that
 * ticket's window. Each call is reduced to `{ category, ms, month }` here — the
 * command is classified and dropped. `intervalsBySession` keeps every call's
 * `{ start, end, category }` in memory, for `attributeSilences`; it is never
 * published.
 */
export function readToolCalls(root, windowBySession) {
  const calls = [];
  const intervalsBySession = new Map();
  let files = 0;
  let unanswered = 0;
  let dirs;
  try {
    dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return { available: false, calls, intervalsBySession, files, unanswered };
  }
  for (const dir of dirs) {
    for (const name of readdirSync(join(root, dir.name))) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(root, dir.name, name);
      const sessionId = piSessionId(readHead(path));
      const window = windowBySession.get(sessionId);
      if (window === undefined) continue;
      files += 1;
      const result = toolCallDurations(piToolEntries(readFileSync(path, "utf8")));
      unanswered += result.unanswered;
      if (!intervalsBySession.has(sessionId)) intervalsBySession.set(sessionId, []);
      for (const call of result.calls) {
        const category = toolCallCategory(call.name, call.command);
        intervalsBySession
          .get(sessionId)
          .push({ start: call.at - call.ms, end: call.at, category });
        if (call.at < window.start || call.at > window.end) continue;
        calls.push({
          category,
          ms: call.ms,
          month: utcMonth(call.at),
          mergeMonth: window.mergeMonth,
        });
      }
    }
  }
  return { available: true, calls, intervalsBySession, files, unanswered };
}

/* ---------------------------------------------------------------- assembly */

const hours = (ms) => ms / HOUR_MS;
const round = (value, digits = 3) =>
  value === undefined || Number.isNaN(value) ? undefined : Number(value.toFixed(digits));

function addInto(target, source) {
  for (const [key, value] of Object.entries(source)) target[key] = (target[key] ?? 0) + value;
  return target;
}

function roundHours(msByKey) {
  return Object.fromEntries(
    Object.entries(msByKey)
      .toSorted((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([k, ms]) => [k, round(hours(ms), 2)]),
  );
}

/** A silence the executor came back from by itself: it wrote again, or finished. */
const resumedOnOwn = (s) => s.endedBy === "resumed" || s.endedBy === "turnCompleted";

/** The silences that STARTED inside a window, cut at its end. */
function silencesInWindow(list, start, end) {
  const out = [];
  for (const s of list) {
    if (s.start < start || s.start >= end) continue;
    out.push(Object.assign({}, s, { end: Math.min(s.end, end) }));
  }
  return out;
}

/**
 * Decompose every cohort row at one silence threshold. Returns one record per
 * ticket plus the silences that started inside its window.
 */
function decomposeCohort({
  rows,
  eventsBySession,
  ticketEvents,
  prCapture,
  silenceMs,
  elsewhereBusy,
  toolIntervalsBySession,
}) {
  const perTicket = [];
  for (const row of rows) {
    const timelines = row.sessionIds.map((id) =>
      sessionTimeline(eventsBySession.get(id) ?? [], { silenceMs }),
    );
    const events = ticketEvents.get(row.ticket) ?? { status: [], pr: [] };
    const fromLedger = prIntervalsFromLedger(events.pr);
    const fromCapture =
      prCapture === undefined
        ? undefined
        : prIntervalsFromCapture({
            ticket: row.ticket,
            prNumbers: [row.pr, row.ledgerPr],
            prs: prCapture,
          });
    const pr = fromCapture ?? fromLedger;
    const statusAt = statusTimeline(events.status);
    const window = { windowStart: row.startAt, windowEnd: row.finalMergeAt };
    const primary = decomposeTicket({
      ...window,
      timelines,
      prIntervals: pr.intervals,
      statusAt,
      elsewhereBusy,
    });
    const ledgerVariant =
      fromCapture === undefined
        ? primary
        : decomposeTicket({
            ...window,
            timelines,
            prIntervals: fromLedger.intervals,
            statusAt,
            elsewhereBusy,
          });
    const inWindow = (list) => silencesInWindow(list, row.startAt, row.finalMergeAt);
    const silences = timelines.flatMap((tl) => inWindow(tl.silences));
    const silenceTools = { byTool: {}, noTool: 0 };
    row.sessionIds.forEach((id, i) => {
      const own = attributeSilences(
        inWindow(timelines[i].silences),
        toolIntervalsBySession?.get(id) ?? [],
      );
      addInto(silenceTools.byTool, own.byTool);
      silenceTools.noTool += own.noTool;
    });
    perTicket.push({
      row,
      primary,
      ledgerVariant,
      silences,
      silenceTools,
      hasToolRecord: row.sessionIds.some((id) => toolIntervalsBySession?.has(id)),
      unterminatedTurns: timelines.reduce((a, tl) => a + tl.unterminatedTurns, 0),
      failureRaises: timelines
        .flatMap((tl) => tl.failures)
        .filter((f) => f.start >= row.startAt && f.start < row.finalMergeAt),
      prFirstOpenedAt: pr.firstOpenedAt,
      prCount: pr.prCount,
      ledgerPrFirstOpenedAt: fromLedger.firstOpenedAt,
      captureFirstOpenedAt: fromCapture?.firstOpenedAt,
      firstDoingAt: firstMoveToDoing(events.status),
    });
  }
  return perTicket;
}

function totalsOf(perTicket, pick = (t) => t.primary) {
  const byCategory = Object.fromEntries(BREAKDOWN_CATEGORIES.map((c) => [c, 0]));
  const failureByClass = {};
  const failureByEnd = {};
  const idleByStatus = {};
  let idleWhileElsewhereRunning = 0;
  let totalMs = 0;
  for (const ticket of perTicket) {
    const d = pick(ticket);
    addInto(byCategory, d.byCategory);
    addInto(failureByClass, d.failureByClass);
    addInto(failureByEnd, d.failureByEnd);
    addInto(idleByStatus, d.idleByStatus);
    idleWhileElsewhereRunning += d.idleWhileElsewhereRunning;
    totalMs += d.totalMs;
  }
  return {
    byCategory,
    failureByClass,
    failureByEnd,
    idleByStatus,
    idleWhileElsewhereRunning,
    totalMs,
  };
}

function categoryTable(totals) {
  return Object.fromEntries(
    BREAKDOWN_CATEGORIES.map((c) => [
      c,
      {
        hours: round(hours(totals.byCategory[c]), 1),
        share: round(totals.byCategory[c] / totals.totalMs, 4),
      },
    ]),
  );
}

function perTicketMeans(perTicket) {
  const n = perTicket.length;
  const totals = totalsOf(perTicket);
  return {
    n,
    elapsedHoursPerTicket: round(hours(totals.totalMs) / n, 2),
    hoursPerTicket: Object.fromEntries(
      BREAKDOWN_CATEGORIES.map((c) => [c, round(hours(totals.byCategory[c]) / n, 2)]),
    ),
    failureBlockedHoursPerTicketByClass: Object.fromEntries(
      FAILURE_CLASSES.filter((k) => totals.failureByClass[k] > 0).map((k) => [
        k,
        round(hours(totals.failureByClass[k]) / n, 3),
      ]),
    ),
    ticketsWithAnyFailureBlock: perTicket.filter((t) => t.primary.byCategory.failureBlocked > 0)
      .length,
    // A window with no turn at all: the work, if any, ran somewhere the ledger
    // cannot see (a terminal companion, another tool), and reads as idle.
    ticketsWithNoTurnInWindow: perTicket.filter(
      (t) => t.primary.byCategory.working + t.primary.byCategory.silentInTurn === 0,
    ).length,
    shareOfHours: Object.fromEntries(
      BREAKDOWN_CATEGORIES.map((c) => [c, round(totals.byCategory[c] / totals.totalMs, 4)]),
    ),
  };
}

function groupBy(list, keyOf) {
  const groups = new Map();
  for (const item of list) {
    const key = keyOf(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return [...groups].toSorted((a, b) => (a[0] < b[0] ? -1 : 1));
}

/**
 * Everything the breakdown publishes, from the cohort rows and the reduced
 * inputs. `rows` are the runner's primary cohort rows, each with `sessionIds`,
 * `startAt`, `finalMergeAt`, `pr` and `ledgerPr`.
 */
export function buildBreakdown({
  rows,
  eventsBySession,
  ticketEvents,
  prCapture,
  prCaptureMeta,
  silenceMinutes,
  toolCalls,
}) {
  // Every open-turn stretch in the ledger, for "another Session was running".
  // Turns do not depend on the silence threshold, so any threshold will do.
  const allTurns = [];
  for (const events of eventsBySession.values()) {
    allTurns.push(...sessionTimeline(events, { silenceMs: Infinity }).turns);
  }
  const elsewhereBusy = unionIntervals(allTurns);

  const at = (minutes) =>
    decomposeCohort({
      rows,
      eventsBySession,
      ticketEvents,
      prCapture,
      silenceMs: minutes * MINUTE_MS,
      elsewhereBusy,
      toolIntervalsBySession: toolCalls?.intervalsBySession,
    });
  const perTicket = at(silenceMinutes);
  const totals = totalsOf(perTicket);
  const failureTotal = totals.byCategory.failureBlocked;

  const failureBlockedByClass = Object.fromEntries(
    FAILURE_CLASSES.filter((k) => (totals.failureByClass[k] ?? 0) > 0).map((k) => [
      k,
      {
        hours: round(hours(totals.failureByClass[k]), 2),
        shareOfFailureBlocked: round(totals.failureByClass[k] / failureTotal, 4),
        origin: FAILURE_ORIGIN[k],
      },
    ]),
  );
  const failureBlockedByOrigin = {};
  for (const [k, ms] of Object.entries(totals.failureByClass)) {
    failureBlockedByOrigin[FAILURE_ORIGIN[k]] =
      (failureBlockedByOrigin[FAILURE_ORIGIN[k]] ?? 0) + ms;
  }
  const raises = perTicket.flatMap((t) => t.failureRaises);

  const silences = perTicket.flatMap((t) => t.silences);
  const silenceEnds = {};
  for (const s of silences) {
    const entry = (silenceEnds[s.endedBy] ??= { count: 0, hours: 0 });
    entry.count += 1;
    entry.hours += hours(s.end - s.start);
  }
  for (const entry of Object.values(silenceEnds)) entry.hours = round(entry.hours, 1);
  const silenceFailures = {};
  for (const s of silences.filter((x) => x.endedBy === "failure")) {
    const entry = (silenceFailures[s.failureClass] ??= { count: 0, hours: 0 });
    entry.count += 1;
    entry.hours += hours(s.end - s.start);
  }
  for (const entry of Object.values(silenceFailures)) entry.hours = round(entry.hours, 1);
  const tripped = silences.filter((s) => s.watchdogTripped);
  const withToolRecord = perTicket.filter((t) => t.hasToolRecord);
  const silenceByTool = {};
  let silenceNoTool = 0;
  for (const t of withToolRecord) {
    addInto(silenceByTool, t.silenceTools.byTool);
    silenceNoTool += t.silenceTools.noTool;
  }
  const sensitivity = SILENCE_SENSITIVITY_MINUTES.map((minutes) => {
    const t = minutes === silenceMinutes ? totals : totalsOf(at(minutes));
    return Object.assign(
      { silenceMinutes: minutes },
      Object.fromEntries(BREAKDOWN_CATEGORIES.map((c) => [c, round(hours(t.byCategory[c]), 1)])),
    );
  });

  const ledgerTotals = totalsOf(perTicket, (t) => t.ledgerVariant);
  const lagMinutes = perTicket
    .filter((t) => t.ledgerPrFirstOpenedAt !== undefined && t.captureFirstOpenedAt !== undefined)
    .map((t) => (t.ledgerPrFirstOpenedAt - t.captureFirstOpenedAt) / MINUTE_MS)
    .toSorted((a, b) => a - b);

  const prOpenToMerge = perTicket
    .filter((t) => t.prFirstOpenedAt !== undefined && t.prFirstOpenedAt < t.row.finalMergeAt)
    .map((t) => hours(t.row.finalMergeAt - Math.max(t.prFirstOpenedAt, t.row.startAt)));

  // The second clock: first move to Doing → final merge. Tickets never in
  // Doing before their merge are excluded and counted; the primary clock is
  // restated over the same tickets so the two medians compare like for like.
  const doing = { neverInDoing: 0, doingAfterFinalMerge: 0 };
  const doingHours = [];
  const primarySameTickets = [];
  const doingLeadHours = [];
  const doingLagHours = [];
  for (const t of perTicket) {
    if (t.firstDoingAt === undefined) doing.neverInDoing += 1;
    else if (t.firstDoingAt >= t.row.finalMergeAt) doing.doingAfterFinalMerge += 1;
    else {
      doingHours.push(hours(t.row.finalMergeAt - t.firstDoingAt));
      primarySameTickets.push(t.row.elapsedHours);
      if (t.firstDoingAt <= t.row.startAt)
        doingLeadHours.push(hours(t.row.startAt - t.firstDoingAt));
      else doingLagHours.push(hours(t.firstDoingAt - t.row.startAt));
    }
  }
  const medianOf = (list) =>
    list.length === 0
      ? undefined
      : round(
          quantile(
            list.toSorted((a, b) => a - b),
            0.5,
          ),
          2,
        );

  const summarise = (d) =>
    Object.fromEntries(
      Object.entries(d).map(([k, v]) => [k, typeof v === "number" ? round(v, 2) : v]),
    );

  const totalToolMs = new Map();
  for (const c of toolCalls?.calls ?? []) {
    totalToolMs.set(c.category, (totalToolMs.get(c.category) ?? 0) + c.ms);
  }
  const tools =
    toolCalls === undefined || !toolCalls.available
      ? { available: false }
      : {
          available: true,
          scope:
            "Pi session files of cohort Sessions; calls that returned inside the ticket's window",
          files: toolCalls.files,
          calls: toolCalls.calls.length,
          unansweredCalls: toolCalls.unanswered,
          hours: round(hours(toolCalls.calls.reduce((a, c) => a + c.ms, 0)), 1),
          byCategory: roundDurations(summariseDurations(toolCalls.calls, (c) => c.category)),
          // Hours per cohort ticket by the ticket's merge month, for the
          // categories holding at least an hour in total — the same grouping
          // as `byMergeMonthUtc`, so the two read side by side.
          hoursPerTicketByMergeMonth: Object.fromEntries(
            groupBy(perTicket, (t) => utcMonth(t.row.finalMergeAt)).map(([month, list]) => {
              const inMonth = toolCalls.calls.filter((c) => c.mergeMonth === month);
              const byCategory = {};
              for (const c of inMonth)
                byCategory[c.category] = (byCategory[c.category] ?? 0) + c.ms;
              return [
                month,
                Object.fromEntries(
                  Object.entries(byCategory)
                    .filter(([category]) => (totalToolMs.get(category) ?? 0) >= HOUR_MS)
                    .toSorted((a, b) => b[1] - a[1])
                    .map(([category, ms]) => [category, round(hours(ms) / list.length, 3)]),
                ),
              ];
            }),
          ),
          searchAndFindByMonth: roundDurations(
            summariseDurations(
              toolCalls.calls.filter(
                (c) => c.category === "bash:search" || c.category === "bash:find",
              ),
              (c) => `${c.month} ${c.category}`,
            ),
          ),
        };

  return {
    aggregate: {
      definitions: {
        categoriesInPriorityOrder: BREAKDOWN_CATEGORIES,
        silenceMinutes,
        failureClasses: FAILURE_CLASSES,
        failureOrigin: FAILURE_ORIGIN,
        prOpenSource: prCapture === undefined ? "ledger pr_opened/pr_merged" : "gh capture",
        prCapture: prCapture === undefined ? undefined : prCaptureMeta,
      },
      cohortTickets: perTicket.length,
      cohortHours: round(hours(totals.totalMs), 1),
      byCategory: categoryTable(totals),
      failureBlockedByClass,
      failureBlockedByOrigin: roundHours(failureBlockedByOrigin),
      failureBlockedByWhatEndedIt: roundHours(totals.failureByEnd),
      failureBlocks: {
        raisedInWindows: raises.length,
        byClass: Object.fromEntries(
          groupBy(raises, (f) => f.failureClass).map(([k, v]) => [k, v.length]),
        ),
        ticketsWithAnyFailureBlock: perTicket.filter((t) => t.primary.byCategory.failureBlocked > 0)
          .length,
      },
      idleByTicketStatus: roundHours(totals.idleByStatus),
      ticketsWithIdleInStatus: Object.fromEntries(
        Object.keys(totals.idleByStatus)
          .toSorted()
          .map((status) => [
            status,
            perTicket.filter((t) => (t.primary.idleByStatus[status] ?? 0) > 0).length,
          ]),
      ),
      idleWhileAnotherSessionRanHours: round(hours(totals.idleWhileElsewhereRunning), 1),
      byMergeMonthUtc: Object.fromEntries(
        groupBy(perTicket, (t) => utcMonth(t.row.finalMergeAt)).map(([k, v]) => [
          k,
          perTicketMeans(v),
        ]),
      ),
      byElapsedBand: Object.fromEntries(
        groupBy(perTicket, (t) => elapsedBand(t.row.elapsedHours)).map(([k, v]) => [
          k,
          {
            ...perTicketMeans(v),
            shareOfCohortHours: round(totalsOf(v).totalMs / totals.totalMs, 4),
          },
        ]),
      ),
      silenceSensitivity: sensitivity,
      prSourceSensitivity: {
        ticketsWithPrFromCapture: perTicket.filter((t) => t.captureFirstOpenedAt !== undefined)
          .length,
        ticketsWithPrFromLedger: perTicket.filter((t) => t.ledgerPrFirstOpenedAt !== undefined)
          .length,
        ledger: {
          prOpenIdle: round(hours(ledgerTotals.byCategory.prOpenIdle), 1),
          idle: round(hours(ledgerTotals.byCategory.idle), 1),
        },
        ledgerRecordedMinusCaptureOpenedMinutes:
          lagMinutes.length === 0
            ? undefined
            : {
                n: lagMinutes.length,
                p50: round(quantile(lagMinutes, 0.5), 1),
                p90: round(quantile(lagMinutes, 0.9), 1),
                max: round(lagMinutes[lagMinutes.length - 1], 1),
              },
      },
      inTurnSilences: {
        count: silences.length,
        hours: round(hours(silences.reduce((a, s) => a + (s.end - s.start), 0)), 1),
        byWhatEndedIt: silenceEnds,
        endedByFailureOfClass: silenceFailures,
        // Silence hours by the tool the same Session had in flight, over the
        // tickets whose Sessions left Pi session files; the rest had none.
        ticketsWithToolRecord: withToolRecord.length,
        hoursByToolInFlight: Object.fromEntries(
          Object.entries(roundHours(silenceByTool)).filter(([, h]) => h >= 0.01),
        ),
        hoursWithNoToolInFlight: round(hours(silenceNoTool), 1),
        resumedOnTheirOwn: silences.filter(resumedOnOwn).length,
        watchdogTripped: tripped.length,
        watchdogTrippedThenResumedOnTheirOwn: tripped.filter(resumedOnOwn).length,
      },
      unterminatedTurnsInCohortSessions: perTicket.reduce((a, t) => a + t.unterminatedTurns, 0),
      prOpenToFinalMerge: summarise(describe(prOpenToMerge, { bootstrap: false })),
      doingToFinalMerge: {
        ...summarise(describe(doingHours, { bootstrap: false })),
        excluded: doing,
        primaryClockSameTickets: summarise(describe(primarySameTickets, { bootstrap: false })),
        doingAtOrBeforeFirstMessage: doingLeadHours.length,
        medianHoursDoingPrecededFirstMessage: medianOf(doingLeadHours),
        doingAfterFirstMessage: doingLagHours.length,
        medianHoursFirstMessagePrecededDoing: medianOf(doingLagHours),
      },
      toolCalls: tools,
    },
    perTicket: new Map(
      perTicket.map((t) => [
        t.row.ticket,
        {
          ...Object.fromEntries(
            BREAKDOWN_CATEGORIES.map((c) => [c, hours(t.primary.byCategory[c])]),
          ),
          doingToMergeHours:
            t.firstDoingAt !== undefined && t.firstDoingAt < t.row.finalMergeAt
              ? hours(t.row.finalMergeAt - t.firstDoingAt)
              : undefined,
        },
      ]),
    ),
  };
}

function roundDurations(summary) {
  return Object.fromEntries(
    Object.entries(summary).map(([k, v]) => [
      k,
      {
        calls: v.calls,
        hours: round(v.hours, 2),
        p50Seconds: round(v.p50Seconds, 1),
        p90Seconds: round(v.p90Seconds, 1),
        p99Seconds: round(v.p99Seconds, 1),
        callsOverFiveMinutes: v.callsOverFiveMinutes,
        hoursOverFiveMinutes: round(v.hoursOverFiveMinutes, 2),
      },
    ]),
  );
}

/* ----------------------------------------------------------------- self-test */

const t = (iso) => Date.parse(iso);
const ev = (iso, kind, extra = {}) => ({ at: t(iso), kind, ...extra });

export function selfTestFailureClassification() {
  const cases = [
    ["adapter_unrecoverable", "Request timed out.", "transientNetwork"],
    ["adapter_unrecoverable", "Connection error.", "transientNetwork"],
    ["adapter_unrecoverable", "terminated (after 2 retries)", "transientNetwork"],
    ["adapter_unrecoverable", "502 <html>Bad Gateway</html>", "transientNetwork"],
    ["adapter_unrecoverable", "Stream ended without finish_reason", "transientNetwork"],
    // A 429 that SAYS overloaded is load, not quota: the overload rule runs first.
    ["adapter_unrecoverable", '429: {"message":"temporarily overloaded"}', "transientNetwork"],
    ["adapter_unrecoverable", "429 rate_limit_error", "quotaOrRateLimit"],
    ["adapter_unrecoverable", "Codex error: The usage limit has been reached", "quotaOrRateLimit"],
    ["adapter_unrecoverable", "400 You're out of extra usage.", "quotaOrRateLimit"],
    ["adapter_unrecoverable", "400 ... image dimensions exceed max allowed size", "volliRequest"],
    ["adapter_unrecoverable", '413 {"type":"request_too_large"}', "volliRequest"],
    ["adapter_unrecoverable", "Request is missing x-opencode-session", "volliRequest"],
    ["adapter_unrecoverable", "400 Claude Code 2.1.0 does not support this model", "volliRequest"],
    ["adapter_unrecoverable", "Recovery failed: The Browser host is not ready", "volliHost"],
    ["adapter_unrecoverable", "Output blocked by content filtering policy", "policyRefusal"],
    ["adapter_unrecoverable", "something nobody anticipated", "other"],
    ["partial_turn_interrupted", "Request timed out.", "appRestart"],
    ["auth_required", "429 rate limit", "auth"],
    ["configuration_invalid", "Couldn't prepare the worktree", "worktreeOrConfig"],
    ["rate_limited", null, "quotaOrRateLimit"],
  ];
  for (const [kind, detail, expected] of cases) {
    assert.equal(classifyFailure(kind, detail), expected, `${kind} / ${detail}`);
  }
  for (const k of FAILURE_CLASSES) assert.ok(FAILURE_ORIGIN[k], `${k} has an origin`);
  assert.equal(FAILURE_ATTENTION_KINDS.has("input_required"), false, "asking is not failing");
}

export function selfTestSessionTimeline() {
  const silenceMs = 5 * MINUTE_MS;
  const events = [
    ev("2026-09-01T10:00:00Z", "session.input.recorded"),
    ev("2026-09-01T10:00:01Z", "turn.started", { turnId: "a" }),
    ev("2026-09-01T10:02:00Z", "transcript.referenced"),
    // 10 silent minutes; the watchdog trips inside and its signal does NOT end
    // the silence, nor does a receipt.
    ev("2026-09-01T10:10:00Z", "session.signaled", { watchdog: true }),
    ev("2026-09-01T10:11:00Z", "command.receipt.recorded"),
    ev("2026-09-01T10:12:00Z", "transcript.referenced"),
    // A question: 30 minutes pending is asking, never silence.
    ev("2026-09-01T10:13:00Z", "interaction.opened", { interactionId: "q" }),
    ev("2026-09-01T10:43:00Z", "interaction.resolved", { interactionId: "q" }),
    ev("2026-09-01T10:44:00Z", "attention.raised", {
      attentionId: "f1",
      failureClass: "transientNetwork",
    }),
    ev("2026-09-01T10:44:00Z", "turn.interrupted", { turnId: "a" }),
    // A second failure while blocked is the same block, first class kept.
    ev("2026-09-01T10:50:00Z", "attention.raised", {
      attentionId: "f2",
      failureClass: "quotaOrRateLimit",
    }),
    ev("2026-09-01T11:44:00Z", "session.input.recorded"),
    ev("2026-09-01T11:44:01Z", "turn.started", { turnId: "b" }),
    // An out-of-order clock is clamped to sequence order, not read backwards.
    ev("2026-09-01T11:43:00Z", "command.receipt.recorded"),
    ev("2026-09-01T11:46:00Z", "turn.completed", { turnId: "b" }),
    // A turn with no end record closes at the last executor write.
    ev("2026-09-01T12:00:00Z", "turn.started", { turnId: "c" }),
    ev("2026-09-01T12:03:00Z", "transcript.referenced"),
    ev("2026-09-01T13:00:00Z", "command.recorded"),
  ];
  const tl = sessionTimeline(events, { silenceMs });
  assert.deepEqual(
    tl.turns.map((i) => [i.start, i.end]),
    [
      [t("2026-09-01T10:00:01Z"), t("2026-09-01T10:44:00Z")],
      [t("2026-09-01T11:44:01Z"), t("2026-09-01T11:46:00Z")],
      [t("2026-09-01T12:00:00Z"), t("2026-09-01T12:03:00Z")],
    ],
  );
  assert.equal(tl.unterminatedTurns, 1);
  assert.deepEqual(
    tl.silences.map((s) => [s.start, s.end, s.endedBy, s.watchdogTripped]),
    [[t("2026-09-01T10:02:00Z"), t("2026-09-01T10:12:00Z"), "resumed", true]],
    "the whole ≥threshold gap is one silence; the watchdog and a receipt do not end it",
  );
  assert.deepEqual(
    tl.asking.map((i) => [i.start, i.end]),
    [[t("2026-09-01T10:13:00Z"), t("2026-09-01T10:43:00Z")]],
  );
  assert.deepEqual(
    tl.failures.map((f) => [f.start, f.end, f.failureClass, f.endedBy]),
    [[t("2026-09-01T10:44:00Z"), t("2026-09-01T11:44:00Z"), "transientNetwork", "input"]],
  );

  // Threshold is a parameter: at 15 minutes the same gap is not a silence.
  assert.equal(sessionTimeline(events, { silenceMs: 15 * MINUTE_MS }).silences.length, 0);

  // A turn that survives its failure closes the block at completion.
  const survived = sessionTimeline(
    [
      ev("2026-09-02T10:00:00Z", "turn.started", { turnId: "x" }),
      ev("2026-09-02T10:01:00Z", "attention.raised", { attentionId: "f", failureClass: "other" }),
      ev("2026-09-02T10:02:00Z", "turn.completed", { turnId: "x" }),
    ],
    { silenceMs },
  );
  assert.equal(survived.failures[0].endedBy, "turnCompleted");
  // A silence ended by a failure says so.
  const failed = sessionTimeline(
    [
      ev("2026-09-02T10:00:00Z", "turn.started", { turnId: "x" }),
      ev("2026-09-02T10:20:00Z", "attention.raised", { attentionId: "f", failureClass: "other" }),
    ],
    { silenceMs },
  );
  assert.equal(failed.silences[0].endedBy, "failure");
  assert.equal(failed.failures[0].end, undefined, "an unclosed block is left for the ticket");
}

export function selfTestDecomposition() {
  const W0 = t("2026-09-01T10:00:00Z");
  const W1 = t("2026-09-01T20:00:00Z");
  const H = HOUR_MS;
  // Session A: works 10–12 with a 30-minute silence at 10:30, asks 12–12:30
  // inside a turn that ends 13:00, then fails at 13:00. Session B (a sibling)
  // works 13:30–14:00 — its input at 13:30 unblocks the ticket — and fails at
  // 15:00, never closed. A PR is open from 16:00; the ticket moves to
  // needs_review at 17:00. Another ticket's turn runs 18:00–19:00.
  const a = {
    turns: [{ start: W0, end: W0 + 3 * H }],
    silences: [{ start: W0 + 0.5 * H, end: W0 + H, endedBy: "resumed" }],
    asking: [{ start: W0 + 2 * H, end: W0 + 2.5 * H }],
    failures: [{ start: W0 + 3 * H, end: undefined, failureClass: "quotaOrRateLimit" }],
    inputs: [W0],
  };
  const b = {
    turns: [{ start: W0 + 3.5 * H, end: W0 + 4 * H }],
    silences: [],
    asking: [],
    failures: [
      // Overlaps A's block if A's were not closed by B's input: proves no
      // double counting when two Sessions fail at once.
      { start: W0 + 3.25 * H, end: W0 + 3.5 * H, failureClass: "transientNetwork" },
      { start: W0 + 5 * H, end: undefined, failureClass: "transientNetwork" },
    ],
    inputs: [W0 + 3.5 * H],
  };
  const d = decomposeTicket({
    windowStart: W0,
    windowEnd: W1,
    timelines: [a, b],
    prIntervals: [{ start: W0 + 6 * H, end: Infinity }],
    statusAt: [
      { at: -Infinity, status: "doing" },
      { at: W0 + 7 * H, status: "needs_review" },
    ],
    elsewhereBusy: [{ start: W0 + 8 * H, end: W0 + 9 * H }],
  });
  const inHours = Object.fromEntries(Object.entries(d.byCategory).map(([k, v]) => [k, v / H]));
  assert.deepEqual(inHours, {
    // A: 10:00–10:30, 11:00–12:00, 12:30–13:00; B: 13:30–14:00.
    working: 2.5,
    silentInTurn: 0.5,
    askingUser: 0.5,
    // A: 13:00–13:30 (quota), closed by B's input; B: 15:00→ window end, but a
    // PR opened at 16:00 — failure outranks PR-open, so 15:00–20:00 is failure.
    failureBlocked: 5.5,
    prOpenIdle: 0,
    idle: 1,
  });
  assert.equal(
    Object.values(d.byCategory).reduce((x, y) => x + y, 0),
    d.totalMs,
    "the categories partition the window exactly",
  );
  assert.deepEqual(
    Object.fromEntries(Object.entries(d.failureByClass).map(([k, v]) => [k, v / H])),
    { quotaOrRateLimit: 0.5, transientNetwork: 5 },
    "overlapping blocks go to the one raised first; per-class sums to failureBlocked",
  );
  assert.equal(
    Object.values(d.failureByClass).reduce((x, y) => x + y, 0),
    d.byCategory.failureBlocked,
  );
  assert.deepEqual(
    Object.fromEntries(Object.entries(d.failureByEnd).map(([k, v]) => [k, v / H])),
    { input: 0.5, windowEnd: 5 },
    "a sibling's input closes a block; a block nothing closes runs to the merge",
  );
  // Idle is 14:00–15:00 (doing) and nothing else; none of it overlaps 18–19.
  assert.deepEqual(Object.fromEntries(Object.entries(d.idleByStatus).map(([k, v]) => [k, v / H])), {
    doing: 1,
  });
  assert.equal(d.idleWhileElsewhereRunning, 0);

  // Without the second failure, the PR stretch and the status split show.
  const quiet = decomposeTicket({
    windowStart: W0,
    windowEnd: W1,
    timelines: [a, { ...b, failures: [] }],
    prIntervals: [{ start: W0 + 6 * H, end: Infinity }],
    statusAt: [
      { at: -Infinity, status: "doing" },
      { at: W0 + 5 * H, status: "needs_review" },
    ],
    elsewhereBusy: [{ start: W0 + 4.5 * H, end: W0 + 5.5 * H }],
  });
  assert.equal(quiet.byCategory.prOpenIdle / H, 4);
  assert.deepEqual(
    Object.fromEntries(Object.entries(quiet.idleByStatus).map(([k, v]) => [k, v / H])),
    { doing: 1, needs_review: 1 },
    "idle is split at the status change",
  );
  assert.equal(quiet.idleWhileElsewhereRunning / H, 1);
}

export function selfTestTicketHistory() {
  const history = [
    { at: t("2026-09-01T10:00:00Z"), kind: "status_changed", from: "backlog", to: "todo" },
    { at: t("2026-09-01T12:00:00Z"), kind: "status_changed", from: "todo", to: "doing" },
    { at: t("2026-09-01T14:00:00Z"), kind: "status_changed", from: "doing", to: "todo" },
    { at: t("2026-09-01T15:00:00Z"), kind: "status_changed", from: "todo", to: "doing" },
  ];
  assert.equal(firstMoveToDoing(history), t("2026-09-01T12:00:00Z"), "the FIRST move to Doing");
  const timeline = statusTimeline(history);
  assert.equal(timeline[0].status, "backlog", "no created event: start in the first `from`");
  assert.equal(timeline.length, 5);
  assert.equal(
    firstMoveToDoing([{ at: 5, kind: "created", status: "doing" }]),
    5,
    "a ticket created in Doing is in Doing from creation",
  );
  assert.equal(firstMoveToDoing([{ at: 5, kind: "created", status: "backlog" }]), undefined);

  const capture = prIntervalsFromCapture({
    ticket: "VC-7",
    prNumbers: [12, undefined],
    prs: [
      { number: 10, headRefName: "volli/VC-7-first", createdAt: 100, mergedAt: 200 },
      { number: 12, headRefName: "wave/unrelated", createdAt: 300, mergedAt: 400 },
      { number: 13, headRefName: "volli/VC-70-other", createdAt: 50, mergedAt: 60 },
    ],
  });
  assert.equal(capture.prCount, 2, "by branch or by linked number, never by prefix");
  assert.equal(capture.firstOpenedAt, 100);
  const ledger = prIntervalsFromLedger([
    { at: 150, kind: "pr_opened", pr: 10 },
    { at: 210, kind: "pr_merged", pr: 10 },
    { at: 350, kind: "pr_opened", pr: 12 },
  ]);
  assert.deepEqual(ledger.intervals, [
    { start: 150, end: 210 },
    { start: 350, end: Infinity },
  ]);
}

/* Pi-file fixture builders. */
const piCall = (id, command) => ({ type: "toolCall", id, name: "bash", arguments: { command } });
const piAssistant = (at, calls) => ({
  kind: "entry",
  type: "message",
  timestamp: at,
  message: { role: "assistant", content: [{ type: "text", text: "prose" }, ...calls] },
});
const piResult = (at, id) => ({
  kind: "entry",
  type: "message",
  timestamp: at,
  message: { role: "toolResult", toolCallId: id, content: [{ type: "text", text: "out" }] },
});

export function selfTestPiFormats() {
  const first = [
    { kind: "header", version: 4, metadata: { volliSessionId: "s-old" } },
    piAssistant(1_000, [piCall("a", "rg x")]),
    piResult(3_000, "a"),
  ]
    .map((r) => JSON.stringify(r))
    .join("\n");
  const second = [
    JSON.stringify({ v: 4, kind: "header", id: "p", storageVersion: 1 }),
    JSON.stringify({
      kind: "kv",
      op: "set",
      namespace: "volli.identity.v1",
      value: { volliSessionId: "s-new" },
    }),
    JSON.stringify([piAssistant(1_000, [piCall("b", "sleep 5")]), { kind: "kv", op: "set" }]),
    JSON.stringify([piResult(9_000, "b")]),
  ].join("\n");
  assert.equal(piSessionId(first), "s-old");
  assert.equal(piSessionId(second), "s-new", "the September format keeps the id in a record");
  assert.deepEqual(
    toolCallDurations(piToolEntries(second)).calls.map((c) => [c.name, c.command, c.ms]),
    [["bash", "sleep 5", 8_000]],
    "entries batched in arrays are read, not skipped",
  );
  assert.equal(toolCallDurations(piToolEntries(first)).calls[0].ms, 2_000);
}

export function selfTestToolCalls() {
  const { calls, unanswered } = toolCallDurations([
    {
      at: 1_000,
      role: "assistant",
      calls: [
        { id: "a", name: "bash", command: "sleep 30" },
        { id: "b", name: "read" },
      ],
    },
    { at: 31_000, role: "toolResult", toolCallId: "a" },
    { at: 32_000, role: "toolResult", toolCallId: "b" },
    { at: 40_000, role: "assistant", calls: [{ id: "c", name: "bash", command: "ls" }] },
  ]);
  assert.deepEqual(
    calls.map((c) => [c.name, c.ms]),
    [
      ["bash", 30_000],
      ["read", 1_000],
    ],
    "sequential execution: the second call is timed from the first one's return",
  );
  assert.equal(unanswered, 1);

  const cases = [
    ["gh pr checks 12 --watch --interval 30", "ciWatch"],
    ["cd /x && gh run watch 99", "ciWatch"],
    ["for i in 1 2; do sleep 20; done", "sleepPoll"],
    ["node apps/desktop/scripts/run-smokes.mjs --tier boot", "e2eSmoke"],
    ["vp run -r test:coverage", "coverage"],
    ["cd /repo && pnpm -C packages/shared test", "unitTests"],
    ["pnpm typecheck", "typecheck"],
    ["vp check", "lintFormat"],
    ["pnpm run build", "build"],
    ["pnpm install", "install"],
    ["rg -n foo src", "search"],
    ["cd /repo; grep -rn foo .", "search"],
    ["find . -name '*.ts'", "find"],
    ["git fetch origin", "gitNetwork"],
    ["git status", "gitLocal"],
    ["gh pr view 12", "ghOther"],
    ["sed -n 1,20p file", "fileRead"],
    ["FOO=1 node script.mjs", "nodeOther"],
    ["python3 x.py", "other"],
    [undefined, "other"],
  ];
  for (const [command, expected] of cases) {
    assert.equal(toolCallCategory("bash", command), `bash:${expected}`, String(command));
  }
  assert.equal(toolCallCategory("ask_user"), "ask_user");
  assert.equal(toolCallCategory("mcp__server__do_thing__abc"), "mcpTool");
  assert.equal(
    toolCallCategory("SomethingElse"),
    "otherTool",
    "an unknown name is never published",
  );

  // A 30-minute silence: a CI watch covers 10 minutes of it, a sleep loop that
  // started before it covers its first 5, and nothing covers the rest.
  const M = MINUTE_MS;
  const split = attributeSilences(
    [{ start: 10 * M, end: 40 * M }],
    [
      { start: 20 * M, end: 30 * M, category: "bash:ciWatch" },
      { start: 0, end: 15 * M, category: "bash:sleepPoll" },
      { start: 50 * M, end: 60 * M, category: "read" },
    ],
  );
  assert.deepEqual(split.byTool, { "bash:sleepPoll": 5 * M, "bash:ciWatch": 10 * M });
  assert.equal(split.noTool, 15 * M, "tool time plus no-tool time is the silence, exactly");

  const summary = summariseDurations(
    [1_000, 2_000, 10 * MINUTE_MS].map((ms) => ({ ms, category: "k" })),
    (c) => c.category,
  );
  assert.equal(summary.k.calls, 3);
  assert.equal(summary.k.callsOverFiveMinutes, 1);
  assert.equal(summary.k.p50Seconds, 2);
}

/**
 * The breakdown end to end on a fixture cohort, then the privacy rule on what
 * it would publish: no command, no message, no path, no epoch clock, no time
 * of day. `prCapture.capturedAt` is the one timestamp allowed — it is when the
 * analysis ran `gh`, like `snapshot.takenAt`, not when anyone worked.
 */
export function selfTestBreakdownPrivacy() {
  const secretCommand = "rg SECRET-NEEDLE /Users/someone/private/path";
  const W0 = t("2026-09-01T10:17:00Z");
  const row = {
    ticket: "VC-1",
    pr: 10,
    ledgerPr: 10,
    startAt: W0,
    finalMergeAt: W0 + 5 * HOUR_MS,
    elapsedHours: 5,
    sessionIds: ["s1"],
  };
  const eventsBySession = new Map([
    [
      "s1",
      [
        ev("2026-09-01T10:17:00Z", "session.input.recorded"),
        ev("2026-09-01T10:17:01Z", "turn.started", { turnId: "a" }),
        // Executor writes every four minutes: under the threshold, so working.
        ...Array.from({ length: 14 }, (_, i) => ({
          at: t("2026-09-01T10:17:01Z") + (i + 1) * 4 * MINUTE_MS,
          kind: "transcript.referenced",
        })),
        ev("2026-09-01T11:17:00Z", "turn.completed", { turnId: "a" }),
      ],
    ],
  ]);
  const ticketEvents = new Map([
    [
      "VC-1",
      {
        status: [{ at: W0 - 1, kind: "status_changed", from: "todo", to: "doing" }],
        pr: [{ at: W0 + 2 * HOUR_MS, kind: "pr_opened", pr: 10 }],
      },
    ],
  ]);
  const toolCalls = {
    available: true,
    files: 1,
    unanswered: 0,
    calls: [{ category: toolCallCategory("bash", secretCommand), ms: 5_000, month: "2026-09" }],
  };
  const { aggregate, perTicket } = buildBreakdown({
    rows: [row],
    eventsBySession,
    ticketEvents,
    prCapture: [
      {
        number: 10,
        headRefName: "volli/VC-1-x",
        createdAt: W0 + 1.5 * HOUR_MS,
        mergedAt: W0 + 5 * HOUR_MS,
      },
    ],
    prCaptureMeta: { command: PR_CAPTURE_COMMAND, capturedAt: "2026-09-28T20:00:00Z", prs: 1 },
    silenceMinutes: 5,
    toolCalls,
  });
  assert.equal(aggregate.byCategory.working.hours, 1);
  assert.equal(aggregate.byCategory.prOpenIdle.hours, 3.5);
  assert.equal(aggregate.byCategory.idle.hours, 0.5);
  assert.equal(aggregate.prSourceSensitivity.ledger.prOpenIdle, 3);
  assert.equal(aggregate.prSourceSensitivity.ledgerRecordedMinusCaptureOpenedMinutes.p50, 30);
  assert.equal(aggregate.doingToFinalMerge.n, 1);
  assert.equal(aggregate.toolCalls.byCategory["bash:search"].calls, 1);
  assert.ok(Math.abs(perTicket.get("VC-1").working - 1) < 0.001);

  const { prCapture, ...definitions } = aggregate.definitions;
  assert.equal(prCapture.command, PR_CAPTURE_COMMAND);
  const published = JSON.stringify({ ...aggregate, definitions });
  assert.equal(/SECRET-NEEDLE|\/Users\/|private\/path/.test(published), false, "no command text");
  assert.equal(/\d{2}:\d{2}/.test(published), false, "no time of day");
  assert.equal(/\b1\d{12}\b/.test(published), false, "no epoch-millisecond clock");
}

export function selfTestBreakdown() {
  selfTestFailureClassification();
  selfTestSessionTimeline();
  selfTestDecomposition();
  selfTestTicketHistory();
  selfTestPiFormats();
  selfTestToolCalls();
  selfTestBreakdownPrivacy();
}
