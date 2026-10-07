# Post-M1 architecture review: common brief (read fully)

Template seeded from the post-M1 review (2026-10-06); refresh every placeholder.

## Why this review exists
The owner asked for a fresh-eyes architecture review after every milestone. **M1 (the headless host) is code-complete;** the owner passed the demo locally. M2 (one host protocol: desktop attaches to a local or remote `hostd` and feels identical) has just started, so this is the cheapest moment to change course.

The owner's questions, verbatim in spirit:
- **Are we even building this the right way?**
- What would compromise the UX, the maintainability, the modularity or the code quality in our approach?
- Is the system well set up for future changes, upgrades and migrations?
- Where can we simplify, optimize, or improve performance?

**You have no stake in this design.** Give real strengths and real problems, each with evidence (file:line). Don't soften, and don't invent.

## The repo and the program
**Volli Code** (`hussainph/volli-code`) is a local-first macOS Electron workspace for planning and running AI coding-agent Sessions. It's a pnpm monorepo:
- `apps/desktop`, `apps/hostd` (a headless Linux/macOS host), `apps/website`;
- `packages/{shared, session-engine, session-rpc, host-core, host-protocol, agent-runtime, cli, session-presentation, …}`.

**Volli Cloud** (parent ticket VC-539) moves the host logic out of Electron main into `packages/host-core` (no Electron imports), composed by desktop and by `hostd` through ports and adapters. Milestones:
- M0, foundations: done.
- M1, headless host: done in code.
- M2, one host protocol: started.
- M3, workers and venues.
- M4, workspace mobility (per-workspace DBs, "move workspace to this Mac").
- M5, mobile.
- M6, hosted cloud.

**Plans:**
- `docs/plans/volli-cloud.md` (the ruling);
- `docs/plans/volli-cloud-orchestration.md` (the playbook and milestone map);
- `docs/plans/host-protocol.md` (HP);
- `docs/plans/host-identity.md`;
- `docs/BOUNDARIES.md`;
- `CONTEXT.md` (the domain glossary).

## Where to read
- **A fresh read-only checkout of main** (`<pinned main SHA>`) is at `<read-only main checkout>`. Read there. Use `git -C <read-only main checkout> log/show` for history.
- **Since the last review (2026-10-04, at `<previous review SHA>`), 42 PRs merged (#734–#776).** They include:
  - hostd;
  - the Session composition lift (VC-622);
  - the host lifecycle (VC-627);
  - migration history and the disk preflight (VC-633);
  - host-core narrowed to 14 cluster entries plus `./testing` (VC-632);
  - the IPC/app_state placement registry (VC-574);
  - the credential lock retry policy (VC-653).
- **The previous review**, so you don't repeat it: `<repo>/.scratch/arch-review-<previous milestone>/architecture-review-<previous milestone>.html` (read as text) and its lens notes in `<repo>/.scratch/arch-review-<previous milestone>/notes/`. Say which of its findings are now fixed, which are still open, and which got worse.
- **In flight, not on main. Read them as the pattern M2 will copy:**
  - PR #777: VC-564 A, the command catalog, the policy middleware and the Sessions projection;
  - PR #778: A2, catalog extensions (per-door actor, `session-own`, multi-resource resolvers, `createCatalogBuilders`).

  Use `gh pr diff 777`, `gh pr diff 778` and `gh pr view`. VC-619 (a standalone Chromium browser backend for the host) is being built.
- **M2 tickets:** `volli ticket show VC-542` lists them; for example VC-563 through VC-578, VC-608, VC-663 and VC-664 each have briefs.

## Settled owner decisions
Re-open one only if the friction is real, and then flag it clearly:
- restoring a host backup creates a new host identity;
- one connection per workspace;
- worker kinds are local, remote and cloud;
- `min_reader_version` schema compatibility;
- synchronous-only DB transactions;
- backups never carry credentials;
- **the agent browser on a host is standalone Chromium, provided it reaches parity** with today's in-app panel (fallback: a lent WebContentsView);
- a per-project theme follows the project to every device;
- the agent CLI path never changes.

## Wiring evidence (every review)

**No exported seam without a production caller.** For every new export, name the production caller (file and call path), or the exact checklist line in the receiving ticket that will call it. Tests and lab scenarios are not production callers. A comment saying “the next ticket wires it” is not a handoff unless that receiving ticket has the checklist line.

Record decisions that cross tickets (for example, where a Workspace link lives) in the relevant plan **before a second ticket builds on them**. Review both sides of the handoff against that recorded decision.

A milestone is **code-complete** only after a per-exit-criterion wiring table has every row **wired**, before the acceptance run. Use this shape, following the integration-gap analysis; code existing or tests passing is only **pieces only**, not wired:

| Exit criterion | Link in the production chain | Status | Caller / evidence |
|---|---|---|---|
| <criterion> | <each UI → transport → host → result hop> | wired / pieces only / missing | <file:line and call path> |

Trace each criterion end to end, including ownership, reconnect and flag-off behavior. A ticket line naming future wiring permits an explicit unfinished handoff, not a milestone code-complete claim.

Run `node scripts/report-exported-seams.mjs` for an **advisory** inventory and attach its first output to the PR body. It uses a conservative ripgrep/name pass because the repository's TypeScript 7 has no stable compiler/parser API; it reads source once instead of typechecking the whole monorepo. It ignores forwarding exports as caller evidence and follows named aliases by spelling. Comments, strings, same-named symbols and unused imports can hide gaps; default, namespace or dynamic access and same-file calls require manual inspection. It is not a reachability proof or a blocking gate. Lab scratches that simulate live boundaries must visibly say **Simulated wiring**; a lab result is not acceptance evidence.

## Rules
- **Read-only.** Don't modify, commit or push anything, anywhere. No installs or builds; read the code.
- The only place you may write is `<repo>/.scratch/arch-review-<milestone>/notes/`.
- Web research is allowed where your lens asks for it; cite URLs.
- You can't ask questions, so state your assumptions.

## Vocabulary
Read the codebase-design skill and its `DEEPENING.md` first. Use their terms exactly: module, interface, implementation, depth, deep, shallow, seam, adapter, leverage, locality. Apply the deletion test, and "one adapter = a hypothetical seam, two = a real one". Use domain terms from `CONTEXT.md`. Don't design type signatures; name each candidate and describe its shape in a sentence.

## Output: at most 1,600 words of markdown
Write it to `notes/<LENS>.md` and also return it as your answer.
1. **Verdict:** 3–5 sentences, and answer "are we building this the right way?" for your lens.
2. **Strengths:** at most 5, with evidence.
3. **Previous review follow-up:** fixed, open, or worse, briefly.
4. **Candidates:** 3–6, each with:
   - Title;
   - Strength: Strong, Worth exploring, or Speculative;
   - Files;
   - Problem (1 sentence);
   - Solution (1 sentence);
   - Wins (at most 4 bullets);
   - Before and After (2–4 lines each, enough to draw);
   - **Timing: before M2's area tickets (VC-565+), during M2, before 0.3.0, or later.**
5. **Risks:** at most 6, each with a severity (high, med or low) and file:line.
6. **The lens-specific section** your brief asks for.
