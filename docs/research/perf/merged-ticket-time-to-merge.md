# How long a merged ticket takes, first Session message to final merge (VC-443)

For tickets that actually **merged**, this measures the elapsed calendar time
from the first message of their earliest associated Session to the merge that
completed them, and then splits that time into where it went. Merged tickets
only: a `done` column, an archived worktree and a `pr_url` are each set by hand
and none of them proves a merge landed, so none of them admits a ticket to this
cohort.

**Median 6.5 hours** (95% CI 4.4–7.9), **p90 44.5 hours**, over **227 of 234
merged tickets (97.0% coverage)**. Of the cohort's 4,324 ticket-hours, **9%** had
an agent producing, **4%** an agent silent inside a turn, **5%** a runtime
failure nobody had yet resumed, and **82%** was the ticket waiting on people,
review, or its turn in the queue.

Harness: `scripts/merged-ticket-time-to-merge.mjs`, with its rules and their
tests in `scripts/merged-ticket-time-to-merge-logic.mjs`; the breakdown is
assembled by `scripts/merged-ticket-time-breakdown.mjs` in the same run.
Aggregates and per-ticket audit rows: `merged-ticket-time-to-merge/aggregates.json`
and `merged-ticket-time-to-merge/tickets.csv` beside this file.

> This is a ticket-level end-to-end completion measurement. It is not VC-441's
> turn-level critical path, VC-318's resource matrix, or VC-366's process
> topology, and it shares no fixture with them.

## Snapshot

| | |
| --- | --- |
| Data snapshot taken | 2026-09-28 21:03 UTC |
| Merge history read | `1ecfac17` (passed as `--ref 1ecfac17`), 531 first-parent commits |
| Analysis run from checkout | `b6cd02c8` (this ticket's branch; not the history it read) |
| Ledger | the desktop app's live SQLite database, opened read-only |
| Ledger events considered | 4,943 `session.input.recorded` events; `occurred_at` vs `recorded_at` max skew **1 ms** |
| PR open times | one `gh pr list` capture, 2026-09-28 20:38 UTC, 481 merged PRs |
| Tool durations | 1,086 Pi session files belonging to cohort Sessions, read-only |
| Merge window in cohort | 2026-08-15 → 2026-09-28 |
| Project | `VC`, 449 tickets at snapshot time |

The first run read `origin/main` from a ticket worktree 71 commits behind
`main`: reading that worktree's stale local `main` would have truncated the
cohort at the branch point and dropped the most recent merges — a survivorship
bias introduced by the tool rather than by the data. `origin/main` has since
moved on, so this regeneration pins the history with `--ref 1ecfac17`, the
commit the first run recorded. Every cohort row and statistic reproduced
byte-identically.

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

**End — the final merge.** The committer date of the commit on `main`'s
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
the first-parent walk of `main` has already established that the commit is on
`main`. Both forms are pinned by the self-test.

## Coverage, and every exclusion

| | Tickets |
| --- | --- |
| In project `VC` (at snapshot time) | 449 |
| Marked `done` | 333 |
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

The other 215 tickets have no merge evidence this measurement will accept. That
number is not "unfinished work": it includes 106 tickets **marked `done` that are
not in the cohort** — work that merged inside a wave or non-ticket-branch PR, or
was closed without its own merge. This is exactly why `done` is never read as
merge evidence.

The project total, the `done` count and this not-merged count grow simply
because the board is live — tickets filed after the first run moved them from
444, 332 and 210. The cohort, the coverage ratio and every statistic below are
fixed by the merge history at `1ecfac17` and did not move across repeated runs.

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
| Start at the ticket's **first move to Doing** (the tickets that have one) | 184 | 4.28 | 13.00 | 28.14 |
| Primary clock over those same 184 tickets | 184 | 5.29 | 17.17 | 35.36 |

None of the first three judgement calls moves the headline. Only 5 cohort
tickets merged more than once (VC-11, VC-24, VC-7, VC-64, VC-204), so
first-versus-final changes the mean by 0.09 h and the median not at all. The
start definition is unanimous: for all 227 tickets the earliest associated
Session's first message *is* the earliest message anywhere in the ticket's
Sessions — 0 disagreements — which is the expected consequence of a delegated
child never preceding its parent, confirmed here rather than assumed. 16 of the
19 subject-only merges are corroborated by the merged side's own commits
mentioning the same ticket; they still stay out of the primary cohort.

**The second clock** starts at the ticket's first move to Doing (`ticket_events`
`status_changed` to `doing`, or created there). 43 cohort tickets never
recorded Doing before their merge and are excluded from it. Of the other 184,
84 reached Doing at the first message itself (median lead 0.00 h) and 100
reached it later (median 0.27 h after). Over the same tickets the Doing clock's
median is 1.0 h shorter than the primary clock's: the difference is conversation
that happened while the ticket was still in Todo or Backlog, not a different
picture of the work.

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
also a proxy for how large and how contested the work was. The month difference
is not noise to wave away: September's median doubled and its mean more than
doubled, and the breakdown below shows which categories grew. It is still
descriptive — two months of one moving project, with a different ticket mix and
more work running in parallel — not a trend and not a cause.

## Where the time went

The headline is one interval per ticket. The breakdown splits every cohort
window into six **mutually exclusive** categories, from the ledger's own Session
events. A ticket often has several Sessions at once, so each instant is counted
under the first category that holds, in this priority order — most progressed
first, so a ticket with any Session producing counts as worked on, whatever a
sibling was doing:

| # | Category | An instant counts here when |
| --- | --- | --- |
| 1 | **Working** | a turn is open, no question to the user is pending, and the executor wrote to the ledger less than 5 minutes ago |
| 2 | **Silent in turn** | a turn is open, nothing is pending on the user, and the gap between two executor writes is ≥ 5 minutes — the whole gap counts |
| 3 | **Asking the user** | an interaction (a question or a permission) is open and unanswered |
| 4 | **Failure-blocked** | a runtime failure Attention has been raised, and neither a new message, a retry, a surviving turn's completion, a stop, the Attention's clearing, nor any input to any of the ticket's Sessions has yet followed |
| 5 | **PR open, nothing running** | a pull request for the ticket is open |
| 6 | **Idle** | none of the above |

"Executor wrote" means any ledger event except the user's own inputs and
commands, their receipts, lifecycle bookkeeping and signals — the watchdog's own
`blocked` signal included, so a silence cannot be ended by the report of it.
Where two Sessions of one ticket are failure-blocked at once, the instant belongs
to the failure raised first, so failure time is never counted twice and its
per-class hours sum exactly to the category.

| Category | Hours | Share | ≤ 24 h tickets | > 24 h tickets |
| --- | --- | --- | --- | --- |
| Working | 375.3 | 8.7% | 21.2% | 4.1% |
| Silent in turn | 191.2 | 4.4% | 10.1% | 2.4% |
| Asking the user | 138.8 | 3.2% | 7.4% | 1.7% |
| Failure-blocked | 201.0 | 4.6% | 6.6% | 3.9% |
| PR open, nothing running | 594.9 | 13.8% | 10.7% | 14.9% |
| Idle | 2,823.1 | 65.3% | 44.0% | 73.0% |
| **Window total** | **4,324.3** | 227 tickets | 183 tickets, 27% of hours | 44 tickets, 73% of hours |

**Reading.**

- **Process holds the time, not execution.** Idle, PR waiting and questions to
  the user are 3,557 h (82%). Agents producing or running a tool are 566 h
  (13%). Failures nobody had yet resumed are 201 h (5%). The 44 tickets over a
  day hold 73% of all hours, and 88% of theirs is idle or PR waiting.
- **Idle is mostly the queue.** For 2,050 of the 2,823 idle hours (73%) another
  Session on the machine had a turn open: the ticket was waiting while other
  work ran. By the ticket's status at the time: Todo 864 h (125 tickets), Doing
  805 h (143), `done` 424 h (7 tickets marked done before their final merge
  landed), Needs Review 407 h (97), Backlog 323 h (26).
- **PR open → final merge** is short: median 0.39 h, p75 2.2 h, p90 8.7 h over
  the 220 tickets with a PR opened before their final merge. The 595 h of PR waiting is a tail,
  concentrated in the long tickets.
- **Failure-blocked, 201 h, is three-quarters external.** Transient network
  96.5 h and quota or rate limits 49.9 h dominate; content-policy refusals
  1.5 h and auth 0.8 h. Volli's own share is 52.4 h: a turn lost to an app
  restart 19.9 h, the browser host not ready on recovery 15.1 h, requests the
  provider rejected as built (image dimensions, request size, a missing routing
  header, a client-version gate) 12.5 h, worktree preparation 4.9 h. External
  causes are still Volli's to recover from: a transient failure blocks only
  because nothing retried it. 190 failure blocks began inside cohort windows;
  80 tickets had at least one. Blocks ended by a new message or retry
  (107.6 h) or by input elsewhere in the ticket (87.4 h); 6.0 h ran to the
  merge with no one resuming.
- **Silence is mostly tools running.** 820 in-turn silences of ≥ 5 min held
  217 h, and in 179 h of them the same Session had a tool call in flight:
  sleep-polling loops 61.5 h, `ticket_await` 30.0 h, one browser screenshot
  20.1 h, coverage 18.3 h, `gh … --watch` 16.4 h, unit tests 15.4 h, e2e
  smokes 9.1 h, `session_await` 4.7 h. 794 of the 820 (97%) ended with the
  executor writing again on its own. The watchdog tripped on 166 of them, and
  150 of those resumed on their own — the false positives the watchdog change
  below removes. The 25 silences that ended in a failure hold 34.6 h: one
  25.1-hour silence that ended only when a relaunched app recovered the turn,
  12 transient-network timeouts (5.9 h) and 12 browser-host failures (3.6 h).

**August against September**, hours per ticket by merge month:

| Per ticket (h) | 2026-08 (n = 128) | 2026-09 (n = 99) | Change |
| --- | --- | --- | --- |
| Elapsed | 12.30 | 27.77 | +15.47 |
| Working | 1.41 | 1.97 | +0.56 |
| Silent in turn | 0.08 | 1.82 | +1.74 |
| Asking the user | 0.45 | 0.82 | +0.37 |
| Failure-blocked | 0.22 | 1.74 | +1.52 |
| PR open, nothing running | 1.38 | 4.23 | +2.85 |
| Idle | 8.75 | 17.20 | +8.45 |
| Tickets with any failure block | 23 (18%) | 57 (58%) | |

Most of September's extra 15.5 h per ticket is waiting — idle +8.5 h, PR
+2.9 h — but the execution-side categories grew far faster: failure-blocked
eightfold and in-turn silence more than twentyfold. September's failure time per
ticket was transient network 0.71 h, quota 0.50 h, app restart 0.20 h, browser
host 0.15 h and rejected requests 0.12 h; August's was almost entirely transient
network (0.20 h). The silence growth tracks tool use: per ticket, sleep polling
rose from 0.13 to 0.68 h and `ticket_await` from 0.01 to 0.33 h. Descriptive, not
causal — September's tickets were also larger, more delegated and more parallel.

**What this cannot see.** The ledger records structured (Pi) Sessions. Work in a
terminal companion, an editor, or a review read outside Volli is invisible and
lands in idle; every cohort ticket has at least one turn in its window, which
proves the ledger saw some of its work, not all of it. "Another Session had a
turn open" is the machine being busy, not proof of where the operator's
attention was. An app closed mid-turn leaves the turn open until relaunch —
the likeliest reading of the one 25-hour silence. The failure-block end rule is a reading of
"until someone resumed it"; the 6 h that ran unresumed to the merge are the part
it is least sure of.

### Sensitivity of the breakdown

| Variant | Working | Silent | Asking | Failure | PR open | Idle |
| --- | --- | --- | --- | --- | --- | --- |
| Silence threshold 2 min | 318.9 | 247.6 | 138.8 | 201.0 | 594.9 | 2,823.1 |
| **Silence threshold 5 min (primary)** | **375.3** | **191.2** | **138.8** | **201.0** | **594.9** | **2,823.1** |
| Silence threshold 10 min | 426.7 | 139.8 | 138.8 | 201.0 | 594.9 | 2,823.1 |
| PR open from the ledger's `pr_opened` | 375.3 | 191.2 | 138.8 | 201.0 | 499.6 | 2,918.5 |

The threshold only moves time between working and silent; together they are
566.5 h at every setting.

**PR open times** come from a `gh pr list` capture passed as `--prs`, because
the harness itself never touches the network. A PR is the ticket's when its head
branch names the ticket or its number is the ticket's ledger PR or merge PR; it
is open from `createdAt` to `mergedAt`. The capture lists merged PRs only, so a
PR closed unmerged and replaced does not count as open, and a draft counts as
open. The ledger's own `pr_opened` events are the fallback: they are written
when Volli's publish flow records the url — a median 2.3 min after the PR was
opened but 4.4 days at p90 (a PR re-discovered on a later publish) — and 15 fewer
cohort tickets have one. Using them moves 95 h from PR waiting to idle.

## Tool-call durations (Pi session files)

A separate source from the ledger, read to explain the silences. Pi's own
session files for the cohort's Sessions, calls that returned inside the ticket's
window: 1,086 files, 106,758 calls, 473.6 h. Volli runs Pi's tools
sequentially, so a call is timed from the previous call of its message
returning, not from the message itself — otherwise the first call's wait would
be counted again in each later sibling. Pi changed storage format in September
(entries batched in arrays, the Session id in an identity record); both are
read, and a reader that knew only the August format would have missed 440 of
the 1,086. Bash commands are classified into coarse categories in memory
and dropped; only the categories are published.

| Tool or bash category | Calls | Hours | p50 s | p90 s | Calls ≥ 5 min | Hours in them |
| --- | --- | --- | --- | --- | --- | --- |
| `ask_user` | 264 | 137.5 | 145.6 | 2,071.4 | 85 | 132.7 |
| bash: sleep polling | 1,303 | 83.7 | 89.7 | 500.9 | 298 | 61.5 |
| bash: unit tests | 6,810 | 52.8 | 5.0 | 63.1 | 93 | 15.4 |
| bash: coverage | 2,317 | 48.9 | 33.6 | 166.8 | 105 | 18.3 |
| `ticket_await` | 210 | 33.5 | 128.1 | 1,500.1 | 69 | 30.0 |
| bash: e2e smokes | 5,418 | 25.7 | 0.3 | 35.7 | 37 | 9.1 |
| bash: `gh … --watch` | 241 | 22.0 | 300.2 | 555.1 | 122 | 16.4 |
| `browser_screenshot` | 179 | 20.4 | 0.3 | 15.2 | 1 | 20.1 |
| `session_await` | 188 | 8.9 | 121.9 | 352.0 | 33 | 4.7 |
| `session_start` | 160 | 7.7 | 0.8 | 2.5 | 3 | 7.6 |
| bash: typecheck | 2,875 | 6.9 | 5.3 | 18.5 | 0 | 0 |
| bash: search (`rg`, `grep`) | 13,223 | 2.5 | 0.1 | 0.6 | 1 | 0.4 |

Waiting holds most tool time: asking the user, sleep polling, awaiting other
Sessions and watching CI are 286 h (60%); tests, coverage, e2e and typecheck
are 134 h (28%). The one screenshot call that held 20.1 h returned on
2026-09-03, before VC-252 and VC-278 reworked browser-tool timeouts and capture.
Search is cheap and stayed so inside ticket worktrees: p99 6.6 s in August and
11.2 s in September, `find` 50.6 s and 40.3 s. Tool hours overlap each other
across Sessions and overlap the breakdown's categories (`ask_user` is most of
"asking the user"), so they do not add to the table above.

## What changed because of this

- **Session watchdog, tool-aware and sleep-aware** — in the same change. 150 of the 166 silences it tripped on resumed on their own. A
  wait on another Session or the user (`ticket_await`, `session_await`,
  `ask_user`) now never trips it; bash trips past its own declared timeout plus
  two minutes; any other tool past a one-hour ceiling; with no tool in flight
  the ten-minute rule is unchanged. Time the machine spent asleep no longer
  counts as silence.
- **Transient failures retried, across sleep and lost networks** — in the same
  change. The 96.5 h of transient-network blocking was failures
  nothing retried: `Request timed out.`, `Connection error.`, a bare
  `terminated`, `Overloaded`, gateway 5xx pages and throttling 429s were not
  recognised as transport, and a ten-attempt budget assumed the network returned
  within a minute. They now retry; offline, the turn waits for the network
  without spending its budget, and a provider stream silent for nine minutes, or
  fifteen seconds after wake, is cut and retried rather than hung. The wait shows
  as "Reconnecting" and the watchdog stands down on it.
- **Every outgoing image made legal for its model** — in the same change. The image-dimension and request-size rejections in the 12.5 h of
  rejected requests came from browser screenshots, MCP images and attachments
  reaching the provider unbounded. One send-time guard now fits each image to the
  model's catalog limits and keeps the request's image bytes in budget, oldest
  images first to go. The client-version gate in the same bucket was already
  fixed on `main` by the Pi 0.87.1 upgrade.
- **Worktree adopts a same-ticket branch** — in the same change. The
  4.9 h of worktree-preparation failures were one refusal: an agent had cut a
  narrower branch inside its own ticket's worktree, and every later Session start
  failed. A branch at the ticket's path with the same display id is now adopted.
- **Resume at a quota reset, on request** — in the same change. The 49.9 h of
  quota blocking waited for someone to notice the reset had passed. When a turn
  stops on a spent allowance whose reset can be read without guessing, the stop
  row offers **Resume at <time>** beside Retry; nothing is scheduled unless the
  person chooses it. At the reset the turn resumes through the existing retry
  path, unless this Session was acted on since or another Session on the same
  ticket has moved on, in which case the resume is skipped and says why. Quota
  still needs a person's decision; it just no longer needs them present.
- **Already fixed, or filed.** The 15.1 h of "Browser host not ready" all
  predates VC-367, which fixed boot-recovery ordering on 2026-09-14; the last
  occurrence was 1.5 h before it merged. The 19.9 h of turns stranded by an app
  exit is VC-450: VC-367 made those Sessions recoverable, but nothing resumes
  them.

## What this number is not

- **Merged-only, so survivorship bias is structural.** Every ticket that was
  abandoned, superseded, or is still open contributes nothing. 215 tickets have
  no accepted merge evidence, 106 of them marked `done`. This is the time merged
  work took, **not** the time an attempted task takes, and it cannot be used as
  an estimate for a task that has not merged yet.
- **Calendar time, as asked.** Nights, weekends, review waits, and time spent on
  other tickets are all inside the interval. It is not active-agent time, not
  billed time, and not a measure of agent throughput; the breakdown is the
  closest this gets to either.
- **Parallelism is invisible in the headline.** Several tickets ran at once on
  one machine, so these intervals overlap each other and do not sum to elapsed
  project time. The breakdown's "another Session had a turn open" is where it
  shows.
- **Earlier work before a ticket Session is not counted.** Planning that happened
  in a board Session before the ticket's own Session existed is outside the
  start definition.
- **Merge clocks are committer clocks** from the machine that made the merge
  commit. The ledger's own clocks agree with themselves to within 1 ms; a
  handful of command receipts carry an `occurred_at` a few seconds before the
  event sequenced ahead of them, and the breakdown follows sequence order.
- **One project, one machine, one operator.** Nothing here generalises beyond
  this repository's history.

## Reproduction

Read-only. Opens the live ledger with SQLite's `readonly` flag, reads git
history and Pi's session files, and launches no inference and no workload — it
cannot cost a token and does not touch app settings, profiles, or live Sessions.
The one network step is the PR capture, taken once and kept out of the
repository because it carries times of day:

```
gh pr list --state merged --limit 1000 --json number,createdAt,mergedAt,headRefName > prs.json
node scripts/merged-ticket-time-to-merge.mjs --ref 1ecfac17 --prs prs.json \
  --prs-captured-at 2026-09-28T20:38:42Z --write   # refresh the data files
node scripts/merged-ticket-time-to-merge.mjs --self-test
```

Defaults: `--db "$HOME/Library/Application Support/Volli Code/volli.db"` (the
packaged app's `userData`), `--pi-sessions` beside it, `--ref origin/main`,
`--prefix VC`, `--silence-minutes 5`. Without `--prs` the breakdown falls back
to the ledger's `pr_opened` events and records that it did; `--no-breakdown`
skips it. Every number here is from `--ref 1ecfac17`; the default
`origin/main`, or a later ledger, will legitimately produce a larger cohort.

Regenerating against `1ecfac17` reproduced the first run exactly: every cohort
row, statistic, interval and stratum was byte-identical, and the breakdown was
identical across repeated runs. The only fields that moved were the snapshot's
own wall clock and checkout, and the live counters named under Coverage — the
database is the **live** one, so Sessions running during the analysis
(including the ones that wrote this report) keep adding events. Those counters
are witnesses of the read, not inputs to any statistic. The bootstrap is
seeded, so its intervals are reproducible rather than merely stable.

`--self-test` runs the recognisers, the Session attribution, the cohort rules,
the statistics, the breakdown rules and the output-privacy rules against
fixtures, with no ledger and no repository history needed; `pnpm run
check:merged-ticket-time` is the same gate. It pins, among other things, that a
merge *into* a ticket branch is not that ticket merging, that a `done` ticket
with no merge commit stays out, that the end timestamp is the last merge, that a
never-messaged Session cannot set the start, that the categories partition each
window exactly, that concurrent failures are not counted twice, that the
watchdog's own signal does not end a silence, that sequential tool calls are
timed from their predecessor, that both Pi storage formats are read, and that no
command, path, Session id, clock or time of day reaches the published files.

Three cohort rows were also verified by hand against the ledger and `git log`
independently of the harness: VC-428 (0.729 h), VC-421 (12.072 h) and VC-204
(68.998 h, two merges) each reproduce to the published precision.

### What the artifacts contain

`aggregates.json` carries the snapshot metadata, the recogniser and link audits,
coverage with every exclusion reason, the full statistics, the sensitivity
variants, the histogram and ECDF, the strata, and under `breakdown` the category
definitions, totals, failure classes, idle by status, the month and elapsed-band
comparisons, both sensitivity rows, the silence analysis, the second clock, and
the tool-duration aggregates. `tickets.csv` carries one row per cohort ticket for
audit: ticket id, PR number, merge **date** (UTC), elapsed hours, first-merge
elapsed hours, merge count, Session counts, hours in each breakdown category, and
the Doing-clock hours.

No message text, prompt, title, command line, credential or filesystem path is
written to either file. Two things are read only to be classified and dropped: a
failure Attention's detail text, reduced to a failure class, and a bash
command, reduced to a category. Tool names are published only for Volli's own
built-in tools. Ticket ids and PR numbers are public references in this
repository's own history. Start timestamps and Session ids are deliberately
**not** published, and no Session event's time of day appears in the data files —
the only instants are the analysis's own snapshot and capture times — so the
artifacts cannot be read as a log of when someone was at their desk; the
full-precision intervals survive only as aggregates.
