# How long a merged ticket takes, first Session message to final merge (VC-443)

For tickets that actually **merged**, this measures the elapsed calendar time
from the first message of their earliest associated Session to the merge that
completed them. Merged tickets only: a `done` column, an archived worktree and a
`pr_url` are each set by hand and none of them proves a merge landed, so none of
them admits a ticket to this cohort.

**Median 6.5 hours** (95% CI 4.4–7.9), **p90 44.5 hours**, over **227 of 234
merged tickets (97.0% coverage)**.

Harness: `scripts/merged-ticket-time-to-merge.mjs`, with its rules and their
tests in `scripts/merged-ticket-time-to-merge-logic.mjs`. Aggregates and
per-ticket audit rows: `merged-ticket-time-to-merge/aggregates.json` and
`merged-ticket-time-to-merge/tickets.csv` beside this file.

> This is a ticket-level end-to-end completion measurement. It is not VC-441's
> turn-level critical path, VC-318's resource matrix, or VC-366's process
> topology, and it shares no fixture with them.

## Snapshot

| | |
| --- | --- |
| Data snapshot taken | 2026-09-28 19:04 UTC |
| Merge history read | `origin/main` @ `1ecfac17`, 531 first-parent commits |
| Analysis run from checkout | `349f3d2d` (this ticket's worktree; not the history it read) |
| Ledger | the desktop app's live SQLite database, opened read-only |
| Ledger events considered | 4,889 `session.input.recorded` events; `occurred_at` vs `recorded_at` max skew **1 ms** |
| Merge window in cohort | 2026-08-15 → 2026-09-28 |
| Project | `VC`, 444 tickets at snapshot time |

The worktree this ran from was 71 commits behind `main` while the analysis ran,
so the harness reads `origin/main` by default rather than a ticket branch's stale
local `main`. Reading the stale ref would have truncated the cohort at the branch
point and dropped the most recent merges — a survivorship bias introduced by the
tool rather than by the data. Both commits are recorded above and in the JSON.

## What the two timestamps are

**Start — the first message of the earliest associated Session.** Not ticket
creation, not worktree creation, not Session creation. The ledger's own
`session.input.recorded` event is "a message was submitted to this Session"
(`packages/shared/src/session-ledger.ts`); the harness reads its clock and never
its payload. A ticket's associated Sessions are those the ledger links to it,
plus delegated children reached through `parent_session_id`. Of the cohort's
1,102 Sessions, **0** needed the parent walk — every subagent of a ticket Session
carries the ticket id directly — and all 58 ledger Sessions that do need it
descend from **board** Sessions, which belong to no ticket. One cohort ticket had
a Session created before the first one that ever received a message; a Session
that never received a message cannot set the start.

**End — the final merge.** The committer date of the commit on `origin/main`'s
first-parent walk that brought the work in. The first-parent walk is exactly the
sequence of integration events on the branch, so each date is when `main` gained
that work, recorded in the repository rather than fetched from a forge. Where a
task shipped across several PRs the **latest** merge is the completion time; the
first-merge alternative is quantified below.

### How a merge is linked to a ticket

A ticket enters the primary cohort only on **strong** evidence — the merge itself
names the ticket's branch, or its PR number is the PR the ledger recorded on that
ticket:

| Evidence | Merges | Strength |
| --- | --- | --- |
| PR merge commit from a `volli/<TICKET>-…` branch | 212 | strong |
| Local merge of a ticket branch into the integration branch | 9 | strong |
| Squashed PR whose number matches the ticket's ledger `pr_url` | 19 | strong |
| Merge commit naming a ticket only in its subject | 19 | subject-only — **extended cohort** |

The two strong link sources are independent — a branch name written when the
branch was created, a PR url written on the ticket — and where both spoke they
**agreed 186 times and disagreed 0 times**. 26 branch-linked merges had no ledger
PR url to check against. 6 merges came from a branch whose slug had drifted from
the ledger's (a renamed ticket, a recreated branch); the ticket id matched in all
6, which is why the link is made on the id and not the slug. No merge named a
ticket the ledger does not have, and no branch name was ambiguous between two
tickets.

Two directions were deliberately rejected. `Merge remote-tracking branch
'origin/main' into volli/VC-349-…` is an integration merge *into* a ticket
branch: it names a ticket and proves nothing about that ticket merging, so the
merge direction is checked and it is dropped. It is one of the 3 merges
classified as integration rather than ticket work, the other two being
`Merge remote-tracking branch 'origin/main'` and `Merge branch 'main' into
tmp/publish-main`, neither of which names a ticket. A squashed commit carrying a
PR number that no ticket claims is reported unlinked rather than attributed by
its subject (65 such).

One parse detail is load-bearing: git writes `Merge branch 'X' into <target>`
only when the merge was not made on the default branch, so 5 of the 9 local
ticket-branch merges read simply `Merge branch 'volli/VC-13-…'` with no target at
all. An absent target is treated as the integration branch — sound here because
the first-parent walk of `origin/main` has already established that the commit
is on `main`. Both forms are pinned by the self-test.

## Coverage, and every exclusion

| | Tickets |
| --- | --- |
| In project `VC` (at snapshot time) | 444 |
| Marked `done` | 332 |
| **With strong merge evidence** (the denominator) | **234** |
| **Measured — primary cohort** | **227 (97.0%)** |
| Excluded: merged, but no Session in the ledger | 6 |
| Excluded: merged, Session exists, no message ever recorded | 1 |
| Excluded: merge earlier than first message | 0 |
| With any merge evidence including subject-only | 253 |
| Extended cohort (adds subject-only links) | 246 |

The 7 exclusions are named in `aggregates.json` under
`coverage.excludedTickets`: VC-107, VC-144, VC-147, VC-370, VC-375 and VC-386
have merged ticket branches and **zero** Sessions in this ledger; VC-26 has one
Session that never recorded a message. They are ledger gaps, not measurement
failures, and they are omitted rather than guessed at.

The other 210 tickets have no merge evidence this measurement will accept. That
number is not "unfinished work": it includes 105 tickets **marked `done` that are
not in the cohort** — work that merged inside a wave or non-ticket-branch PR, or
was closed without its own merge. This is exactly why `done` is never read as
merge evidence.

The project total and this not-merged count are the two figures here that grow
simply because the board is live — a ticket filed during the analysis lands in
both. The cohort, the coverage ratio and every statistic below are fixed by the
merge history at `1ecfac17` and did not move across repeated runs.

**Outside the unit of analysis:** 147 PR merges came from branches that name no
ticket (`ui/…`, `wave/…`, website work — 42 in July, 97 in August, 8 in
September). They are real merges of real work, but not ticket-scoped, so no
ticket-level duration exists for them. The ledger's own history begins
2026-08-14, so nothing merged before that could have been measured at all.

## Elapsed calendar time

Hours. Quantiles by linear interpolation between order statistics (R type 7, the
numpy/Excel default); intervals are seeded percentile bootstraps, 10,000
resamples.

| | Hours |
| --- | --- |
| n | 227 |
| min | 0.40 |
| p25 | 2.03 |
| **median** | **6.51**  (95% CI 4.42 – 7.93) |
| p75 | 17.69 |
| p90 | 44.52 |
| p95 | 86.91 |
| max | 345.93 |
| mean | 19.05  (95% CI 14.46 – 24.12) |
| 10% trimmed mean | 10.01 |

The mean is nearly three times the median: the distribution is strongly
right-skewed, a handful of tickets sat open for days, and the mean is reported
because it was asked for, not because it describes a typical ticket. The trimmed
mean is a supplement to the median, never a replacement for it.

### Distribution

| Bucket | Tickets | Share |
| --- | --- | --- |
| 0–1 h | 24 | 10.6% |
| 1–2 h | 32 | 14.1% |
| 2–4 h | 38 | 16.7% |
| 4–8 h | 35 | 15.4% |
| 8–16 h | 37 | 16.3% |
| 16–24 h | 17 | 7.5% |
| 24–48 h | 22 | 9.7% |
| 48–96 h | 14 | 6.2% |
| 96–168 h | 5 | 2.2% |
| ≥ 168 h | 3 | 1.3% |

Empirical CDF — the share of merged tickets that merged within each elapsed time:

| Within | 1 h | 2 h | 4 h | 8 h | 12 h | 24 h | 48 h | 72 h | 168 h |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Share | 10.6% | 24.7% | 41.4% | 56.8% | 66.1% | 80.6% | 90.3% | 92.1% | 98.7% |

### Sensitivity to every judgement call

| Variant | n | Median | Mean | p90 |
| --- | --- | --- | --- | --- |
| **Primary** — final merge, first message of earliest Session | 227 | **6.51** | 19.05 | 44.52 |
| End at **first** merge instead of final | 227 | 6.51 | 18.96 | 44.52 |
| Start at earliest message in **any** associated Session | 227 | 6.51 | 19.05 | 44.52 |
| **Extended** cohort — subject-only links admitted | 246 | 6.85 | 18.56 | 38.01 |

None of the three judgement calls moves the headline. Only 5 cohort tickets
merged more than once (VC-11, VC-24, VC-7, VC-64, VC-204), so first-versus-final
changes the mean by 0.09 h and the median not at all. The start definition is
unanimous: for all 227 tickets the earliest associated Session's first message
*is* the earliest message anywhere in the ticket's Sessions — 0 disagreements —
which is the expected consequence of a delegated child never preceding its
parent, confirmed here rather than assumed. 16 of the 19 subject-only merges are
corroborated by the merged side's own commits mentioning the same ticket; they
still stay out of the primary cohort.

### Strata

Reported only where a stratum holds ≥ 8 tickets; nothing was suppressed at that
threshold. **Descriptive, not causal.**

By merge month (UTC):

| Month | n | p25 | Median | p75 | p90 | Mean |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-08 | 128 | 1.62 | 5.17 | 11.86 | 24.74 | 12.30 |
| 2026-09 | 99 | 2.48 | 10.50 | 26.97 | 77.27 | 27.77 |

By number of associated Sessions:

| Sessions | n | p25 | Median | p75 | p90 | Mean |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 30 | 0.67 | 1.11 | 2.25 | 5.70 | 9.60 |
| 2 | 54 | 1.55 | 4.01 | 9.84 | 16.83 | 6.93 |
| 3–4 | 48 | 2.29 | 7.82 | 18.92 | 69.86 | 22.20 |
| 5+ | 95 | 3.76 | 12.07 | 28.05 | 76.75 | 27.33 |

Session count rises with elapsed time, and the obvious reading — that more
Sessions cause slower tickets — is not available from this data: Session count is
also a proxy for how large and how contested the work was. Only two calendar
months exist in the window, so the August-to-September difference is two
datapoints about a moving project (ticket mix, review rounds, how much ran in
parallel) and not a trend.

## What this number is not

- **Merged-only, so survivorship bias is structural.** Every ticket that was
  abandoned, superseded, or is still open contributes nothing. 209 tickets have
  no accepted merge evidence, 105 of them marked `done`. This is the time merged
  work took, **not** the time an attempted task takes, and it cannot be used as
  an estimate for a task that has not merged yet.
- **Calendar time, as asked.** Nights, weekends, review waits, and time spent on
  other tickets are all inside the interval. It is not active-agent time, not
  billed time, and not a measure of agent throughput.
- **Parallelism is invisible.** Several tickets ran at once on one machine, so
  these intervals overlap each other and do not sum to elapsed project time.
- **Earlier work before a ticket Session is not counted.** Planning that happened
  in a board Session before the ticket's own Session existed is outside the
  start definition.
- **Merge clocks are committer clocks** from the machine that made the merge
  commit. The ledger's own clocks agree with themselves to within 1 ms.
- **One project, one machine, one operator.** Nothing here generalises beyond
  this repository's history.

## Reproduction

Read-only. Opens the live ledger with SQLite's `readonly` flag, reads git
history, and launches no inference and no workload — it cannot cost a token and
does not touch app settings, profiles, or live Sessions.

```
node scripts/merged-ticket-time-to-merge.mjs --print
node scripts/merged-ticket-time-to-merge.mjs --write   # refresh the data files
node scripts/merged-ticket-time-to-merge.mjs --self-test
```

Defaults: `--db "$HOME/Library/Application Support/Volli Code/volli.db"` (the
packaged app's `userData`), `--ref origin/main`, `--prefix VC`. The numbers above
are from `1ecfac17`; a later `origin/main` or a later ledger will legitimately
produce a larger cohort.

Re-running against the same `origin/main` reproduced this artifact exactly: every
cohort row, statistic, interval and stratum was byte-identical across runs. The
only fields that moved were the snapshot's own wall clock and its
`ledgerInputEventsConsidered` counter — the database is the **live** one, so
Sessions running during the analysis (including the one that wrote this report)
keep adding input events. That counter is a witness of the read, not an input to
any statistic. The bootstrap is seeded, so its intervals are reproducible rather
than merely stable.

`--self-test` runs the recognisers, the Session attribution, the cohort rules,
the statistics and the output-privacy rules against fixtures, with no ledger and
no repository history needed; `pnpm run check:merged-ticket-time` is the same
gate. It pins, among other things, that a merge *into* a ticket branch is not
that ticket merging, that a `done` ticket with no merge commit stays out, that
the end timestamp is the last merge, that a never-messaged Session cannot set the
start, and that no start timestamp or time of day reaches the published files.

Three cohort rows were also verified by hand against the ledger and `git log`
independently of the harness: VC-428 (0.729 h), VC-421 (12.072 h) and VC-204
(68.998 h, two merges) each reproduce to the published precision.

### What the artifacts contain

`aggregates.json` carries the snapshot metadata, the recogniser and link audits,
coverage with every exclusion reason, the full statistics, the sensitivity
variants, the histogram and ECDF, and the strata. `tickets.csv` carries one row
per cohort ticket for audit: ticket id, PR number, merge **date** (UTC),
elapsed hours, first-merge elapsed hours, merge count, and Session counts.

No message text, prompt, title, command line, credential or filesystem path is
read from any Session or written to either file. Ticket ids and PR numbers are
public references in this repository's own history. Start timestamps are
deliberately **not** published and no time of day appears anywhere in the data
files, so the artifacts cannot be read as a log of when someone was at their
desk; the full-precision intervals survive only as aggregates.
