#!/usr/bin/env node
/**
 * Measures, for tickets that are actually MERGED, the calendar time from the
 * first message of their earliest associated Session to the final merge that
 * completed them (VC-443), and writes the aggregates the report quotes.
 *
 *     node scripts/merged-ticket-time-to-merge.mjs --print        # read, summarise
 *     node scripts/merged-ticket-time-to-merge.mjs --write        # + refresh the data files
 *     node scripts/merged-ticket-time-to-merge.mjs --self-test    # the rules' own tests
 *
 * The same run also produces the breakdown of where each ticket's time went
 * (`merged-ticket-time-breakdown.mjs`). Its PR-open times come from a `gh pr
 * list` capture passed as `--prs <file>` (see `PR_CAPTURE_COMMAND`); without
 * one they fall back to the ledger's own `pr_opened` events, and the artifact
 * records which. `--silence-minutes` sets the in-turn silence threshold,
 * `--pi-sessions` the Pi session directory the tool durations are read from,
 * `--no-breakdown` skips all of it.
 *
 * READ-ONLY, BY CONSTRUCTION. The ledger is opened with better-sqlite3's
 * `readonly` flag on the live database — never a copy, never a write, no
 * migration, no settings touched, no Session disturbed — and git is used only
 * through `log`/`rev-list`. `--write` writes nothing but this repository's own
 * `docs/research/perf/` artifacts. The one measurement it will never take is a
 * live workload: no inference is launched, so nothing here costs a token.
 *
 * WHY THE TWO SOURCES ARE BOTH NEEDED. The ledger knows when a Session first
 * received a message; it does not know when anything merged (a `done` column and
 * a `pr_url` are both set by hand and neither proves a merge landed). Git knows
 * when main gained each piece of work and nothing about Sessions. So the start
 * comes from the ledger, the end comes from the repository's own first-parent
 * history, and the join between them is checked twice: once through the merged
 * branch name, once through the PR number the ledger recorded. See
 * `merged-ticket-time-to-merge-logic.mjs` for those rules.
 *
 * WHAT IT DELIBERATELY DOES NOT READ. No message text, no prompt, no title
 * from any Session. The only ledger columns it touches are identifiers, roles,
 * parent links, statuses, PR urls and timestamps — and the only thing it takes
 * from an input event is its clock. Two things are read in memory only, to be
 * classified and dropped before anything is kept: a failure Attention's detail
 * text (provider error prose, reduced to a failure class) and a Pi tool call's
 * bash command (reduced to a coarse category). Neither, nor any path or time of
 * day, reaches a published file; the self-test checks that.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  attributeSessions,
  buildCohort,
  describe,
  ecdf,
  histogram,
  recogniseMerges,
  sessionCountBand,
  stratify,
  STRONG,
  SUBJECT,
  ticketFromBranch,
  ticketsInText,
  utcMonth,
  DEFAULT_SILENCE_MINUTES,
  BREAKDOWN_CATEGORIES,
} from "./merged-ticket-time-to-merge-logic.mjs";
import {
  buildBreakdown,
  PR_CAPTURE_COMMAND,
  readPrCapture,
  readSessionEvents,
  readTicketEvents,
  readToolCalls,
  selfTestBreakdown,
} from "./merged-ticket-time-breakdown.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(REPO_ROOT, "docs/research/perf/merged-ticket-time-to-merge");

/**
 * Electron's `userData` for the packaged app. Named from `homedir()` rather
 * than written out, so neither this file nor the report it feeds carries one
 * machine's home directory.
 */
const DEFAULT_DB = join(homedir(), "Library/Application Support/Volli Code/volli.db");

/** Where the Pi runtime keeps its session files, beside the ledger. */
const DEFAULT_PI_SESSIONS = join(homedir(), "Library/Application Support/Volli Code/pi-sessions");

/**
 * WHICH INTEGRATION HISTORY TO READ. A ticket worktree's local `main` is
 * whatever it branched from and goes stale the moment other tickets merge — this
 * one was 71 commits behind while the analysis ran. Reading it would silently
 * truncate the cohort at the branch point and drop the most recent merges, which
 * for a time-to-merge measurement is a survivorship bias introduced by the tool
 * rather than by the data. `origin/main` is the current integration history as
 * this checkout last saw it, so that is the default; `--ref` overrides it, and
 * the resolved ref and its commit are recorded in the artifact either way.
 *
 * It is read, never fetched: nothing here touches the network or moves a ref.
 */
const DEFAULT_REF = "origin/main";

/** ASCII record separator: cannot occur in a commit subject. */
const SEP = "\u001e";

function parseArgs(argv) {
  const flag = (name, fallback) => {
    const at = argv.indexOf(`--${name}`);
    return at === -1 ? fallback : argv[at + 1];
  };
  return {
    db: flag("db", DEFAULT_DB),
    ref: flag("ref", DEFAULT_REF),
    prefix: flag("prefix", "VC"),
    out: flag("out", OUT_DIR),
    prs: flag("prs", undefined),
    prsCapturedAt: flag("prs-captured-at", undefined),
    silenceMinutes: Number(flag("silence-minutes", DEFAULT_SILENCE_MINUTES)),
    piSessions: flag("pi-sessions", DEFAULT_PI_SESSIONS),
    breakdown: !argv.includes("--no-breakdown"),
    write: argv.includes("--write"),
    print: argv.includes("--print") || !argv.includes("--write"),
  };
}

/* ----------------------------------------------------------------------- git */

function git(args) {
  return execFileSync("git", args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
}

/**
 * The integration branch's first-parent walk. `%ct` is the committer date: for
 * a forge merge commit and for a squashed commit alike, that is the moment the
 * integration branch gained the work — the merge event this measurement ends at.
 */
function readFirstParentCommits(ref) {
  const format = ["%H", "%ct", "%P", "%s"].join(SEP);
  const raw = git(["log", "--first-parent", ref, `--format=${format}`]);
  return raw
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const [hash, committedAt, parents, subject] = line.split(SEP);
      return {
        hash,
        committedAt: Number(committedAt) * 1000,
        parents: parents.split(" ").filter(Boolean),
        subject: subject ?? "",
      };
    });
}

/**
 * For a merge whose only ticket link is its subject, ask the merged side
 * whether it agrees: do the commits this merge brought in mention the same
 * ticket? Two independent authors of the same claim is not the same as a branch
 * name, but it is the difference between a corroborated prose link and a bare
 * one, and the report separates them.
 */
function corroborateFromMergedSide(evidence) {
  for (const item of evidence) {
    if (item.strength !== SUBJECT || item.kind !== "merge-subject") continue;
    try {
      const side = git(["log", `${item.hash}^1..${item.hash}^2`, "--format=%s%n%b"]);
      item.sideCorroborated = ticketsInText(side).includes(item.ticket);
    } catch {
      item.sideCorroborated = undefined;
    }
  }
}

/* -------------------------------------------------------------------- ledger */

/**
 * better-sqlite3 in `readonly` mode, resolved from the desktop app's own
 * dependency tree — the same library and version the app writes this database
 * with, so the file is never opened by a second implementation of SQLite.
 */
async function openLedger(path) {
  const { createRequire } = await import("node:module");
  const require = createRequire(join(REPO_ROOT, "apps/desktop/package.json"));
  const Database = require("better-sqlite3");
  return new Database(path, { readonly: true, fileMustExist: true });
}

function readLedger(db, prefix) {
  const project = db
    .prepare("SELECT id, ticket_prefix FROM projects WHERE ticket_prefix = ?")
    .get(prefix);
  if (project === undefined) throw new Error(`no project with ticket prefix ${prefix}`);

  const tickets = db
    .prepare(
      `SELECT ticket_number AS number, status, pr_url AS prUrl, branch
         FROM tickets WHERE project_id = ? ORDER BY ticket_number`,
    )
    .all(project.id)
    .map((row) => {
      const prMatch = row.prUrl ? /\/pull\/(\d+)/.exec(row.prUrl) : undefined;
      return {
        displayId: `${prefix}-${row.number}`,
        status: row.status,
        prNumber: prMatch ? Number(prMatch[1]) : undefined,
        branch: row.branch ?? undefined,
      };
    });

  // Every Session of the project, including delegated children that name no
  // ticket: `attributeSessions` needs the parent links to place those.
  const sessions = db
    .prepare(
      `SELECT s.id AS id, s.ticket_id AS ticketRowId, s.role AS role,
              s.parent_session_id AS parentSessionId, s.created_at AS createdAt,
              t.ticket_number AS ticketNumber
         FROM sessions s
         LEFT JOIN tickets t ON t.id = s.ticket_id
        WHERE s.project_id = ?`,
    )
    .all(project.id)
    .map((row) => ({
      id: row.id,
      ticketId: row.ticketNumber === null ? undefined : `${prefix}-${row.ticketNumber}`,
      role: row.role,
      parentSessionId: row.parentSessionId ?? undefined,
      createdAt: row.createdAt,
    }));

  // The first user message of each Session. `session.input.recorded` is the
  // ledger's own event for "a message was submitted to this Session"
  // (packages/shared/src/session-ledger.ts); only its clock is read, never its
  // payload. `occurred_at` is when it happened, and it is within 1ms of
  // `recorded_at` across this snapshot, so the two cannot disagree materially.
  const firstInput = new Map();
  const rows = db
    .prepare(
      `SELECT e.session_id AS sessionId, MIN(e.occurred_at) AS firstAt
         FROM session_events e
         JOIN sessions s ON s.id = e.session_id
        WHERE s.project_id = ?
          AND json_extract(e.payload, '$.kind') = 'session.input.recorded'
        GROUP BY e.session_id`,
    )
    .all(project.id);
  for (const row of rows) firstInput.set(row.sessionId, row.firstAt);

  const clockSkew = db
    .prepare(
      `SELECT MAX(ABS(occurred_at - recorded_at)) AS maxSkew, COUNT(*) AS n
         FROM session_events
        WHERE json_extract(payload, '$.kind') = 'session.input.recorded'`,
    )
    .get();

  return { project, tickets, sessions, firstInput, clockSkew };
}

/* ------------------------------------------------------------------ analysis */

function analyse({
  commits,
  tickets,
  sessions,
  firstInput,
  ref,
  headHash,
  checkoutHash,
  clockSkew,
}) {
  const prTicketFromLedger = new Map();
  const prCollisions = [];
  for (const ticket of tickets) {
    if (ticket.prNumber === undefined) continue;
    const seen = prTicketFromLedger.get(ticket.prNumber);
    if (seen !== undefined)
      prCollisions.push({ pr: ticket.prNumber, tickets: [seen, ticket.displayId] });
    else prTicketFromLedger.set(ticket.prNumber, ticket.displayId);
  }

  const recognised = recogniseMerges(commits, { prTicketFromLedger });
  corroborateFromMergedSide(recognised.evidence);

  // The independent cross-check: where BOTH the merged branch name and the
  // ledger's PR link say something, do they say the same ticket?
  const crossCheck = { agree: 0, disagree: [], branchOnly: 0, slugDrift: 0 };
  const branchByTicket = new Map(tickets.map((t) => [t.displayId, t.branch]));
  for (const item of recognised.evidence) {
    if (item.kind !== "pr-merge-branch") continue;
    const fromLedger = item.pr === undefined ? undefined : prTicketFromLedger.get(item.pr);
    if (fromLedger === undefined) crossCheck.branchOnly += 1;
    else if (fromLedger === item.ticket) crossCheck.agree += 1;
    else crossCheck.disagree.push({ pr: item.pr, fromBranch: item.ticket, fromLedger });
    const ledgerBranch = branchByTicket.get(item.ticket);
    if (
      ledgerBranch &&
      item.branch &&
      !ledgerBranch.startsWith(item.branch) &&
      !item.branch.startsWith(ledgerBranch)
    ) {
      crossCheck.slugDrift += 1;
    }
  }

  const attributed = attributeSessions(sessions, firstInput);
  const primary = buildCohort({
    tickets,
    evidence: recognised.evidence,
    sessionFacts: attributed.perTicket,
    strength: STRONG,
  });
  const extended = buildCohort({
    tickets,
    evidence: recognised.evidence,
    sessionFacts: attributed.perTicket,
    strength: SUBJECT,
  });

  const hours = primary.rows.map((r) => r.elapsedHours);
  const firstMergeHours = primary.rows.map((r) => r.firstMergeElapsedHours);
  const globalMinHours = primary.rows.map((r) => r.globalMinElapsedHours ?? r.elapsedHours);

  const doneWithoutMerge = tickets.filter(
    (t) => t.status === "done" && !primary.rows.some((r) => r.ticket === t.displayId),
  ).length;

  return {
    snapshot: {
      takenAt: new Date().toISOString(),
      gitRef: ref,
      gitHead: headHash,
      /**
       * The worktree the analysis ran from, which is NOT the history it read:
       * the report's own source checkout, recorded so a later reader can tell
       * the two apart.
       */
      analysisCheckout: checkoutHash,
      firstParentCommits: commits.length,
      ledgerInputEventsConsidered: clockSkew?.n,
      ledgerOccurredRecordedMaxSkewMs: clockSkew?.maxSkew,
      earliestMergeInWindow: new Date(Math.min(...primary.rows.map((r) => r.finalMergeAt)))
        .toISOString()
        .slice(0, 10),
      latestMergeInWindow: new Date(Math.max(...primary.rows.map((r) => r.finalMergeAt)))
        .toISOString()
        .slice(0, 10),
    },
    recognition: { ...recognised.counts, unlinkedMergeEvents: recognised.unlinked.length },
    linkAudit: {
      ledgerPrLinks: prTicketFromLedger.size,
      ledgerPrCollisions: prCollisions,
      branchVsLedgerAgree: crossCheck.agree,
      branchVsLedgerDisagree: crossCheck.disagree,
      branchWithoutLedgerPr: crossCheck.branchOnly,
      branchSlugDriftSameTicket: crossCheck.slugDrift,
      subjectOnlyEvidence: recognised.evidence.filter((e) => e.strength === SUBJECT).length,
      subjectOnlyCorroborated: recognised.evidence.filter(
        (e) => e.strength === SUBJECT && e.sideCorroborated === true,
      ).length,
      ambiguousBranchEvidence: recognised.evidence.filter((e) => e.ambiguousBranch).length,
      evidenceForTicketNotInLedger: primary.evidenceForUnknownTicket,
      orphanedDelegatedSessions: attributed.orphanedDelegates,
    },
    coverage: {
      ticketsInProject: tickets.length,
      ticketsMarkedDone: tickets.filter((t) => t.status === "done").length,
      ticketsWithStrongMergeEvidence: primary.ticketsWithMergeEvidence,
      ticketsWithAnyMergeEvidence: extended.ticketsWithMergeEvidence,
      primaryCohort: primary.rows.length,
      extendedCohort: extended.rows.length,
      coverageOfStrongEvidence: primary.rows.length / primary.ticketsWithMergeEvidence,
      doneWithoutPrimaryCohortMembership: doneWithoutMerge,
      exclusions: primary.exclusions,
      excludedTickets: primary.excluded,
    },
    sessionAttribution: {
      cohortSessions: primary.rows.reduce((a, r) => a + r.sessionCount, 0),
      cohortSessionsInheritingTicket: primary.rows.reduce((a, r) => a + r.inheritedSessionCount, 0),
      cohortTicketsWithSilentLeadingSession: primary.rows.filter((r) => r.silentLeadingSessions > 0)
        .length,
      startDefinitionDisagreements: primary.rows.filter((r) => r.startDisagreesWithGlobalMin)
        .length,
      ticketsWithMultipleMerges: primary.rows.filter((r) => r.mergeEventCount > 1).length,
    },
    elapsed: {
      unit: "hours",
      quantileEstimator: "linear interpolation between order statistics (R type 7)",
      primary: describe(hours),
      sensitivityFirstMerge: describe(firstMergeHours, { bootstrap: false }),
      sensitivityEarliestMessageAnySession: describe(globalMinHours, { bootstrap: false }),
      sensitivityExtendedCohort: describe(
        extended.rows.map((r) => r.elapsedHours),
        { bootstrap: false },
      ),
      histogram: histogram(hours),
      ecdf: ecdf(hours),
    },
    strata: {
      byMergeMonthUtc: stratify(primary.rows, (r) => utcMonth(r.finalMergeAt)),
      bySessionCount: stratify(primary.rows, (r) => sessionCountBand(r.sessionCount)),
    },
    rows: primary.rows,
  };
}

/* -------------------------------------------------------------------- output */

/**
 * The per-ticket audit rows. Ticket ids and PR numbers are public references in
 * this repository's own history; the START timestamp is not published and no
 * time of day appears, so a reader can audit any row against the merge commit
 * without the file becoming a log of when someone was at their desk.
 */
const CSV_COLUMNS = [
  "ticket",
  "pr",
  "merge_date_utc",
  "elapsed_hours",
  "first_merge_elapsed_hours",
  "merge_event_count",
  "session_count",
  "messaged_session_count",
  "link_kinds",
  // The breakdown, hours per category (blank when it was not run), and the
  // second clock: first move to Doing → final merge (blank when the ticket was
  // never in Doing before it merged).
  "working_hours",
  "silent_in_turn_hours",
  "asking_user_hours",
  "failure_blocked_hours",
  "pr_open_idle_hours",
  "idle_hours",
  "doing_to_merge_hours",
];

/** A CSV cell for an optional number: three decimals, blank when absent. */
const fixed = (value) => (value === undefined ? "" : value.toFixed(3));

function toCsv(rows) {
  const lines = [CSV_COLUMNS.join(",")];
  for (const row of rows) {
    lines.push(
      [
        row.ticket,
        row.pr ?? "",
        new Date(row.finalMergeAt).toISOString().slice(0, 10),
        row.elapsedHours.toFixed(3),
        row.firstMergeElapsedHours.toFixed(3),
        row.mergeEventCount,
        row.sessionCount,
        row.messagedSessionCount,
        row.linkKinds.join("+"),
        ...BREAKDOWN_CATEGORIES.map((c) => fixed(row.breakdown?.[c])),
        fixed(row.breakdown?.doingToMergeHours),
      ].join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}

/** The JSON artifact: aggregates plus the same privacy-reduced audit rows. */
function toJson(result) {
  const { rows, ...aggregate } = result;
  return `${JSON.stringify(
    {
      ...aggregate,
      tickets: rows.map((row) => ({
        ticket: row.ticket,
        pr: row.pr,
        mergeDateUtc: new Date(row.finalMergeAt).toISOString().slice(0, 10),
        elapsedHours: Number(row.elapsedHours.toFixed(3)),
        firstMergeElapsedHours: Number(row.firstMergeElapsedHours.toFixed(3)),
        mergeEventCount: row.mergeEventCount,
        sessionCount: row.sessionCount,
        messagedSessionCount: row.messagedSessionCount,
        linkKinds: row.linkKinds,
        breakdownHours:
          row.breakdown === undefined
            ? undefined
            : Object.fromEntries(
                BREAKDOWN_CATEGORIES.map((c) => [c, Number(row.breakdown[c].toFixed(3))]),
              ),
        doingToMergeHours:
          row.breakdown?.doingToMergeHours === undefined
            ? undefined
            : Number(row.breakdown.doingToMergeHours.toFixed(3)),
      })),
    },
    null,
    2,
  )}\n`;
}

const h = (v) => (v === undefined ? "n/a" : `${v.toFixed(2)}h`);

function printSummary(result) {
  const { coverage, elapsed, linkAudit, snapshot, sessionAttribution, strata } = result;
  console.log(
    `snapshot ${snapshot.takenAt} · history ${snapshot.gitRef}@${snapshot.gitHead.slice(0, 8)} ` +
      `· run from ${snapshot.analysisCheckout.slice(0, 8)}`,
  );
  console.log(
    `coverage: ${coverage.primaryCohort}/${coverage.ticketsWithStrongMergeEvidence} merged tickets ` +
      `(${(coverage.coverageOfStrongEvidence * 100).toFixed(1)}%) of ${coverage.ticketsInProject} in project`,
  );
  console.log(`exclusions: ${JSON.stringify(coverage.exclusions)}`);
  console.log(
    `links: branch↔ledger agree ${linkAudit.branchVsLedgerAgree}, disagree ${linkAudit.branchVsLedgerDisagree.length}, ` +
      `subject-only ${linkAudit.subjectOnlyEvidence} (corroborated ${linkAudit.subjectOnlyCorroborated})`,
  );
  console.log(
    `start definition: ${sessionAttribution.startDefinitionDisagreements} disagreement(s) with earliest-message-any-Session`,
  );
  const p = elapsed.primary;
  console.log(
    `elapsed: n=${p.n} median ${h(p.median)} p25 ${h(p.p25)} p75 ${h(p.p75)} p90 ${h(p.p90)} ` +
      `p95 ${h(p.p95)} mean ${h(p.mean)} trimmed10 ${h(p.trimmedMean10)} min ${h(p.min)} max ${h(p.max)}`,
  );
  if (p.medianCI95) console.log(`median 95% CI: ${h(p.medianCI95.lower)}–${h(p.medianCI95.upper)}`);
  console.log(`first-merge sensitivity median: ${h(elapsed.sensitivityFirstMerge.median)}`);
  for (const bin of elapsed.histogram) {
    const label = bin.to === undefined ? `>=${bin.from}h` : `${bin.from}-${bin.to}h`;
    console.log(`  ${label.padEnd(10)} ${String(bin.count).padStart(3)}  ${"#".repeat(bin.count)}`);
  }
  for (const [name, stratum] of Object.entries(strata)) {
    console.log(
      `${name}: ${stratum.reported.length} reported, ${stratum.suppressed.length} suppressed (<${stratum.minimum})`,
    );
  }
  const b = result.breakdown;
  if (b === undefined) return;
  console.log(
    `breakdown: ${b.cohortTickets} tickets, ${b.cohortHours}h, silence ≥${b.definitions.silenceMinutes}m, PR open from ${b.definitions.prOpenSource}`,
  );
  for (const [category, v] of Object.entries(b.byCategory)) {
    console.log(
      `  ${category.padEnd(15)} ${String(v.hours).padStart(8)}h ${(v.share * 100).toFixed(1).padStart(5)}%`,
    );
  }
  console.log(`  failure-blocked by class: ${JSON.stringify(b.failureBlockedByClass)}`);
  console.log(`  idle by status: ${JSON.stringify(b.idleByTicketStatus)}`);
  console.log(`  idle while another Session ran: ${b.idleWhileAnotherSessionRanHours}h`);
  console.log(`  silences: ${JSON.stringify(b.inTurnSilences)}`);
  console.log(`  doing→merge median ${h(b.doingToFinalMerge.median)} n=${b.doingToFinalMerge.n}`);
  console.log(
    `  tool calls: ${b.toolCalls.available ? `${b.toolCalls.calls} in ${b.toolCalls.files} files` : "not read"}`,
  );
}

/**
 * Run the breakdown over the cohort `analyse` built and attach it: the
 * aggregate under `result.breakdown`, the per-ticket hours on each row.
 */
function attachBreakdown(result, db, ledger, options) {
  if (!(options.silenceMinutes > 0)) {
    throw new Error(`--silence-minutes must be a positive number of minutes`);
  }
  let prCapture;
  let prCaptureMeta;
  if (options.prs !== undefined) {
    prCapture = readPrCapture(options.prs);
    prCaptureMeta = {
      command: PR_CAPTURE_COMMAND,
      // When `gh` was run, like `snapshot.takenAt`: the analysis's clock, not
      // anyone's working hours. Falls back to the file's own mtime.
      capturedAt: options.prsCapturedAt ?? statSync(options.prs).mtime.toISOString(),
      mergedPrsInCapture: prCapture.length,
    };
  }
  const windowBySession = new Map();
  for (const row of result.rows) {
    for (const id of row.sessionIds) {
      windowBySession.set(id, {
        start: row.startAt,
        end: row.finalMergeAt,
        mergeMonth: utcMonth(row.finalMergeAt),
      });
    }
  }
  const { aggregate, perTicket } = buildBreakdown({
    rows: result.rows,
    eventsBySession: readSessionEvents(db),
    ticketEvents: readTicketEvents(db, ledger.project.id, options.prefix),
    prCapture,
    prCaptureMeta,
    silenceMinutes: options.silenceMinutes,
    toolCalls: readToolCalls(options.piSessions, windowBySession),
  });
  result.breakdown = aggregate;
  for (const row of result.rows) row.breakdown = perTicket.get(row.ticket);
}

async function main(options) {
  const commits = readFirstParentCommits(options.ref);
  const headHash = git(["rev-parse", options.ref]).trim();
  const checkoutHash = git(["rev-parse", "HEAD"]).trim();
  const db = await openLedger(options.db);
  try {
    const ledger = readLedger(db, options.prefix);
    const result = analyse({
      commits,
      ...ledger,
      ref: options.ref,
      headHash,
      checkoutHash,
      clockSkew: ledger.clockSkew,
    });
    if (options.breakdown) attachBreakdown(result, db, ledger, options);
    if (options.write) {
      mkdirSync(options.out, { recursive: true });
      writeFileSync(join(options.out, "aggregates.json"), toJson(result));
      writeFileSync(join(options.out, "tickets.csv"), toCsv(result.rows));
      console.log(`wrote ${options.out}/aggregates.json and tickets.csv`);
    }
    if (options.print) printSummary(result);
    return result;
  } finally {
    db.close();
  }
}

/* ----------------------------------------------------------------- self-test */

const commit = (hash, iso, subject, parents) => ({
  hash,
  committedAt: Date.parse(iso),
  subject,
  parents,
});

/** Epoch milliseconds from an ISO instant, for the fixtures below. */
const t = (iso) => Date.parse(iso);

function selfTestRecognisers() {
  const commits = [
    commit("a1", "2026-09-01T10:00:00Z", "Merge pull request #10 from owner/volli/VC-1-a-slug", [
      "m0",
      "s1",
    ]),
    commit("a2", "2026-09-02T10:00:00Z", "Merge branch 'volli/VC-2-other' into main", ["a1", "s2"]),
    commit(
      "a3",
      "2026-09-03T10:00:00Z",
      "Merge remote-tracking branch 'origin/main' into volli/VC-3-x",
      ["a2", "s3"],
    ),
    commit("a4", "2026-09-04T10:00:00Z", "Merge VC-4: did a thing (review-passed)", ["a3", "s4"]),
    commit("a5", "2026-09-05T10:00:00Z", "fix(ui): something (VC-5) (#77)", ["a4"]),
    commit("a6", "2026-09-06T10:00:00Z", "fix(e2e): no ticket here (#78)", ["a5"]),
    commit("a7", "2026-09-07T10:00:00Z", "chore: ordinary commit", ["a6"]),
    commit("a8", "2026-09-08T10:00:00Z", "Merge pull request #79 from owner/release/cleanup", [
      "a7",
      "s8",
    ]),
    // git omits `into <target>` when the merge was made ON the default branch,
    // which is how 5 of this repository's 9 local ticket merges are spelled.
    commit("a9", "2026-09-09T10:00:00Z", "Merge branch 'volli/VC-6-no-target'", ["a8", "s9"]),
    // Same shape, no ticket in the source: an integration pull, not ticket work.
    commit("a10", "2026-09-10T10:00:00Z", "Merge remote-tracking branch 'origin/main'", [
      "a9",
      "s10",
    ]),
    // A ticket-less source merged into a throwaway branch.
    commit("a11", "2026-09-11T10:00:00Z", "Merge branch 'main' into tmp/publish-main", [
      "a10",
      "s11",
    ]),
  ];
  const { evidence, unlinked, counts } = recogniseMerges(commits, {
    prTicketFromLedger: new Map([
      [77, "VC-5"],
      [79, "VC-9"],
    ]),
  });
  const byTicket = new Map(evidence.map((e) => [e.ticket, e]));

  assert.equal(byTicket.get("VC-1").kind, "pr-merge-branch", "a PR merge is read from its branch");
  assert.equal(byTicket.get("VC-1").strength, STRONG);
  assert.equal(byTicket.get("VC-2").kind, "branch-merge", "a local branch merge into main counts");
  assert.equal(byTicket.get("VC-2").strength, STRONG);
  assert.equal(
    byTicket.has("VC-3"),
    false,
    "a merge INTO a ticket branch is not that ticket merging",
  );
  assert.equal(byTicket.get("VC-4").strength, SUBJECT, "a prose subject is not a strong link");
  assert.equal(
    byTicket.get("VC-5").kind,
    "squash-pr-number",
    "a squash merge links through the ledger's PR",
  );
  assert.equal(byTicket.get("VC-5").strength, STRONG);
  assert.equal(
    byTicket.get("VC-9").kind,
    "pr-merge-pr-number",
    "a non-ticket branch still links by PR number",
  );
  assert.equal(
    byTicket.get("VC-6").kind,
    "branch-merge",
    "`Merge branch 'volli/VC-6-…'` with no explicit target is a merge into the integration branch",
  );
  assert.equal(byTicket.get("VC-6").strength, STRONG);
  assert.equal(counts.branchMerge, 2, "both the targeted and the untargeted local merge count");
  assert.equal(
    counts.integrationMerge,
    3,
    "a merge into a ticket branch, a bare origin/main pull, and a merge into a throwaway branch",
  );
  assert.equal(counts.plain, 1);
  assert.deepEqual(
    unlinked.map((u) => u.pr),
    [78],
    "a squash with neither a ledger PR nor a ticket id is reported, not guessed",
  );

  // The end timestamp is the committer date, in epoch ms, unmodified.
  assert.equal(byTicket.get("VC-1").committedAt, Date.parse("2026-09-01T10:00:00Z"));

  // A slug that mentions another ticket keeps the branch's own ticket, flagged.
  const multi = recogniseMerges(
    [
      commit(
        "b1",
        "2026-09-01T10:00:00Z",
        "Merge pull request #1 from o/volli/VC-403-cover-VC-204",
        ["x", "y"],
      ),
    ],
    {},
  );
  assert.equal(multi.evidence[0].ticket, "VC-403");
  assert.equal(multi.evidence[0].ambiguousBranch, true);
  assert.equal(ticketFromBranch("volli/VC-12-mcp-server").ticket, "VC-12");
  assert.equal(ticketFromBranch("main").ticket, undefined);
}

function selfTestAttribution() {
  const sessions = [
    {
      id: "s1",
      ticketId: "VC-1",
      role: "ticket",
      parentSessionId: undefined,
      createdAt: t("2026-09-01T09:00:00Z"),
    },
    {
      id: "s2",
      ticketId: undefined,
      role: "subagent",
      parentSessionId: "s1",
      createdAt: t("2026-09-01T10:00:00Z"),
    },
    {
      id: "s3",
      ticketId: undefined,
      role: "subagent",
      parentSessionId: "s2",
      createdAt: t("2026-09-01T11:00:00Z"),
    },
    {
      id: "s4",
      ticketId: undefined,
      role: "project",
      parentSessionId: undefined,
      createdAt: t("2026-09-01T08:00:00Z"),
    },
    // A Session created first that never received a message, and a later one
    // whose first message is the ticket's real start.
    {
      id: "s5",
      ticketId: "VC-2",
      role: "ticket",
      parentSessionId: undefined,
      createdAt: t("2026-09-02T09:00:00Z"),
    },
    {
      id: "s6",
      ticketId: "VC-2",
      role: "ticket",
      parentSessionId: undefined,
      createdAt: t("2026-09-02T10:00:00Z"),
    },
  ];
  const firstInput = new Map([
    ["s1", t("2026-09-01T09:05:00Z")],
    ["s2", t("2026-09-01T10:05:00Z")],
    ["s3", t("2026-09-01T11:05:00Z")],
    ["s4", t("2026-09-01T08:05:00Z")],
    ["s6", t("2026-09-02T10:05:00Z")],
  ]);
  const { perTicket, orphanedDelegates } = attributeSessions(sessions, firstInput);

  const one = perTicket.get("VC-1");
  assert.equal(
    one.sessionCount,
    3,
    "a delegated child two levels down is still the ticket's Session",
  );
  assert.equal(one.inheritedSessionCount, 2);
  assert.equal(one.earliestSessionFirstMessage, t("2026-09-01T09:05:00Z"));
  assert.equal(one.earliestMessageAnySession, t("2026-09-01T09:05:00Z"));
  assert.equal(perTicket.has(undefined), false, "a project Session belongs to no ticket");
  assert.equal(orphanedDelegates, 0);

  const two = perTicket.get("VC-2");
  assert.equal(
    two.silentLeadingSessions,
    1,
    "a created-but-never-messaged Session cannot set the start",
  );
  assert.equal(two.earliestSessionFirstMessage, t("2026-09-02T10:05:00Z"));

  // Creation order and message order can disagree; both are reported.
  const swapped = attributeSessions(
    [
      {
        id: "x1",
        ticketId: "VC-3",
        role: "ticket",
        parentSessionId: undefined,
        createdAt: t("2026-09-03T09:00:00Z"),
      },
      {
        id: "x2",
        ticketId: "VC-3",
        role: "ticket",
        parentSessionId: undefined,
        createdAt: t("2026-09-03T10:00:00Z"),
      },
    ],
    new Map([
      ["x1", t("2026-09-03T12:00:00Z")],
      ["x2", t("2026-09-03T10:30:00Z")],
    ]),
  ).perTicket.get("VC-3");
  assert.equal(swapped.earliestSessionFirstMessage, t("2026-09-03T12:00:00Z"));
  assert.equal(swapped.earliestMessageAnySession, t("2026-09-03T10:30:00Z"));
}

function selfTestCohort() {
  const tickets = [
    { displayId: "VC-1", status: "done", prNumber: 1 },
    { displayId: "VC-2", status: "done", prNumber: undefined }, // merged, no Session
    { displayId: "VC-3", status: "done", prNumber: undefined }, // Session, no message
    { displayId: "VC-4", status: "done", prNumber: undefined }, // merge before first message
    { displayId: "VC-5", status: "done", prNumber: undefined }, // no merge evidence
    { displayId: "VC-6", status: "done", prNumber: undefined }, // subject-only evidence
  ];
  const ev = (ticket, iso, strength, pr) => ({
    ticket,
    committedAt: t(iso),
    strength,
    kind: strength === STRONG ? "pr-merge-branch" : "merge-subject",
    pr,
    ambiguousBranch: false,
  });
  const evidence = [
    ev("VC-1", "2026-09-01T12:00:00Z", STRONG, 1),
    ev("VC-1", "2026-09-01T18:00:00Z", STRONG, 2), // a second PR for the same task
    ev("VC-2", "2026-09-02T12:00:00Z", STRONG, 3),
    ev("VC-3", "2026-09-03T12:00:00Z", STRONG, 4),
    ev("VC-4", "2026-09-04T12:00:00Z", STRONG, 5),
    ev("VC-6", "2026-09-06T12:00:00Z", SUBJECT, undefined),
    ev("VC-99", "2026-09-07T12:00:00Z", STRONG, 6), // ticket not in the ledger
  ];
  const facts = new Map([
    [
      "VC-1",
      {
        sessionCount: 2,
        messagedSessionCount: 2,
        inheritedSessionCount: 1,
        silentLeadingSessions: 0,
        earliestSessionFirstMessage: t("2026-09-01T09:00:00Z"),
        earliestMessageAnySession: t("2026-09-01T09:00:00Z"),
      },
    ],
    [
      "VC-3",
      {
        sessionCount: 1,
        messagedSessionCount: 0,
        inheritedSessionCount: 0,
        silentLeadingSessions: 1,
        earliestSessionFirstMessage: undefined,
        earliestMessageAnySession: undefined,
      },
    ],
    [
      "VC-4",
      {
        sessionCount: 1,
        messagedSessionCount: 1,
        inheritedSessionCount: 0,
        silentLeadingSessions: 0,
        earliestSessionFirstMessage: t("2026-09-05T09:00:00Z"),
        earliestMessageAnySession: t("2026-09-05T09:00:00Z"),
      },
    ],
    [
      "VC-6",
      {
        sessionCount: 1,
        messagedSessionCount: 1,
        inheritedSessionCount: 0,
        silentLeadingSessions: 0,
        earliestSessionFirstMessage: t("2026-09-06T09:00:00Z"),
        earliestMessageAnySession: t("2026-09-06T09:00:00Z"),
      },
    ],
  ]);

  const primary = buildCohort({ tickets, evidence, sessionFacts: facts, strength: STRONG });
  assert.deepEqual(
    primary.rows.map((r) => r.ticket),
    ["VC-1"],
    "only a ticket with strong merge evidence AND a first message is measured",
  );
  assert.equal(primary.rows[0].elapsedHours, 9, "the END is the LAST strong merge");
  assert.equal(
    primary.rows[0].firstMergeElapsedHours,
    3,
    "the first merge rides along for sensitivity",
  );
  assert.equal(primary.rows[0].mergeEventCount, 2);
  assert.deepEqual(
    primary.exclusions,
    {
      // VC-5 has no merge commit at all; VC-6's only link is a prose subject.
      // For the PRIMARY cohort those are the same verdict — not merged on
      // evidence this measurement will accept — and the extended cohort below
      // is where the second one is allowed to count.
      noMergeEvidence: 2,
      noSession: 1,
      noFirstMessage: 1,
      nonPositiveElapsed: 1,
    },
    "every candidate that is not measured is counted under exactly one reason",
  );
  // `excluded` lists the named-ticket exclusions; `noMergeEvidence` is a count
  // only (it would otherwise name every unmerged ticket in the project). The two
  // plus the cohort must still account for every candidate, with no ticket
  // falling through the recogniser unnoticed.
  assert.equal(
    primary.rows.length + primary.excluded.length + primary.exclusions.noMergeEvidence,
    tickets.length,
    "the cohort and the exclusion reasons together account for every ticket",
  );
  assert.equal(
    primary.excluded.length,
    primary.exclusions.noSession +
      primary.exclusions.noFirstMessage +
      primary.exclusions.nonPositiveElapsed,
    "each named exclusion is counted exactly once",
  );
  assert.equal(
    primary.evidenceForUnknownTicket,
    1,
    "evidence naming an unknown ticket is counted, not measured",
  );
  assert.equal(
    primary.ticketsWithMergeEvidence,
    4,
    "the coverage denominator is merged tickets, not all tickets",
  );

  const extended = buildCohort({ tickets, evidence, sessionFacts: facts, strength: SUBJECT });
  assert.deepEqual(
    extended.rows.map((r) => r.ticket).toSorted(),
    ["VC-1", "VC-6"],
    "the extended cohort admits corroborated prose links",
  );

  // `done` is never merge evidence: a ticket marked done with no merge commit
  // must not appear, which is exactly VC-5 above.
  assert.equal(
    primary.rows.some((r) => r.ticket === "VC-5"),
    false,
  );
}

function selfTestStatistics() {
  const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 100];
  const d = describe(values, { bootstrap: false });
  assert.equal(d.n, 10);
  assert.equal(d.median, 5.5);
  assert.equal(d.p25, 3.25);
  assert.equal(d.p75, 7.75);
  assert.equal(d.min, 1);
  assert.equal(d.max, 100);
  assert.equal(d.mean, 14.5);
  assert.equal(d.trimmedMean10, 5.5, "trimming one observation per tail removes the outlier");
  // Type 7 INTERPOLATES, including into the tail: with n=10 the p90 position is
  // 0.1 of the way from the 9th observation to the 10th, so one 100-hour ticket
  // pulls p90 to 18.1 rather than leaving it at 9. That is the documented
  // estimator behaving correctly, and it is why the report states the estimator
  // and quotes p90/p95 beside a cohort size instead of alone.
  // Checked against R's quantile(c(1:9,100), c(0.9,0.95)) -> 18.1, 59.05.
  assert.equal(Number(d.p90.toFixed(4)), 18.1);
  assert.equal(Number(d.p95.toFixed(4)), 59.05);
  // An outlier-free sample keeps the ordinary reading.
  const tidy = describe([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], { bootstrap: false });
  assert.equal(tidy.median, 5.5);
  assert.equal(Number(tidy.p90.toFixed(4)), 9.1);

  const ci = describe(values, { bootstrap: true }).medianCI95;
  assert.ok(
    ci.lower <= 5.5 && ci.upper >= 5.5,
    "the bootstrap interval brackets the point estimate",
  );
  const again = describe(values, { bootstrap: true }).medianCI95;
  assert.deepEqual(ci, again, "a seeded bootstrap is reproducible");

  const bins = histogram([0.5, 1.5, 3, 200]);
  assert.equal(bins[0].count, 1);
  assert.equal(bins[1].count, 1);
  assert.equal(bins[2].count, 1);
  assert.equal(bins[bins.length - 1].count, 1, "the open top bin catches the long tail");
  assert.equal(
    bins.reduce((a, b) => a + b.count, 0),
    4,
    "every observation lands in exactly one bin",
  );

  const curve = ecdf([0.5, 1, 5, 100]);
  assert.equal(curve.find((c) => c.hours === 1).count, 2);
  assert.equal(curve.find((c) => c.hours === 168).share, 1);

  const strata = stratify(
    [
      ...Array.from({ length: 9 }, () => ({
        elapsedHours: 4,
        finalMergeAt: Date.parse("2026-09-01T00:00:00Z"),
      })),
      ...Array.from({ length: 2 }, () => ({
        elapsedHours: 9,
        finalMergeAt: Date.parse("2026-10-01T00:00:00Z"),
      })),
    ],
    (r) => utcMonth(r.finalMergeAt),
  );
  assert.deepEqual(
    strata.reported.map((s) => s.key),
    ["2026-09"],
  );
  assert.deepEqual(
    strata.suppressed,
    [{ key: "2026-10", n: 2 }],
    "a thin stratum is withheld and declared",
  );
  assert.equal(sessionCountBand(1), "1 Session");
  assert.equal(sessionCountBand(4), "3-4 Sessions");
  assert.equal(sessionCountBand(12), "5+ Sessions");
}

function selfTestOutputPrivacy() {
  const rows = [
    {
      ticket: "VC-1",
      pr: 10,
      finalMergeAt: Date.parse("2026-09-01T18:30:00Z"),
      elapsedHours: 9.5,
      firstMergeElapsedHours: 3.5,
      mergeEventCount: 2,
      sessionCount: 2,
      messagedSessionCount: 2,
      linkKinds: ["pr-merge-branch"],
    },
  ];
  const csv = toCsv(rows);
  assert.match(csv, /^ticket,pr,merge_date_utc/);
  assert.match(csv, /VC-1,10,2026-09-01,9\.500,3\.500,2,2,2,pr-merge-branch/);
  assert.equal(/18:30/.test(csv), false, "no time of day is published");
  const json = toJson({ snapshot: { takenAt: "x" }, rows });
  assert.equal(/startAt/.test(json), false, "the start timestamp is never published");
  assert.equal(/18:30/.test(json), false);

  // With the breakdown attached: per-ticket hours only, still no clock, and
  // never the Session ids the breakdown was computed from.
  const withBreakdown = [
    {
      ...rows[0],
      startAt: Date.parse("2026-09-01T09:00:00Z"),
      sessionIds: ["session-uuid-1"],
      breakdown: {
        working: 1.25,
        silentInTurn: 0.5,
        askingUser: 0,
        failureBlocked: 0.25,
        prOpenIdle: 2,
        idle: 5.5,
        doingToMergeHours: 8,
      },
    },
  ];
  const csvB = toCsv(withBreakdown);
  assert.match(csvB, /pr-merge-branch,1\.250,0\.500,0\.000,0\.250,2\.000,5\.500,8\.000$/m);
  const jsonB = toJson({ snapshot: { takenAt: "x" }, rows: withBreakdown });
  for (const published of [csvB, jsonB]) {
    assert.equal(/session-uuid|startAt|09:00|18:30/.test(published), false);
    assert.equal(/\b1\d{12}\b/.test(published), false, "no epoch-millisecond clock");
  }
}

function selfTest() {
  selfTestRecognisers();
  selfTestAttribution();
  selfTestCohort();
  selfTestStatistics();
  selfTestOutputPrivacy();
  selfTestBreakdown();
  console.log("merged-ticket-time-to-merge self-test passed");
}

/**
 * Whether this file is the entry point rather than an import, compared through
 * `realpathSync` on BOTH sides — same reasoning as
 * `scripts/generate-third-party-notices.mjs`: a worktree behind a symlink makes
 * the naive comparison answer "no", and a gate that answers "no" exits 0.
 */
function invokedAsScript() {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedAsScript()) {
  if (process.argv.includes("--self-test")) selfTest();
  else await main(parseArgs(process.argv.slice(2)));
}

export { analyse, toCsv, toJson };
