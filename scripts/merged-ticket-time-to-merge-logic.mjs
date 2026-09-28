/**
 * The rules behind `scripts/merged-ticket-time-to-merge.mjs` (VC-443): how a
 * merge is recognised in git history, how a merge is linked to a ticket, how a
 * ticket's Sessions are attributed, and the statistics over the elapsed times
 * that result.
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
      linkKinds: [...new Set(sorted.map((m) => m.kind))].toSorted(),
      sessionCount: facts.sessionCount,
      messagedSessionCount: facts.messagedSessionCount,
      inheritedSessionCount: facts.inheritedSessionCount,
      silentLeadingSessions: facts.silentLeadingSessions,
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
