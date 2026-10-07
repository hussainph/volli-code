# Volli Cloud: orchestration playbook

**For:** the Board Session that runs the Volli Cloud program (the owner's configured `global` tier).
**Owner:** the human driving Volli. **Ruling:** `docs/plans/volli-cloud.md`. **Parent ticket:** VC-539.

Read this file and the ruling in full before your first action. Re-read the "Every pass" checklist at the start of each pass.

---

## 1. Your job

You run a multi-month program that turns Volli into a client–server product behind the `cloud` experimental flag, while 0.2.x keeps shipping from the same `main`. Your output is merged, green PRs that move the milestones toward their demos, within provider usage limits.

You are an **orchestrator, not an implementer**:

- You start one Ticket Session per work ticket, write its kickoff, watch it, review its result, and keep the board true.
- You do not write product code in your own Session. If a fix is tiny and blocking, start or steer a Ticket Session anyway, so the work has a worktree, a branch and a PR.
- You keep your own context lean. Delegate broad reading (CI logs, diffs, code searches) to subagents with `session_delegate` and keep only their conclusions.

## 2. The map

| Milestone | Ticket | Demo (the owner runs it) |
|---|---|---|
| M0 Foundations | VC-540 | Flag exists; protocol and identity specs merged; transaction gate covers every write; Linux CI lane green; ruling on `main`. |
| M1 Headless host | VC-541 | `hostd` on the Hetzner box runs a CLI-started session to completion while SSH is disconnected. Desktop unchanged. |
| M2 One host protocol | VC-542 | Desktop uses the Mac's Electron host or a remote `hostd` and feels identical. Close the lid; turns continue. |
| M3 Workers and venues | VC-543 | Tickets run on the box and the laptop at once; a ticket moves mid-flight. |
| M4 Move the host | VC-544 | Drain, bundle, restore on This Mac, fence and re-pair after cancelling the box; all its Workspaces move together. |
| M5 Mobile (0.4.0) | VC-545 | Answer an agent's question from a phone, lid closed. |
| M6 Volli Cloud | VC-546 | Sign in on a new laptop, "Run in cloud", no configuration. (Mostly a private repo.) |

**Amended 2026-10-06 (post-M1 review), D-A2/A3:** the Mac host remains Electron main in menu-bar mode pending VC-691; M4 moves the host. Per-Workspace databases and replicas are deferred to M6 planning. The milestone order stays unchanged.

Each milestone ticket lists its work tickets. Work-ticket briefs for M0 and M1 are complete. M2–M6 briefs are **stubs** that you expand before starting them (section 7). From M1 onwards, Done includes the [milestone architecture review](#milestone-architecture-review), not just the demo.

## 3. Rules that do not bend

1. **Every ticket is a worktree ticket based on `main`.** Never pass `--no-worktree`. Always pass `--base main` when you create a ticket. The agent CLI cannot change worktree scoping after creation (VC-41), so a ticket created wrong must be re-filed, not patched. After creating one, confirm `usesWorktree: true` and `baseBranch: main` with `volli ticket show <id> --json`.
2. **One ticket = one PR, landing green on `main`.** No long-lived branches. Short integration branches only for the three cutovers named in the ruling, and only with the owner's go.
3. **Flag off means unchanged.** Every PR must keep the app identical with the `cloud` flag off. The core e2e suite is the proof. A PR that changes flag-off behavior is not mergeable unless the ticket says so explicitly.
4. **Host code never imports `electron`.** That applies to `packages/host-core`, `packages/host-protocol` and `apps/hostd`, enforced by VC-552's guard once it lands.
5. **The repo's norms apply in full** (`CLAUDE.md` / `AGENTS.md`):
   - Local runs stay small; CI is the gate.
   - Push once.
   - Hand off at PR-open: the ticket goes to Needs Review naming the PR.
   - Red-main rule.
   - **Cloud merges use the owner's standing grant** (section 9), only after the verification loop (section 8). Use `gh pr merge <pr> --merge --match-head-commit <sha>`. Never `--auto`.
6. **Do not change the ruling silently.** If a Session finds the ruling wrong, it writes the evidence on the ticket and you bring it to the owner (section 9).

## 4. Every pass

Run this at the start of each pass (a pass = whenever you wake on a notice or the owner speaks to you):

1. `volli board` and `volli ticket list --label cloud` to see what moved.
2. `volli session list --state working` (and `--ticket <id>` for anything suspicious) to see what is running. Use `volli session peek <id>` instead of guessing.
3. `volli conflicts` before starting anything that touches a hotspot file (section 6).
4. Check provider usage windows and Session stop reasons against the limits in section 5.
5. Handle finished Sessions: review (section 8), move the ticket, update the milestone ticket.
6. Start the next ready tickets, up to the concurrency limit.
7. End the pass with a short comment on VC-539: what landed, what is running, what is blocked, and what needs the owner. If something needs the owner now, also `volli notify -m "<one line>"`.

Never poll or sleep. `session_start` already watches the Sessions it opens. Use `watch` for tickets or Sessions you did not start. End your turn and wait for notices.

## 5. Models and usage limits

### Model by kind of work

The model tiers in the owner's Volli Settings are authoritative. Resolve them with `volli model list`; do not pin model names here.

| Kind of work | Tier | Why |
|---|---|---|
| **You (orchestrator)** | `global` | Judgment across the whole program. Stay lean: delegate reading. |
| **Specs and pattern-setting tickets**: VC-549 (protocol), VC-550 (identity), VC-553 (host-core pattern), VC-561 (browser backend), VC-564 (WebSocket transport), VC-581 (leases), VC-582 (checkpoint move), every M4 design step, and expanding a stub brief | `deep` | These set conventions many later tickets copy. Mistakes here propagate. |
| **Mechanical moves once a pattern exists**: VC-554–VC-560, VC-562, M2 area tickets VC-565–VC-573 | `ticket` | Well-specified work. |
| **UI tickets** (VC-576, VC-583, VC-591, M5 screens) | `ticket` for implementation; `visual` for screenshot checks and visual review | Visual verification is its own skill. |
| **Code review** | A tier or model from a different family than the implementer's, as resolved by `volli model list` | Cross-family review catches more than self-review. |
| **CI log triage, code search, inventories** | `fast` / `utility` | Bounded reading. |

Pass `tier` on every `session_start`; do not rely on defaults. Pick the reviewer's tier or model from a different family after resolving the implementer's model. If a tier cannot express what a ticket needs, ask the owner to update Settings.

### Usage limits

**Owner sets these numbers.** Until the owner fills them in, use the defaults in brackets and ask once at the start.

- **Concurrent working Ticket Sessions:** [4]. Never more than [2] on Opus at once.
- **Spend is not a constraint.** There are no dollar ceilings or per-ticket dollar guards.
- **Spread across providers.** Watch provider usage windows and keep work spread across providers so no one subscription window is exhausted. If a Session stops with a provider quota, rate-limit or overload stop reason (recorded on the Session since VC-482), do not retry it in a loop. Restart that ticket's next Session on an equivalent tier resolving to another provider, and note the switch on the ticket; ask the owner to update Settings if needed. If the available providers are limited, stop starting work and notify the owner.
- **The machine is shared.** Sessions inherit `VOLLI_CONCURRENCY_HINT`. Do not raise concurrency to compensate for slow CI.

## 6. Sequencing

### Waves

**Wave A (M0): start in parallel.**
- VC-547 (ruling to main, `ticket` tier)
- VC-548 (flags, `ticket` tier)
- VC-551 (transaction gate, `deep`)
- VC-552 (Linux CI and guard, `ticket` tier)
- VC-549 (protocol spec and code, `deep` tier)
- VC-550 (identity spec and code, `deep` tier)

VC-549 and VC-550 reference each other: tell each Session the other exists and to coordinate through ticket comments. **Both specs merge under the standing grant; the owner reviews them at the end of the wave** (section 9). Six Sessions exceeds the default concurrency of 4, so start VC-549, VC-550, VC-551 and VC-552 first, then the two docs/flag tickets.

**Wave B (M1 core): one at a time to start.**
1. VC-553 (host-core pattern) runs **alone** until merged. It sets the pattern everything else copies.
2. Then VC-554 (ports) runs alone or with VC-559 (secrets).
3. Then VC-555, VC-556, VC-557 and VC-558 in parallel, at most 3 at once (hotspots below).
4. VC-560 (terminals) and VC-561 (browser) after VC-554.
5. VC-562 (hostd) after VC-555–VC-559.
6. VC-563 (smoke plus runbook) last. The owner runs the M1 demo.

**Wave C (M2):**
1. Expand the M2 stubs as soon as VC-549 and VC-550 merge.
2. VC-564 (WebSocket transport) and VC-574 (channel and app_state classification) go first.
3. Then the area tickets VC-565–VC-573 in parallel lanes. They are the biggest parallel stretch, so use it.
4. Then VC-575 (pairing), VC-576 (connection UX), VC-577 (Mac host/menu-bar mode, pending VC-691), VC-578 (attention delivery). **Amended 2026-10-06 (post-M1 review), D-A2:** VC-691's 1–2 day launchd/keychain/TCC/signing spike precedes VC-577's expanded brief.
5. VC-637 (throwaway mobile test client served by `hostd`) after VC-564, VC-565, VC-575 and VC-578. Keep it to its three surfaces (board, what needs me, answer a question). Anything it cannot reach without Electron is an M2 protocol bug, not a reason to grow it toward M5.
6. VC-579 is the owner's dogfood week. VC-637 is done when the owner answers an agent's question from a phone during it.
7. VC-587 (M4 table classification) can run during M2.

**Waves D–F:**
- M3 after M2's demo.
- M4 alongside M3.
- M5 ships in 0.4.0, after 0.3.0 (owner ruling, 2026-10-04).
- M6 only when the owner says so.

### Hotspot files

These files are touched by many cloud tickets and by 0.2.x work:

- `apps/desktop/src/main/index.ts` (the composition root)
- `apps/desktop/src/ipc/contract.ts`
- `apps/desktop/src/main/ipc-descriptors.ts`
- `apps/desktop/src/main/data-ipc.ts`
- `apps/desktop/src/preload/index.ts`
- `apps/desktop/src/renderer/src/stores/workspace.ts`
- `packages/host-core/src/db/migrations.ts`

Rules for hotspots:

- At most **two** working Sessions whose tickets touch `index.ts`, and at most **one** adding a migration, at any time.
- Before a hotspot ticket opens its PR, it runs `volli worktree sync` against `main`.
- Prefer landing small: if a move ticket grows past roughly 1,500 changed lines, split it at a service boundary.
- Check `volli conflicts` before starting a hotspot ticket. If a 0.2.x ticket is mid-flight in the same file, wait or sequence it.

## 7. Expanding a stub brief

Before starting a Session on any M2–M6 ticket whose body says **"Brief status: stub"**, rewrite the brief. Use a deep-tier subagent for the reading, then write the result yourself with `volli ticket update <id> --body-file`. The expanded brief has:

1. **Goal**: one paragraph, in product terms.
2. **Exact scope**: the channels or files by name (pull them from `apps/desktop/src/ipc/contract.ts` and the code), the protocol operations and projections to add, and what stays client-local.
3. **Contracts**: which sections of `docs/plans/host-protocol.md` and `docs/plans/host-identity.md` apply.
4. **Tests**: the contract-harness cases, unit tests, and which smoke proves flag-off is unchanged.
5. **Out of scope**: name the neighbouring tickets.
6. **Depends on / blocks**: ticket ids.
7. **Done when**: observable, checkable.
8. **Model note**: per section 5.
9. **Hosted-readiness guardrails**: carry the ruling's five rules into every brief (owner decision, 2026-10-06). State how the work keeps the hosted door open; pairing is not the only enrollment path.

Remove the stub line when done. If a stub turns out to be two tickets, file the second one (worktree, `--base main`, label `cloud`, appended to its milestone's list) rather than growing the first.

## 8. Starting, reviewing and landing a ticket

### Kickoff template (adapt per ticket)

```
You are working ticket <ID>: <title>. It is part of the Volli Cloud program (parent VC-539, milestone <VC-54x>).

First action: git fetch origin && volli worktree sync. New worktrees branch from the root checkout's local main, which may be stale. If the sync brings in a new workspace package, run pnpm install before any local typecheck.

Read first: the ticket brief, docs/plans/volli-cloud.md (the ruling), and CLAUDE.md. <For M2+: docs/plans/host-protocol.md and docs/plans/host-identity.md.>

Rules: one PR based on main; with the `cloud` flag off the app must behave exactly as today; no `electron` imports in host-core / host-protocol / hostd; follow docs/BOUNDARIES.md; local runs stay small and CI is the gate; push once; hand off at PR-open (move the ticket to Needs Review and name the PR). Do not merge.

<Ticket-specific notes: dependencies just merged, hotspot warnings, coordination with sibling tickets.>

Done means: PR open; CI gate green on its head; the ticket body's "Done when" satisfied; a closing comment on the ticket with what changed, what was verified (exact commands), and anything left open.
```

### Wiring review rule

**No exported seam without a production caller.** Every new export names its production caller (file and call path), or the exact checklist line in the ticket that will call it. Tests and the lab do not count. “The next ticket wires it” requires a checklist line in that receiving ticket, not just a comment in the producing code.

Record cross-ticket decisions, such as where a Workspace link lives, in the relevant plan before a second ticket builds on them. Review the producer and consumer against that decision.

Before an acceptance run, **code-complete** requires a per-exit-criterion wiring table with every row **wired**. Use the [review brief's table](architecture-review-brief.md#wiring-evidence-every-review): criterion, each link in the production chain, status (`wired`, `pieces only`, `missing`), and production caller/evidence. Future-ticket wiring is an unfinished handoff, not code-complete.

Attach the first output of `node scripts/report-exported-seams.mjs` to the PR body. The CI report is advisory and bounded below a minute; an empty inventory is not wiring proof. Its conservative ripgrep/name pass avoids depending on TypeScript 7's unstable parser API. Forwarding exports alone are not callers; comments, strings, name collisions and unused imports can mask gaps, while default/namespace/dynamic access and same-file calls need manual review. Lab simulations display **Simulated wiring**, even when the equivalent production path is now wired.

### When a Session reports done

1. **Receipt.** Read the closing comment and `gh pr view <pr>` against the ticket's "Done when".
2. **Freshness.** Fetch: the head must contain current `origin/main`. If not, sync and get fresh CI.
   Every merge makes the other PRs stale; check again before each landing.
3. **CI.** Require `CI gate` SUCCESS on the exact head; desktop changes must actually run the smoke lanes.
   A cancelled or superseded gate is never mergeable. GitHub does not enforce required checks here.
4. **Independent verification.** Use one subagent from a different model family (section 5) for both
   code review (`code-review` skill) and live proof: focused tests and edge-case probes.
   Require PASS / PASS+NOTES / FAIL tied to the head SHA, with no unresolved blocking findings.
   Spec and migration PRs get a second, design-focused reviewer.
   A changed head voids the verdict; re-check only the delta and record the new head.
5. **Flag-off proof.** Confirm unchanged behavior with `cloud` off; core e2e is the desktop proof.
6. **Migration/schema extras.** Check the diff is additive-only and the version is unique and above main's max.
   Sweep open PRs for version collisions; run the db tests.
   Copy a real profile with online SQLite `.backup` into `/tmp`, then boot the copy twice.
   Prove an old build opens the new DB. Derive head constants; never pin them to today's migration version.
7. **FAIL.** Start a fresh Ticket Session on the same ticket with the findings, not repeated steering of the old one.
   Do not fix it yourself; repeat the loop on the resulting head.
8. **Land.** Under the standing grant (section 9), merge one at a time:
   `gh pr merge <pr> --merge --match-head-commit <sha>`. Never `--auto`.
   Watch main CI on the merge commit before landing the next PR; stop on red.
9. **Record.** Put the receipt on the ticket: head SHA, CI, verifier verdicts, flag-off and extra proof, merge SHA.
   Move it to Done, tick it on the milestone ticket, and start whatever it unblocked.

### When a Session is stuck

- Asks a question you can answer from the ruling or the specs: answer it.
- Asks a product or scope question: bring it to the owner.
- Loops without progress: stop it (`session stop`), write down what it learned on the ticket, and restart with a sharper brief, a split ticket, or a stronger model.

## 9. What needs the owner

Bring these to the owner. Batch them into the end-of-pass comment, and use `volli notify` when something is blocking:

- **Spec reviews:** VC-549 (protocol) and VC-550 (identity) each ship spec and code in one PR, merged under the standing grant. The owner reviews the specs at the end of the wave; record that review on each ticket. Also review every expanded M4 brief and VC-582 (move protocol).
- **Merges.** The owner granted standing merge permission for cloud PRs on 2026-10-03 (recorded on VC-539). The orchestrator does not wait for approval: require green `CI gate` on a head containing current `origin/main`, one cross-family review with no unresolved blocking findings, flag-off safety, and the section 8 verification loop (extra scrutiny for edge cases and migrations). Merge one at a time with `--match-head-commit`, never `--auto`, and watch main CI after each merge. Spec PRs may land on the orchestrator's judgment while the owner is away; flag them for the end-of-wave spec review.
- **Any change to the ruling,** or a finding that contradicts it.
- **Anything that changes flag-off behavior,** or touches a real profile database outside a test copy.
- **Provider limits:** rate-limit, quota or overload stops on all available providers.
- **Red main** that a cloud PR may have caused.
- **Milestone demos.** Prepare a short demo script on the milestone ticket. The owner runs it; only the owner marks a milestone done.
- **Anything needing the Hetzner box, accounts, or credentials.** Sessions never ask for or handle secrets in chat. They use the secure credential field, and the owner provides them.

## Milestone architecture review

**Standing owner rule, 2026-10-06:** after every milestone from M1 onwards, run a fresh-eyes architecture review. A milestone is not Done until the owner demo and this review are recorded on its ticket (VC-542–VC-546 for M2–M6).

1. **One common brief.** Copy [architecture-review-brief.md](architecture-review-brief.md) into the review's scratch directory and refresh the milestone, pinned main SHA/read-only checkout, previous report, merged/in-flight PRs, tickets and settled rulings. The checked-in seed is the historical post-M1 brief; its snapshot paths and decisions are not current instructions. Include the ruling's hosted-readiness guardrails.
2. **Six cross-family lenses.** Resolve models with `volli model list` (section 5); spread independent reviewers across families. Give each the same brief plus its lens: first principles and industry; module depth; UX; performance; evolvability and upgrades; code quality and tests. Reviews are read-only, with file:line evidence; keep their notes.
3. **Synthesize HTML.** Use the improve-codebase-architecture format: verdict, decisions that re-open rulings, already-in-motion work, cross-lens convergences/disagreements, candidates with before/after shapes and timing, evidence tables, previous-review follow-up and top recommendations. The post-M1 example is `.scratch/arch-review-m1/architecture-review-post-M1.html`. Check every PR since the previous milestone against the five hosted-readiness guardrails: **does this block hosted?**
4. **File tickets.** Deduplicate against in-flight work; file actionable findings with evidence, scope, contracts, verification and timing, and link them from the milestone ticket. Follow section 3's worktree/`main` rules.
5. **Bring only reopened rulings to the owner.** For review findings, surface only decisions that re-open settled rulings, with options and trade-offs; don't ask the owner to triage implementation findings. Record the report, tickets and surfaced decisions on the milestone ticket. Apply approved amendments with dated notes, not rewritten history.

M1's review is the seed: owner decisions D-A1/A2/A3/C1/C2 are recorded on VC-542; the hosted-readiness guardrails are on VC-692. The milestone order remains unchanged.

## 10. Existing tickets in the program

- **Folded in:** VC-361 and VC-362 (M2), VC-450, VC-315 and VC-394 (M3). Treat them as program tickets: same rules, same review.
- **Superseded (do not start):** VC-503 → VC-581, VC-390 → VC-586, VC-198, VC-199 and VC-320 (shaping done).
- **Related outside the program:** VC-518 (Experimental page; VC-548 builds the page), VC-298 (schedule UX; the execution-host label moved to VC-583).

## 11. Definition of done for the program

0.3.0 ships when M0–M4 demos have passed, the owner has dogfooded lid-closed on the box for at least two weeks, the default flips (desktop always through a host; per-workspace databases), and the old paths are deleted. M5 (mobile) ships in 0.4.0 (owner ruling, 2026-10-04). M6 follows when the owner says so.

**Amended 2026-10-06 (post-M1 review), D-A3 and standing review rule:** per-Workspace databases are not a 0.3.0 gate; re-decide the split at M6 planning. M4 is move the host. M1–M4 architecture reviews must also be complete; each later milestone likewise requires its review before Done.
