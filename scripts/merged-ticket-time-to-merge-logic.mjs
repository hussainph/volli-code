/**
 * The rules behind `scripts/merged-ticket-time-to-merge.mjs` (VC-443): how a
 * merge is recognised in git history, how a merge is linked to a ticket, how a
 * ticket's Sessions are attributed, and the statistics over the elapsed times
 * that result — plus the rules of the breakdown of where that time went
 * (interval classification, failure classes, silences, idle by ticket status,
 * tool-call durations and bash categories), which
 * `merged-ticket-time-breakdown.mjs` assembles.
 *
 * This module is PURE — no git, no SQLite, no filesystem, no clock. Everything
 * it needs arrives as plain records, which is what lets the self-test in the
 * runner exercise the recognisers and the aggregation against fixtures instead
 * of against one laptop's ledger.
 *
 * WHY THE SPLIT MATTERS HERE. The measurement's whole credibility rests on two
 * judgements — "is this commit a merge of that ticket?" and "which timestamp is
 * the ticket's first message?" — and both are ordinary parsing decisions that
 * can be wrong in ways no aggregate would reveal. Keeping them in a module with
 * fixtures makes them reviewable claims rather than a script's side effects.
 */

/** Ticket display ids: `VC-12`, `FW-3`. Anchored so a slug tail cannot match. */
const TICKET_ID = /(?:^|[^A-Z0-9])([A-Z]{1,6}-\d+)(?![0-9])/;

/**
 * Pull the ticket display id out of a branch name. Ticket branches are named
 * `volli/<DISPLAY-ID>-<slug>` (AGENTS.md), and the slug is free text that can
 * itself contain a ticket reference — `volli/VC-403-cover-VC-204-regression` —
 * so this takes the FIRST id, which is the branch's own ticket, and reports
 * whether more than one appeared so the caller can treat that as ambiguous.
 */
export function ticketFromBranch(branch) {
  if (typeof branch !== "string" || branch === "") return { ticket: undefined, ids: [] };
  const ids = [];
  // `matchAll` needs the global flag, and a global regex with `lastIndex` state
  // is a trap in a module-level constant, so the pattern is rebuilt per call.
  for (const m of branch.matchAll(new RegExp(TICKET_ID, "g"))) ids.push(m[1]);
  return { ticket: ids[0], ids };
}

/** Every distinct ticket id mentioned in a free-text string, in first-seen order. */
export function ticketsInText(text) {
  if (typeof text !== "string") return [];
  const seen = new Set();
  for (const m of text.matchAll(new RegExp(TICKET_ID, "g"))) seen.add(m[1]);
  return [...seen];
}

/**
 * How much a merge→ticket link is worth.
 *
 * `strong` — the merge itself names the ticket's branch, or its PR number is
 * the PR number the ledger recorded on that ticket. Either way two artifacts
 * written at different times by different actors agree, and neither is a
 * person's later recollection.
 *
 * `subject` — only a human-written commit subject connects the two. The merge
 * is real (the commit is on the integration branch's first-parent walk) but the
 * ticket attribution is prose. These stay OUT of the primary cohort and form
 * the extended cohort the report publishes as a sensitivity band.
 */
export const STRONG = "strong";
export const SUBJECT = "subject";

/**
 * Recognise the merges on one integration branch's first-parent walk.
 *
 * WHY FIRST-PARENT ONLY. A commit reachable from `main` is not necessarily
 * merged INTO main at a knowable time — it may sit on a side branch that was
 * merged as part of something else. The first-parent walk of `main` is exactly
 * the sequence of integration events on main, and each one's committer date is
 * when main gained that work. That is the merge time this measurement wants,
 * and it is recorded in the repository rather than fetched from a forge API.
 *
 * `commits` are first-parent commits, newest first or oldest first (order is
 * irrelevant), each `{ hash, committedAt, subject, parents }` with
 * `committedAt` an epoch-millisecond number and `parents` an array of hashes.
 *
 * `prTicketFromLedger` maps a PR number to the ticket display id whose ledger
 * row recorded that PR. It is the second, independent link source.
 */
export function recogniseMerges(commits, { prTicketFromLedger = new Map() } = {}) {
  const evidence = [];
  const unlinked = [];
  const counts = {
    prMergeBranch: 0,
    prMergePrNumber: 0,
    branchMerge: 0,
    squashPrNumber: 0,
    mergeSubject: 0,
    squashSubject: 0,
    integrationMerge: 0,
    plain: 0,
    prBranchWithoutTicket: 0,
  };

  for (const commit of commits) {
    const isMerge = (commit.parents?.length ?? 0) > 1;
    const subject = commit.subject ?? "";
    const base = { hash: commit.hash, committedAt: commit.committedAt };

    // 1. A forge merge commit. The merged ref is in the subject, and the ref is
    //    the ticket's own branch — the strongest link available locally.
    const pr = /^Merge pull request #(\d+) from [^/\s]+\/(\S+)/.exec(subject);
    if (isMerge && pr) {
      const prNumber = Number(pr[1]);
      const fromBranch = ticketFromBranch(pr[2]);
      if (fromBranch.ticket) {
        counts.prMergeBranch += 1;
        evidence.push({
          ...base,
          ticket: fromBranch.ticket,
          pr: prNumber,
          branch: pr[2],
          kind: "pr-merge-branch",
          strength: STRONG,
          ambiguousBranch: fromBranch.ids.length > 1,
        });
        continue;
      }
      // A PR from a branch that does not name a ticket (a release branch, a
      // one-off fix). The ledger's own PR link can still place it.
      const fromLedger = prTicketFromLedger.get(prNumber);
      counts.prBranchWithoutTicket += 1;
      if (fromLedger) {
        counts.prMergePrNumber += 1;
        evidence.push({
          ...base,
          ticket: fromLedger,
          pr: prNumber,
          branch: pr[2],
          kind: "pr-merge-pr-number",
          strength: STRONG,
          ambiguousBranch: false,
        });
      } else {
        unlinked.push({ ...base, pr: prNumber, branch: pr[2], kind: "pr-merge-unlinked" });
      }
      continue;
    }

    // 2. A local `git merge` of a ticket branch into the integration branch.
    //    Same branch-name evidence as (1) with no PR attached. The direction
    //    check is what keeps `Merge remote-tracking branch 'origin/main' into
    //    volli/VC-349-…` — an integration merge INTO a ticket branch, which
    //    proves nothing about that ticket being merged — out of the cohort.
    const branchMerge = /^Merge (?:remote-tracking )?branch '([^']+)'(?: into (\S+))?/.exec(
      subject,
    );
    if (isMerge && branchMerge) {
      const source = ticketFromBranch(branchMerge[1]);
      const target = branchMerge[2];
      const intoIntegration = target === undefined || ticketFromBranch(target).ticket === undefined;
      if (source.ticket && intoIntegration) {
        counts.branchMerge += 1;
        evidence.push({
          ...base,
          ticket: source.ticket,
          pr: undefined,
          branch: branchMerge[1],
          kind: "branch-merge",
          strength: STRONG,
          ambiguousBranch: source.ids.length > 1,
        });
      } else {
        counts.integrationMerge += 1;
      }
      continue;
    }

    // 3. A merge commit whose subject names a ticket and nothing else. Real
    //    merge, prose attribution — `subject` strength.
    const subjectMerge = /^Merge ([A-Z]{1,6}-\d+)\b/.exec(subject);
    if (isMerge && subjectMerge) {
      counts.mergeSubject += 1;
      evidence.push({
        ...base,
        ticket: subjectMerge[1],
        pr: undefined,
        branch: undefined,
        kind: "merge-subject",
        strength: SUBJECT,
        ambiguousBranch: false,
      });
      continue;
    }

    if (isMerge) {
      counts.integrationMerge += 1;
      continue;
    }

    // 4. A squashed PR: no merge commit, one commit on main whose subject ends
    //    in the PR number. The ledger's PR link makes it strong; a ticket id in
    //    the subject alone makes it `subject`.
    const squash = /\(#(\d+)\)\s*$/.exec(subject);
    if (squash) {
      const prNumber = Number(squash[1]);
      const fromLedger = prTicketFromLedger.get(prNumber);
      if (fromLedger) {
        counts.squashPrNumber += 1;
        evidence.push({
          ...base,
          ticket: fromLedger,
          pr: prNumber,
          branch: undefined,
          kind: "squash-pr-number",
          strength: STRONG,
          ambiguousBranch: false,
        });
        continue;
      }
      const mentioned = ticketsInText(subject.replace(/\(#\d+\)\s*$/, ""));
      if (mentioned.length === 1) {
        counts.squashSubject += 1;
        evidence.push({
          ...base,
          ticket: mentioned[0],
          pr: prNumber,
          branch: undefined,
          kind: "squash-subject",
          strength: SUBJECT,
          ambiguousBranch: false,
        });
      } else {
        unlinked.push({ ...base, pr: prNumber, kind: "squash-unlinked" });
      }
      continue;
    }

    counts.plain += 1;
  }

  return { evidence, unlinked, counts };
}

/**
 * Attribute Sessions to tickets and reduce each ticket to its first message.
 *
 * `sessions` are `{ id, ticketId, role, parentSessionId, createdAt }`.
 * `firstInputBySession` maps a session id to the epoch-millisecond time of its
 * first `session.input.recorded` event, absent when the Session never received
 * one.
 *
 * WHY THE PARENT WALK. A delegated child Session is a Session of the same piece
 * of work, and most of them carry the ticket id directly — but some carry none
 * and are attached to the ticket only through their parent. Dropping those
 * would silently shrink the Session counts a stratum is cut by. They cannot
 * move the START earlier (a child is delegated by a parent that has already
 * received its own first message), and the runner asserts that on live data
 * rather than assuming it.
 *
 * WHY `earliestSessionFirstMessage` IS THE PRIMARY START. VC-443 asks for the
 * first message of the EARLIEST associated Session, not the earliest message
 * anywhere. The two differ only when a later-created Session received a message
 * before an earlier-created one did, so both are returned and the report states
 * how often they disagree.
 */
export function attributeSessions(sessions, firstInputBySession) {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const resolvedTicket = new Map();

  /** The ticket a Session belongs to, following parents when it names none. */
  const ticketOf = (sessionId, seen = new Set()) => {
    if (resolvedTicket.has(sessionId)) return resolvedTicket.get(sessionId);
    const session = byId.get(sessionId);
    if (session === undefined || seen.has(sessionId)) return undefined;
    seen.add(sessionId);
    const direct = session.ticketId ?? undefined;
    const answer =
      direct ?? (session.parentSessionId ? ticketOf(session.parentSessionId, seen) : undefined);
    resolvedTicket.set(sessionId, answer);
    return answer;
  };

  const perTicket = new Map();
  let orphanedDelegates = 0;
  for (const session of sessions) {
    const ticket = ticketOf(session.id);
    if (ticket === undefined) {
      if (session.parentSessionId) orphanedDelegates += 1;
      continue;
    }
    if (!perTicket.has(ticket)) perTicket.set(ticket, []);
    perTicket.get(ticket).push({
      ...session,
      inheritedTicket: session.ticketId == null,
      firstInputAt: firstInputBySession.get(session.id),
    });
  }

  const result = new Map();
  for (const [ticket, list] of perTicket) {
    // Deterministic order: creation time, then id, so a tie cannot make the
    // chosen "earliest Session" depend on SQLite's row order.
    const ordered = list.toSorted((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
    const withMessage = ordered.filter((s) => s.firstInputAt !== undefined);
    const earliest = withMessage[0];
    const globalMin = withMessage.reduce(
      (min, s) => (min === undefined || s.firstInputAt < min ? s.firstInputAt : min),
      undefined,
    );
    result.set(ticket, {
      sessionCount: ordered.length,
      messagedSessionCount: withMessage.length,
      inheritedSessionCount: ordered.filter((s) => s.inheritedTicket).length,
      /** Sessions created before the first one that ever received a message. */
      silentLeadingSessions: earliest === undefined ? ordered.length : ordered.indexOf(earliest),
      /** Every attributed Session, for the breakdown; never published. */
      sessionIds: ordered.map((s) => s.id),
      earliestSessionFirstMessage: earliest?.firstInputAt,
      earliestMessageAnySession: globalMin,
      earliestSessionRole: earliest?.role,
    });
  }
  return { perTicket: result, orphanedDelegates };
}

/**
 * Build the cohort: one row per ticket that has both a usable start and a
 * verified merge, plus the reason every other candidate was left out.
 *
 * `tickets` are the ledger's own rows, `{ displayId, status, prNumber }`, and
 * define the denominator for coverage. `evidence` is what `recogniseMerges`
 * returned. `sessionFacts` is `attributeSessions(...).perTicket`.
 *
 * END TIMESTAMP. A ticket with several strong merges takes the LATEST as the
 * completion time: when a task shipped across two PRs it is not done until the
 * last one lands. `firstMergeAt` rides along so the report can quantify what
 * the other choice would have said.
 */
export function buildCohort({ tickets, evidence, sessionFacts, strength = STRONG }) {
  const known = new Map(tickets.map((t) => [t.displayId, t]));
  const accepted = strength === STRONG ? new Set([STRONG]) : new Set([STRONG, SUBJECT]);

  const merges = new Map();
  let evidenceForUnknownTicket = 0;
  for (const item of evidence) {
    if (!accepted.has(item.strength)) continue;
    if (!known.has(item.ticket)) {
      evidenceForUnknownTicket += 1;
      continue;
    }
    if (!merges.has(item.ticket)) merges.set(item.ticket, []);
    merges.get(item.ticket).push(item);
  }

  const rows = [];
  const exclusions = {
    noMergeEvidence: 0,
    noSession: 0,
    noFirstMessage: 0,
    nonPositiveElapsed: 0,
  };
  const excluded = [];
  const note = (displayId, reason) => {
    exclusions[reason] += 1;
    excluded.push({ ticket: displayId, reason });
  };

  for (const ticket of tickets) {
    const mine = merges.get(ticket.displayId);
    if (mine === undefined || mine.length === 0) {
      exclusions.noMergeEvidence += 1;
      continue;
    }
    const facts = sessionFacts.get(ticket.displayId);
    if (facts === undefined) {
      note(ticket.displayId, "noSession");
      continue;
    }
    if (facts.earliestSessionFirstMessage === undefined) {
      note(ticket.displayId, "noFirstMessage");
      continue;
    }
    const sorted = mine.toSorted((a, b) => a.committedAt - b.committedAt);
    const firstMergeAt = sorted[0].committedAt;
    const finalMergeAt = sorted[sorted.length - 1].committedAt;
    const startAt = facts.earliestSessionFirstMessage;
    if (finalMergeAt <= startAt) {
      note(ticket.displayId, "nonPositiveElapsed");
      continue;
    }
    rows.push({
      ticket: ticket.displayId,
      status: ticket.status,
      startAt,
      firstMergeAt,
      finalMergeAt,
      elapsedHours: (finalMergeAt - startAt) / 3_600_000,
      firstMergeElapsedHours: (firstMergeAt - startAt) / 3_600_000,
      mergeEventCount: sorted.length,
      pr: sorted[sorted.length - 1].pr,
      ledgerPr: ticket.prNumber,
      linkKinds: [...new Set(sorted.map((m) => m.kind))].toSorted(),
      sessionCount: facts.sessionCount,
      messagedSessionCount: facts.messagedSessionCount,
      inheritedSessionCount: facts.inheritedSessionCount,
      silentLeadingSessions: facts.silentLeadingSessions,
      sessionIds: facts.sessionIds ?? [],
      startDisagreesWithGlobalMin: facts.earliestMessageAnySession !== startAt,
      globalMinElapsedHours:
        facts.earliestMessageAnySession === undefined
          ? undefined
          : (finalMergeAt - facts.earliestMessageAnySession) / 3_600_000,
      ambiguousBranchEvidence: sorted.some((m) => m.ambiguousBranch),
    });
  }

  rows.sort((a, b) => a.finalMergeAt - b.finalMergeAt);
  return {
    rows,
    exclusions,
    excluded,
    evidenceForUnknownTicket,
    ticketsWithMergeEvidence: merges.size,
  };
}

/* ------------------------------------------------------------------ statistics */

/**
 * Quantile by linear interpolation between order statistics — R's type 7, and
 * numpy's and Excel's default. Named because "p90" means nothing until the
 * estimator is stated, and different tools disagree by a whole observation on
 * samples this size.
 */
export function quantile(sorted, p) {
  if (sorted.length === 0) return undefined;
  if (sorted.length === 1) return sorted[0];
  const h = (sorted.length - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}

export function mean(values) {
  if (values.length === 0) return undefined;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Mean after dropping `fraction` of the observations from EACH tail. Reported
 * beside the arithmetic mean because this distribution's right tail is a few
 * tickets that sat open for days, which move a mean and tell you nothing about
 * a typical one; it is a supplement to the median, never a replacement.
 */
export function trimmedMean(sorted, fraction) {
  if (sorted.length === 0) return undefined;
  const drop = Math.floor(sorted.length * fraction);
  const kept = drop === 0 ? sorted : sorted.slice(drop, sorted.length - drop);
  return kept.length === 0 ? undefined : mean(kept);
}

/** mulberry32 — a small seeded PRNG, so a bootstrap is reproducible. */
export function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Percentile-method bootstrap confidence interval. No distributional
 * assumption, which matters because time-to-merge is strongly right-skewed and
 * a normal-theory interval on the mean would understate the upper bound.
 */
export function bootstrapCI(
  values,
  statistic,
  { resamples = 10_000, alpha = 0.05, seed = 443 } = {},
) {
  if (values.length < 3) return undefined;
  const random = seededRandom(seed);
  const stats = Array.from({ length: resamples });
  const sample = Array.from({ length: values.length });
  for (let r = 0; r < resamples; r += 1) {
    for (let i = 0; i < values.length; i += 1) sample[i] = values[(random() * values.length) | 0];
    stats[r] = statistic(sample.toSorted((a, b) => a - b));
  }
  const ordered = stats.toSorted((a, b) => a - b);
  return {
    lower: quantile(ordered, alpha / 2),
    upper: quantile(ordered, 1 - alpha / 2),
    resamples,
    method: "percentile bootstrap, seeded",
  };
}

/** Every headline number the report quotes, from one array of hours. */
export function describe(values, { bootstrap = true, seed = 443 } = {}) {
  const sorted = values.toSorted((a, b) => a - b);
  const summary = {
    n: sorted.length,
    min: sorted[0],
    p25: quantile(sorted, 0.25),
    median: quantile(sorted, 0.5),
    p75: quantile(sorted, 0.75),
    p90: quantile(sorted, 0.9),
    p95: quantile(sorted, 0.95),
    max: sorted[sorted.length - 1],
    mean: mean(sorted),
    trimmedMean10: trimmedMean(sorted, 0.1),
  };
  if (bootstrap && sorted.length >= 3) {
    summary.medianCI95 = bootstrapCI(sorted, (s) => quantile(s, 0.5), { seed });
    summary.meanCI95 = bootstrapCI(sorted, (s) => mean(s), { seed: seed + 1 });
  }
  return summary;
}

/**
 * Fixed hour edges, so a histogram from a later snapshot is comparable to this
 * one rather than rebinned around its own data.
 */
export const HISTOGRAM_EDGES_HOURS = [0, 1, 2, 4, 8, 16, 24, 48, 96, 168];

export function histogram(values, edges = HISTOGRAM_EDGES_HOURS) {
  const bins = edges.map((from, i) => ({
    from,
    to: i + 1 < edges.length ? edges[i + 1] : undefined,
    count: 0,
  }));
  for (const v of values) {
    let index = 0;
    for (let i = 0; i < edges.length; i += 1) if (v >= edges[i]) index = i;
    bins[index].count += 1;
  }
  const total = values.length;
  for (const bin of bins) bin.share = total === 0 ? 0 : bin.count / total;
  return bins;
}

export const ECDF_THRESHOLDS_HOURS = [1, 2, 4, 8, 12, 24, 48, 72, 168];

/** Empirical CDF at fixed thresholds: the share finished within each one. */
export function ecdf(values, thresholds = ECDF_THRESHOLDS_HOURS) {
  const total = values.length;
  return thresholds.map((hours) => {
    const count = values.filter((v) => v <= hours).length;
    return { hours, count, share: total === 0 ? 0 : count / total };
  });
}

/**
 * Split rows into strata and describe each, suppressing any stratum too small
 * to say anything about. `minimum` is reported with the result so the reader
 * knows what was withheld rather than guessing at gaps.
 */
export function stratify(rows, keyOf, { minimum = 8, seed = 443 } = {}) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    if (key === undefined) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row.elapsedHours);
  }
  const reported = [];
  const suppressed = [];
  for (const [key, values] of [...groups].toSorted((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (values.length < minimum) {
      suppressed.push({ key, n: values.length });
      continue;
    }
    reported.push({ key, ...describe(values, { bootstrap: false, seed }) });
  }
  return { minimum, reported, suppressed };
}

/** `2026-09` in UTC, so a stratum does not move with the reader's timezone. */
export function utcMonth(epochMs) {
  const d = new Date(epochMs);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Session-count bands. Kept coarse: the tail beyond three is thin. */
export function sessionCountBand(count) {
  if (count <= 1) return "1 Session";
  if (count === 2) return "2 Sessions";
  if (count <= 4) return "3-4 Sessions";
  return "5+ Sessions";
}

/** `≤24 h` / `>24 h`: the split the breakdown's reading turns on. */
export function elapsedBand(hours) {
  return hours > 24 ? ">24 h" : "≤24 h";
}

/* ------------------------------------------------------ where the time went */

/*
 * The breakdown splits each cohort ticket's window — first message to final
 * merge — into mutually exclusive categories, from the ledger's own Session
 * facts. Everything below is interval arithmetic over plain records: no clock,
 * no ledger, no payload text. The runner reduces each ledger event to its kind,
 * its clock and the few identifiers these rules need before any of this runs.
 */

export const MINUTE_MS = 60_000;

/** The in-turn silence threshold the report leads with; `--silence-minutes` overrides it. */
export const DEFAULT_SILENCE_MINUTES = 5;

/** The thresholds the sensitivity row reruns the breakdown at. */
export const SILENCE_SENSITIVITY_MINUTES = [2, 5, 10];

/**
 * The categories, IN PRIORITY ORDER. A ticket often has several Sessions, so
 * one instant can satisfy several of these at once; the instant is counted
 * under the FIRST that holds, which makes the categories mutually exclusive
 * and their sum exactly the window. The order is "most progressed first": if
 * any Session of the ticket was producing, the ticket was being worked on,
 * whatever a sibling was doing.
 *
 * - `working` — a turn was open, no question to the user was pending, and the
 *   executor had written to the ledger within the silence threshold.
 * - `silentInTurn` — a turn was open, nothing pending on the user, and the
 *   stretch between two executor writes lasted at least the threshold. The
 *   WHOLE stretch counts, not only the part past the threshold.
 * - `askingUser` — the Session had opened an interaction (a question or a
 *   permission) that was not yet resolved or cancelled.
 * - `failureBlocked` — a runtime failure Attention had been raised and nothing
 *   had yet moved the ticket on (see `sessionTimeline` and
 *   `closeFailureBlocks`).
 * - `prOpenIdle` — none of the above, and a pull request for the ticket was
 *   open.
 * - `idle` — none of the above: no turn, no question, no failure, no PR.
 */
export const BREAKDOWN_CATEGORIES = [
  "working",
  "silentInTurn",
  "askingUser",
  "failureBlocked",
  "prOpenIdle",
  "idle",
];

/**
 * Ledger event kinds that are NOT the executor making progress: the user's
 * own inputs and commands, the receipts for them, lifecycle bookkeeping, and
 * signals — including the watchdog's own `blocked` signal, which reports a
 * silence and must not be the thing that ends it.
 */
const NOT_PROGRESS = new Set([
  "session.created",
  "session.archived",
  "session.retitled",
  "session.input.recorded",
  "session.signaled",
  "session.stopped",
  "command.recorded",
  "command.receipt.recorded",
  "model.selected",
  "attention.cleared",
]);

export function isProgressEvent(kind) {
  return !NOT_PROGRESS.has(kind);
}

/**
 * The Attention kinds that are a runtime failure. `input_required` and
 * `permission_required` are the agent waiting on a person by design, which the
 * interaction events already measure, so they are not failures here.
 */
export const FAILURE_ATTENTION_KINDS = new Set([
  "auth_required",
  "configuration_invalid",
  "rate_limited",
  "quota_exhausted",
  "context_limit_reached",
  "transport_retrying",
  "partial_turn_interrupted",
  "adapter_disconnected",
  "adapter_unrecoverable",
]);

/**
 * Failure classes, and whose fault each one is. `external` is the provider,
 * the network or the account; `volli` is a request, host or recovery path this
 * product owns. The runtime writes almost every failure as
 * `adapter_unrecoverable` and keeps the reason only as provider text, so most
 * classes are read from that text — in memory, never published.
 */
export const FAILURE_CLASSES = [
  "transientNetwork",
  "quotaOrRateLimit",
  "auth",
  "policyRefusal",
  "appRestart",
  "worktreeOrConfig",
  "volliRequest",
  "volliHost",
  "other",
];

export const FAILURE_ORIGIN = {
  transientNetwork: "external",
  quotaOrRateLimit: "external",
  auth: "external",
  policyRefusal: "external",
  appRestart: "volli",
  worktreeOrConfig: "volli",
  volliRequest: "volli",
  volliHost: "volli",
  other: "unclassified",
};

/**
 * Classify one failure Attention. Kind decides first where the runtime
 * recorded a specific one; otherwise the detail text is matched in this order,
 * first match wins:
 *
 * 1. `volliRequest` — the provider rejected a request Volli built: an image
 *    over the provider's dimension limit, an over-size body (413), a missing
 *    routing header, a client-version gate.
 * 2. `volliHost` — a Volli-side host was not ready or could not deliver.
 * 3. `policyRefusal` — the provider's content policy refused the request.
 * 4. `transientNetwork` for an overload — checked BEFORE the quota rule
 *    because one provider reports "temporarily overloaded" with status 429.
 * 5. `quotaOrRateLimit` — 429s, usage limits, throttling.
 * 6. `transientNetwork` — timeouts, dropped connections, 5xx, truncated
 *    streams.
 * 7. `other`.
 */
export function classifyFailure(kind, detail) {
  if (kind === "partial_turn_interrupted") return "appRestart";
  if (kind === "auth_required") return "auth";
  if (kind === "configuration_invalid") return "worktreeOrConfig";
  if (kind === "rate_limited" || kind === "quota_exhausted") return "quotaOrRateLimit";
  if (kind === "context_limit_reached") return "other";
  const text = typeof detail === "string" ? detail : "";
  if (
    /image dimensions|request_too_large|\b413\b|x-opencode-session|does not support this model/i.test(
      text,
    )
  )
    return "volliRequest";
  if (/host is not ready|could not be delivered/i.test(text)) return "volliHost";
  if (/content filtering|usage policy|violative|flagged as potentially/i.test(text))
    return "policyRefusal";
  if (/overloaded/i.test(text)) return "transientNetwork";
  if (
    /\b429\b|rate.?limit|usage limit|out of extra usage|too many (concurrent )?requests|throttl/i.test(
      text,
    )
  )
    return "quotaOrRateLimit";
  if (
    /timed? ?out|timeout|connection error|^terminated|fetch failed|websocket error|upstream connect|disconnect\/reset|stream ended without|\b5\d\d\b|bad gateway|error occurred while processing|unable to complete this request|econnreset|etimedout|socket hang up/i.test(
      text,
    )
  )
    return "transientNetwork";
  return "other";
}

/** Sort and coalesce `[{start, end}]`, dropping empty intervals. */
export function unionIntervals(intervals) {
  const sorted = intervals.filter((i) => i.end > i.start).toSorted((a, b) => a.start - b.start);
  const out = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && i.start <= last.end) last.end = Math.max(last.end, i.end);
    else out.push({ start: i.start, end: i.end });
  }
  return out;
}

/** `a` minus `b`, both unions. */
export function subtractIntervals(a, b) {
  const out = [];
  let j = 0;
  for (const { start, end } of a) {
    let cursor = start;
    while (j < b.length && b[j].end <= cursor) j += 1;
    let k = j;
    while (k < b.length && b[k].start < end) {
      if (b[k].start > cursor) out.push({ start: cursor, end: b[k].start });
      cursor = Math.max(cursor, b[k].end);
      k += 1;
    }
    if (cursor < end) out.push({ start: cursor, end });
  }
  return out;
}

/** Milliseconds of `[start, end)` covered by a union, by binary search. */
export function overlapWithUnion(start, end, union) {
  let lo = 0;
  let hi = union.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (union[mid].end <= start) lo = mid + 1;
    else hi = mid;
  }
  let total = 0;
  for (let i = lo; i < union.length && union[i].start < end; i += 1) {
    total += Math.min(end, union[i].end) - Math.max(start, union[i].start);
  }
  return total;
}

/**
 * Fold ONE Session's ledger events into the intervals the breakdown needs.
 *
 * `events` are in ledger sequence order, each `{ at, kind }` plus, where the
 * kind carries one, `turnId`, `interactionId`, `attentionId`, `failureClass`
 * (set only for a failure Attention) and `watchdog` (a `session.signaled` the
 * watchdog wrote). `at` is forced non-decreasing: a few receipts carry an
 * `occurred_at` slightly before the event sequenced ahead of them, and
 * sequence is the ledger's order of record.
 *
 * - A turn stretch runs while at least one turn is open. A turn with no end
 *   record closes at the Session's last executor write — the conservative
 *   reading, which never invents running time out of a missing record.
 * - A silence is a gap of at least `silenceMs` between executor writes while a
 *   turn is open and no interaction is pending, tagged with what ended it and
 *   whether the watchdog tripped inside it.
 * - A failure block opens at a failure Attention (another one while a block is
 *   open belongs to the same block, which keeps its first class) and closes at
 *   the Session's next `turn.started`, `turn.completed` (the turn survived),
 *   `session.stopped`, input, or the clearing of that Attention. A block this
 *   Session never closes is left open for `closeFailureBlocks`.
 */
export function sessionTimeline(events, { silenceMs }) {
  const turns = [];
  const asking = [];
  const silences = [];
  const failures = [];
  const inputs = [];
  const openTurns = new Set();
  const openInteractions = new Set();
  let turnStretchStart;
  let askStart;
  let lastProgressAt;
  let watchdogSinceProgress = false;
  let block;
  let clock = -Infinity;

  const closeBlock = (at, endedBy) => {
    if (block === undefined) return;
    failures.push({ ...block, end: at, endedBy });
    block = undefined;
  };

  for (const event of events) {
    const at = Math.max(clock, event.at);
    clock = at;
    if (isProgressEvent(event.kind)) {
      if (
        openTurns.size > 0 &&
        openInteractions.size === 0 &&
        lastProgressAt !== undefined &&
        at - lastProgressAt >= silenceMs
      ) {
        let endedBy = "resumed";
        if (event.kind === "turn.completed") endedBy = "turnCompleted";
        else if (event.kind === "turn.interrupted") endedBy = "interrupted";
        else if (event.kind === "attention.raised" && event.failureClass !== undefined)
          endedBy = "failure";
        silences.push({
          start: lastProgressAt,
          end: at,
          endedBy,
          failureClass: endedBy === "failure" ? event.failureClass : undefined,
          watchdogTripped: watchdogSinceProgress,
        });
      }
      lastProgressAt = at;
      watchdogSinceProgress = false;
    }
    switch (event.kind) {
      case "turn.started":
        if (openTurns.size === 0) turnStretchStart = at;
        openTurns.add(event.turnId);
        closeBlock(at, "turnStarted");
        break;
      case "turn.completed":
      case "turn.interrupted":
        if (openTurns.delete(event.turnId) && openTurns.size === 0) {
          turns.push({ start: turnStretchStart, end: at });
        }
        if (event.kind === "turn.completed") closeBlock(at, "turnCompleted");
        break;
      case "interaction.opened":
        if (openInteractions.size === 0) askStart = at;
        openInteractions.add(event.interactionId);
        break;
      case "interaction.resolved":
      case "interaction.cancelled":
        if (openInteractions.delete(event.interactionId) && openInteractions.size === 0) {
          asking.push({ start: askStart, end: at });
        }
        break;
      case "attention.raised":
        if (event.failureClass !== undefined && block === undefined) {
          block = { start: at, failureClass: event.failureClass, attentionId: event.attentionId };
        }
        break;
      case "attention.cleared":
        if (block !== undefined && block.attentionId === event.attentionId) {
          closeBlock(at, "cleared");
        }
        break;
      case "session.input.recorded":
        inputs.push(at);
        closeBlock(at, "input");
        break;
      case "session.stopped":
        closeBlock(at, "stopped");
        break;
      case "session.signaled":
        if (event.watchdog) watchdogSinceProgress = true;
        break;
      default:
        break;
    }
  }

  // The last executor write is the last instant anything proves was running.
  const unterminatedTurns = openTurns.size;
  if (unterminatedTurns > 0 && lastProgressAt > turnStretchStart) {
    turns.push({ start: turnStretchStart, end: lastProgressAt });
  }
  if (openInteractions.size > 0 && lastProgressAt > askStart) {
    asking.push({ start: askStart, end: lastProgressAt });
  }
  if (block !== undefined) failures.push({ ...block, end: undefined, endedBy: undefined });

  return { turns, asking, silences, failures, inputs, unterminatedTurns };
}

/**
 * Close every failure block at the NEXT input to ANY of the ticket's Sessions
 * when that comes before the block's own end: once the person has typed into
 * the ticket anywhere, the ticket is no longer waiting on that failure — they
 * have moved it on, perhaps in a fresh Session. A block nothing ever closes
 * runs to the window's end.
 */
export function closeFailureBlocks(failures, ticketInputs, windowEnd) {
  const inputs = ticketInputs.toSorted((a, b) => a - b);
  return failures.map((f) => {
    const next = inputs.find((at) => at > f.start);
    let end = f.end ?? Infinity;
    let endedBy = f.endedBy ?? "windowEnd";
    if (next !== undefined && next < end) {
      end = next;
      endedBy = "input";
    }
    if (end === Infinity) end = windowEnd;
    return { ...f, end, endedBy };
  });
}

/**
 * Disjoint failure segments, one class per instant. Where blocks overlap —
 * two Sessions of the same ticket failing at once — the instant belongs to the
 * block raised FIRST (ties by class name), so failure time is never counted
 * twice across concurrent Sessions and the per-class hours sum exactly to
 * `failureBlocked`.
 */
export function failureSegments(blocks) {
  const points = [...new Set(blocks.flatMap((b) => [b.start, b.end]))].toSorted((a, b) => a - b);
  const out = [];
  for (let i = 0; i + 1 < points.length; i += 1) {
    const [a, b] = [points[i], points[i + 1]];
    let chosen;
    for (const block of blocks) {
      if (block.start > a || block.end < b) continue;
      if (
        chosen === undefined ||
        block.start < chosen.start ||
        (block.start === chosen.start && block.failureClass < chosen.failureClass)
      )
        chosen = block;
    }
    if (chosen === undefined) continue;
    const last = out[out.length - 1];
    if (
      last !== undefined &&
      last.end === a &&
      last.failureClass === chosen.failureClass &&
      last.endedBy === chosen.endedBy
    )
      last.end = b;
    else out.push({ start: a, end: b, failureClass: chosen.failureClass, endedBy: chosen.endedBy });
  }
  return out;
}

/**
 * The ticket's status over time from its `created` / `status_changed` events,
 * `[{ at, status }]` with the first entry at `-Infinity`. A ticket created
 * before the ledger recorded `created` events starts in its first recorded
 * change's `from`.
 */
export function statusTimeline(events) {
  const ordered = events.toSorted((a, b) => a.at - b.at);
  const created = ordered.find((e) => e.kind === "created");
  const firstChange = ordered.find((e) => e.kind === "status_changed");
  const initial = created?.status ?? firstChange?.from ?? "unknown";
  const out = [{ at: -Infinity, status: initial }];
  for (const e of ordered) if (e.kind === "status_changed") out.push({ at: e.at, status: e.to });
  return out;
}

/** The first instant the ticket was in Doing: created there, or moved there. */
export function firstMoveToDoing(events) {
  const hits = events
    .filter(
      (e) =>
        (e.kind === "created" && e.status === "doing") ||
        (e.kind === "status_changed" && e.to === "doing"),
    )
    .map((e) => e.at);
  return hits.length === 0 ? undefined : Math.min(...hits);
}

/**
 * Split one ticket's window `[windowStart, windowEnd)` into the categories.
 *
 * `timelines` are `sessionTimeline` results for every Session attributed to
 * the ticket; `prIntervals` the stretches a PR for it was open; `statusAt` its
 * `statusTimeline`; `elsewhereBusy` a union of every open-turn stretch in the
 * whole ledger. During this ticket's idle time that can only be ANOTHER
 * ticket's or Session's turn: an idle instant has no open turn of its own by
 * construction.
 *
 * Returns milliseconds per category (summing exactly to the window), failure
 * milliseconds per class and per what ended the block (each summing exactly
 * to `failureBlocked`), idle
 * milliseconds per ticket status, and idle milliseconds during which some
 * other Session was running a turn.
 */
export function decomposeTicket({
  windowStart,
  windowEnd,
  timelines,
  prIntervals = [],
  statusAt = [{ at: -Infinity, status: "unknown" }],
  elsewhereBusy = [],
}) {
  const clip = (list) =>
    list
      .map((i) => ({
        ...i,
        start: Math.max(i.start, windowStart),
        end: Math.min(i.end, windowEnd),
      }))
      .filter((i) => i.end > i.start);

  const working = [];
  const silent = [];
  const asking = [];
  const rawFailures = [];
  const inputs = [];
  for (const tl of timelines) {
    const turns = unionIntervals(tl.turns);
    const quiet = unionIntervals(tl.silences);
    const ask = unionIntervals(tl.asking);
    working.push(...subtractIntervals(subtractIntervals(turns, quiet), ask));
    silent.push(...quiet);
    asking.push(...ask);
    rawFailures.push(...tl.failures);
    inputs.push(...tl.inputs);
  }
  const failures = clip(closeFailureBlocks(rawFailures, inputs, windowEnd));
  const layers = [
    { name: "working", list: unionIntervals(clip(working)) },
    { name: "silentInTurn", list: unionIntervals(clip(silent)) },
    { name: "askingUser", list: unionIntervals(clip(asking)) },
    { name: "failureBlocked", list: failureSegments(failures) },
    { name: "prOpenIdle", list: unionIntervals(clip(prIntervals)) },
  ];

  const points = new Set([windowStart, windowEnd]);
  for (const layer of layers) for (const i of layer.list) points.add(i.start).add(i.end);
  for (const s of statusAt) if (s.at > windowStart && s.at < windowEnd) points.add(s.at);
  const ordered = [...points].toSorted((a, b) => a - b);

  const byCategory = Object.fromEntries(BREAKDOWN_CATEGORIES.map((c) => [c, 0]));
  const failureByClass = {};
  const failureByEnd = {};
  const idleByStatus = {};
  let idleWhileElsewhereRunning = 0;
  const cursor = layers.map(() => 0);
  let statusIndex = 0;

  for (let p = 0; p + 1 < ordered.length; p += 1) {
    const [a, b] = [ordered[p], ordered[p + 1]];
    let category = "idle";
    let covering;
    for (let l = 0; l < layers.length; l += 1) {
      const list = layers[l].list;
      while (cursor[l] < list.length && list[cursor[l]].end <= a) cursor[l] += 1;
      const item = list[cursor[l]];
      if (item !== undefined && item.start <= a && item.end >= b) {
        category = layers[l].name;
        covering = item;
        break;
      }
    }
    const ms = b - a;
    byCategory[category] += ms;
    if (category === "failureBlocked") {
      failureByClass[covering.failureClass] = (failureByClass[covering.failureClass] ?? 0) + ms;
      failureByEnd[covering.endedBy] = (failureByEnd[covering.endedBy] ?? 0) + ms;
    }
    if (category === "idle") {
      while (statusIndex + 1 < statusAt.length && statusAt[statusIndex + 1].at <= a) {
        statusIndex += 1;
      }
      const status = statusAt[statusIndex].status;
      idleByStatus[status] = (idleByStatus[status] ?? 0) + ms;
      idleWhileElsewhereRunning += overlapWithUnion(a, b, elsewhereBusy);
    }
  }

  return {
    totalMs: windowEnd - windowStart,
    byCategory,
    failureByClass,
    failureByEnd,
    idleByStatus,
    idleWhileElsewhereRunning,
  };
}

/**
 * The stretches a pull request for this ticket was open, from a `gh pr list`
 * capture: every merged PR whose head branch names the ticket, or whose number
 * the ledger or the merge evidence ties to it, from `createdAt` to `mergedAt`.
 * Also returns the earliest creation, for "PR opened → merge".
 */
export function prIntervalsFromCapture({ ticket, prNumbers, prs }) {
  const numbers = new Set(prNumbers.filter((n) => n !== undefined));
  const mine = prs.filter(
    (pr) => numbers.has(pr.number) || ticketFromBranch(pr.headRefName).ticket === ticket,
  );
  return {
    intervals: mine.map((pr) => ({ start: pr.createdAt, end: pr.mergedAt ?? Infinity })),
    firstOpenedAt: mine.length === 0 ? undefined : Math.min(...mine.map((pr) => pr.createdAt)),
    prCount: mine.length,
  };
}

/**
 * The same from the ledger's own `pr_opened` / `pr_merged` ticket events. They
 * are written when Volli's publish flow RECORDS the url — usually minutes after
 * the PR was opened, sometimes days (a PR re-discovered on a later publish) —
 * so this is the fallback, not the primary source.
 */
export function prIntervalsFromLedger(events) {
  const byPr = new Map();
  for (const e of events.toSorted((a, b) => a.at - b.at)) {
    if (e.pr === undefined) continue;
    const entry = byPr.get(e.pr) ?? {};
    if (e.kind === "pr_opened" && entry.start === undefined) entry.start = e.at;
    if (e.kind === "pr_merged" && entry.end === undefined) entry.end = e.at;
    byPr.set(e.pr, entry);
  }
  const intervals = [...byPr.values()]
    .filter((e) => e.start !== undefined)
    .map((e) => ({ start: e.start, end: e.end ?? Infinity }));
  return {
    intervals,
    firstOpenedAt: intervals.length === 0 ? undefined : Math.min(...intervals.map((i) => i.start)),
    prCount: intervals.length,
  };
}

/* -------------------------------------------------------------- tool calls */

/**
 * Tool-call durations from one Pi session file's entries, in file order:
 * `{ at, role: "assistant", calls: [{ id, name, command }] }` and
 * `{ at, role: "toolResult", toolCallId }`.
 *
 * Volli runs Pi with `toolExecution: "sequential"`
 * (`packages/agent-runtime/src/pi/runtime.ts`), so the calls of one assistant
 * message run one after another: a call starts when the previous call of its
 * message returned, not when the message was written. Timing every call from
 * the message would count the first call's wait again in each later sibling.
 * Returns `{ calls: [{ name, command, ms, at }], unanswered }`.
 */
export function toolCallDurations(entries) {
  const pending = new Map();
  const calls = [];
  for (const entry of entries) {
    if (entry.role === "assistant") {
      const batch = { lastEnd: entry.at };
      for (const call of entry.calls ?? []) pending.set(call.id, { ...call, batch });
    } else if (entry.role === "toolResult") {
      const call = pending.get(entry.toolCallId);
      if (call === undefined) continue;
      pending.delete(entry.toolCallId);
      const start = call.batch.lastEnd;
      call.batch.lastEnd = Math.max(call.batch.lastEnd, entry.at);
      const ms = entry.at - start;
      if (ms < 0) continue;
      calls.push({ name: call.name, command: call.command, ms, at: entry.at });
    }
  }
  return { calls, unanswered: pending.size };
}

/**
 * Coarse categories for a bash command, so only category aggregates are ever
 * published — never the command. Rules that name a long-running activity match
 * ANYWHERE in the command (`cd x && pnpm test`), in the order listed; the rest
 * match the first word after any leading `cd …`, environment assignments and
 * `timeout N`.
 */
export const BASH_CATEGORIES = [
  "ciWatch",
  "sleepPoll",
  "e2eSmoke",
  "coverage",
  "unitTests",
  "typecheck",
  "lintFormat",
  "build",
  "install",
  "nativeRebuild",
  "search",
  "find",
  "gitNetwork",
  "gitLocal",
  "ghOther",
  "fileRead",
  "nodeOther",
  "other",
];

const BASH_ANYWHERE = [
  [/\bgh\s+pr\s+checks\b[^\n]*--watch|\bgh\s+run\s+watch\b/, "ciWatch"],
  [/\bsleep\s+\d/, "sleepPoll"],
  [/run-smokes|-smoke\.mjs|\bsmoke:|\bplaywright\b|\be2e\b/, "e2eSmoke"],
  [/test:coverage|--coverage\b/, "coverage"],
  [/\b(vitest|jest)\b|\b(pnpm|npm|yarn|bun|vp)\b[^;&|\n]*\btest\b/, "unitTests"],
  [/\btypecheck\b|\btsc\b/, "typecheck"],
  [/\bvp\s+(check|fmt|lint)\b|\boxlint\b|\beslint\b|\bprettier\b|\boxfmt\b/, "lintFormat"],
  [/\b(pnpm|npm|vp)\b[^;&|\n]*\bbuild\b|electron-builder|\bvite\s+build\b/, "build"],
  [/\b(pnpm|npm|yarn|bun|vp)\s+(install|i|add)\b/, "install"],
  [/rebuild:native|electron-rebuild/, "nativeRebuild"],
];

const BASH_LEADING = [
  [/^(rg|grep|egrep|ag|ack)\b|^git\s+grep\b/, "search"],
  [/^(find|fd|tree|du)\b|^ls\s+-\w*R/, "find"],
  [/^git\s+(fetch|pull|push|clone|ls-remote)\b/, "gitNetwork"],
  [/^git\b/, "gitLocal"],
  [/^gh\b/, "ghOther"],
  [/^(sed|cat|head|tail|wc|nl|awk|less|jq|diff|ls|stat|file)\b/, "fileRead"],
  [/^(node|pnpm|npx|vp|npm|tsx|bun|yarn)\b/, "nodeOther"],
];

export function classifyBashCommand(command) {
  const text = typeof command === "string" ? command : "";
  for (const [pattern, category] of BASH_ANYWHERE) if (pattern.test(text)) return category;
  const head = text
    .replace(/^\s*(cd\s+[^;&\n]+(&&|;)\s*)+/, "")
    .replace(/^\s*([A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, "")
    .replace(/^\s*timeout\s+\S+\s+/, "")
    .trim();
  for (const [pattern, category] of BASH_LEADING) if (pattern.test(head)) return category;
  return "other";
}

/**
 * Tool names published as themselves: the runtime's own built-in tools, named
 * in this repository's code. Anything else — an MCP server's tool, a name this
 * list does not know — folds into `mcpTool` or `otherTool`, so a tool name
 * chosen outside this repository never reaches a published file.
 */
export const KNOWN_TOOL_NAMES = new Set([
  "read",
  "edit",
  "write",
  "todo_write",
  "shell_start",
  "shell_output",
  "shell_kill",
  "web_fetch",
  "web_search",
  "ask_user",
  "ticket_await",
  "session_start",
  "session_send",
  "session_await",
  "session_stop",
  "session_delegate",
  "browser_act",
  "browser_acquire",
  "browser_console",
  "browser_navigate",
  "browser_release",
  "browser_screenshot",
  "browser_snapshot",
  "browser_tabs",
  "automation_run",
]);

/** The published category of one tool call: `bash:<category>` or a known tool name. */
export function toolCallCategory(name, command) {
  if (name === "bash") return `bash:${classifyBashCommand(command)}`;
  if (KNOWN_TOOL_NAMES.has(name)) return name;
  if (typeof name === "string" && name.startsWith("mcp")) return "mcpTool";
  return "otherTool";
}

/**
 * What the executor was doing during its in-turn silences: milliseconds of
 * silence during which a tool call of each category was in flight in the SAME
 * Session, and the remainder with no tool in flight — the model or the
 * transport, which Pi's files cannot tell apart. `toolIntervals` are one
 * Session's `{ start, end, category }`; sequential execution keeps them
 * disjoint, and where a malformed file makes two overlap the earlier-starting
 * call keeps the overlap, so nothing is counted twice.
 */
export function attributeSilences(silences, toolIntervals) {
  const tools = toolIntervals.toSorted((a, b) => a.start - b.start);
  const byTool = {};
  let noTool = 0;
  for (const silence of silences) {
    let cursor = silence.start;
    for (const tool of tools) {
      if (tool.end <= cursor) continue;
      if (tool.start >= silence.end) break;
      const from = Math.max(cursor, tool.start);
      const to = Math.min(silence.end, tool.end);
      if (from > cursor) noTool += from - cursor;
      if (to > from) byTool[tool.category] = (byTool[tool.category] ?? 0) + (to - from);
      cursor = Math.max(cursor, to);
    }
    if (silence.end > cursor) noTool += silence.end - cursor;
  }
  return { byTool, noTool };
}

/** Calls, hours and duration quantiles per key. Quantiles in seconds, type 7. */
export function summariseDurations(calls, keyOf, { longMs = 5 * MINUTE_MS } = {}) {
  const groups = new Map();
  for (const call of calls) {
    const key = keyOf(call);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(call.ms);
  }
  const out = {};
  for (const [key, list] of [...groups].toSorted((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const sorted = list.toSorted((a, b) => a - b);
    const long = sorted.filter((ms) => ms >= longMs);
    out[key] = {
      calls: sorted.length,
      hours: sorted.reduce((a, b) => a + b, 0) / 3_600_000,
      p50Seconds: quantile(sorted, 0.5) / 1000,
      p90Seconds: quantile(sorted, 0.9) / 1000,
      p99Seconds: quantile(sorted, 0.99) / 1000,
      callsOverFiveMinutes: long.length,
      hoursOverFiveMinutes: long.reduce((a, b) => a + b, 0) / 3_600_000,
    };
  }
  return out;
}
