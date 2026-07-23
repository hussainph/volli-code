# The Automations Layer — First-Principles Research Synthesis

*July 2026. Input for the user-configurable automations system deferred by decisions #38/#39
(column-entry effects, trigger vocabulary) and #44/#45 (Done-flow automation, #79). This is
research synthesis, not a decision log — decisions get made against this, in CONCEPT.md.*

Seven parallel research tracks: HumanLayer/Dex Horthy · official vendor loop mechanisms
(Anthropic/OpenAI/Google) · Matt Pocock's skills stack incl. Wayfinder · engineering blogs of
AI-forward companies · multi-model benchmark/cost literature · the Superpowers and
oh-my-claudecode plugin ecosystems · scheduler/automation frameworks (Hermes Agent, OpenClaw,
Devin, OpenHands, et al.). Full source links in the appendix.

---

## 1. The one-sentence finding

Every serious automation product in this space — an Anthropic Routine, an OpenAI Codex
Automation, a Google Jules scheduled task, a Hermes cron job, a Devin Automation — is the
same record, arrived at independently:

> **a trigger + a prompt-plus-skills recipe + a model-and-effort budget + an isolated place
> to run + a human review gate at the end.**

Volli's planned configuration surface (skills, prompts, models, effort) is that record. And
Volli already owns, natively, the two components every vendor had to bolt on afterward: the
**review queue** (the Needs Review column) and the **isolated environment** (worktree per
ticket). The field spent 2025–2026 converging on a shape whose two hardest parts are this
app's existing architecture.

## 2. What the field agrees on (consensus, with evidence)

Ranked roughly by how many independent tracks converged on each point.

1. **Verification loops beat model choice.** Stripe ("the walls matter more than the
   model"), Ramp (agent gets tests + telemetry + screenshots), Factory (TDD as the leash),
   Anthropic, Cursor's Bugbot. The winning investment is the agent's ability to *prove its
   work*, and the winning structure is deterministic scaffolding around agentic cores:
   fixed code for the predictable steps (branch, test, lint, commit, PR), the model only
   where judgment is required, with **bounded retries** (Stripe caps at two CI rounds).
2. **The human review gate is the one non-automatable step.** Even at Stripe's 1,300+
   agent-written merged PRs/week and Ramp's >50%, a human merges. Codex funnels every
   automation run into a "Triage" inbox; Jules only ever outputs a PR. Agents reach
   *reviewable*; "done" is a human verb — exactly Volli's Needs Review semantics.
3. **Review the plan, not the diff.** Horthy's RPI (Research → Plan → Implement, each phase
   a markdown artifact, each next phase a fresh session reading that artifact), Notion's
   spec-driven development, Pocock's grill → spec → tickets → implement, Anthropic's plan
   mode, Jesse Vincent's architect-agent. Human attention belongs on the early artifacts
   where a bad line costs thousands of code lines downstream. This is Volli's
   zoom-in/zoom-out philosophy stated by the whole industry: **zoomed out = artifact
   review; zoomed in = the raw terminal.**
4. **Parallelize reads, serialize writes.** Anthropic's multi-agent research system (+90%
   on research, ~15x token cost) vs. Cognition's "don't build multi-agents" (parallel
   writers make conflicting implicit decisions) resolve cleanly: fan out read-only work
   (research, review passes, scouting); keep exactly one writer per surface. Extra agents
   should contribute *intelligence, not actions*. Token spend alone explains ~80% of
   multi-agent outcome variance — much of the "gain" is just spending more.
5. **Cheap-model default, strong-model escalation — and the best pattern is inverted.**
   The measured optimum is not a big model delegating down; it's a **cheap worker with a
   frontier advisor on call**. Anthropic's advisor tool: Sonnet + Opus advisor beat Sonnet
   alone by +2.7pp on SWE-bench Multilingual at **12% lower cost** (advice cuts
   trial-and-error retries); Haiku + Opus advisor doubled Haiku's score. Orchestrator +
   mid-tier workers: ~96% of all-frontier quality at ~46% of cost. Amp ships this as the
   Oracle (expensive read-only planner/reviewer, explicitly user-invoked); Cloudflare
   assigns workhorse models per review role with runtime-overridable config.
6. **Effort curves are concave and stage-dependent.** Medium → max effort costs up to ~8x
   tokens for +2–5 points on typical coding, and sometimes *hurts* (overthinking is
   measured and real). But planning and binary-verifiable work have steep curves (+18–22
   points on verifiable problems), and higher effort up front often *lowers total cost* by
   cutting retries. On short bounded tasks, one frontier model working alone was unbeaten
   on quality-and-cost — never force the pipeline on a quick fix.
7. **Fresh context beats continuation.** Fresh-context reviewers outperform self-critique
   (Anthropic/Pilotfish, Pocock's two-axis review, Horthy's phase-per-fresh-session).
   Sessions are disposable; durable state lives in artifacts, files, git — not the
   conversation. Amp went furthest: retired in-place compaction for explicit *handoff*
   (extract what matters into a fresh thread, human reviews what carries over).
8. **Enforcement belongs in code, not prompt text.** Superpowers spends a ~450-word
   mandatory injection plus anti-shortcut boilerplate *telling* the model not to skip
   steps — the #1 measured waste pattern ("simple fixes take an hour, burned my Max
   plan"). Structural gates (a state machine that won't advance until checks ran) cost
   zero tokens. Volli's `volli help` token-ceiling tests already encode this ethos.
9. **Definitions in files, state in the database.** Every vendor stores automation
   recipes as committable files (project-level beats user-level, size caps ~25KB) and
   scheduling/run state elsewhere. OpenClaw's flat-file job store and unqueued webhooks
   lose work across restarts — the known weakness of the category's most popular tool.
10. **Checkpoint/rollback makes autonomy safe.** Universal at Anthropic: start from clean
    git state, checkpoint often, and prefer **accept-or-restart** over wrestling with a
    wandering agent (the "slot machine" pattern — restarting is often cheaper than
    steering). Worktrees are the isolation primitive everywhere.

## 3. Contested points, and the resolutions Volli should adopt

- **Effort defaults: "start low, escalate" (Pocock) vs. "don't skimp on planning"
  (benchmarks).** Both agree mechanical work gets low effort and review gets the strong
  treatment; the contested square is plan-stage effort. Resolution: **asymmetric static
  defaults (plan/review high, implement medium, mechanical low) plus escalate-on-retry**
  — a failed verification bumps the next attempt one notch (model or effort). Never
  static max anywhere; it's the measured 8x-cost-for-nothing setting.
- **Progressive disclosure (Anthropic, Pocock) vs. inline context (Vercel: inline
  AGENTS.md hit 100% in their evals vs. 79% for skills, because a skill adds a "will the
  agent bother to look it up" decision point).** Resolution: Volli's automations select
  the recipe *deterministically* — the automation names the skill, the composed prompt
  injects exactly that one recipe for that stage. No decision point, no standing library
  in context. Progressive disclosure remains right for the long tail the agent chooses
  from (the `volli` CLI skill pack already works this way).
- **Model picker vs. no model picker (Amp hides models entirely; Cloudflare exposes
  per-role config).** Resolution: expose *intent*, not a matrix — one *thrifty /
  standard / premium* dial as the primary control (the measured curves show only 2–3
  genuinely distinct operating points per stage), with per-stage model/effort overrides
  underneath for power users. Show the resolved model/effort as chips on the automation.
- **Full autonomy.** Horthy's "dark factory" (agents with no human review) corrupted its
  codebase within three months. Loops are fine — *because* they reset context each
  iteration and keep state in files — but every loop terminates at the review gate.

## 4. The Volli synthesis: altitude is the product

The zoom-in/zoom-out philosophy, made concrete by the research:

- **The board is the outer loop.** Horthy's 12-factor architecture (small 3–20-step
  agents; control flow owned by deterministic code; execution state unified with business
  state in one event log) describes Volli's existing design: the pure state machine is the
  owned control flow, the ticket event log is the unified state store, and each automation
  stage is a small fresh-context session. The process lives between sessions on the board,
  not inside one long conversation — which is also why our prompts can stay small (§2.8).
- **Altitude is a per-ticket property, carried by one bit.** Wayfinder tags every ticket
  HITL (needs a human in the loop) or AFK (an agent can run it unattended). An AFK ticket
  entering Doing runs under its automation; a HITL ticket boots the terminal and waits.
  One field lets a single board mix hands-on work, delegated pipelines, and standing
  orders per ticket.
- **Zoom levels are review surfaces.** Fully zoomed in: the live terminal. Mid-zoom:
  phase artifacts (research doc, plan, review findings) attached to the ticket — the
  human edits the plan, not the diff. Zoomed out: the board and its notifications.
  **Takeover** (from Terragon) closes the loop downward: any automated run can become a
  hands-on session with one click — trivial here because the ticket already is a
  terminal.
- **Token spending stays a human act — including decisions made in advance.** Decision
  #20's asymmetry law extends rather than breaks: *arming* an automation is the human
  act, made once, visibly, with a cap. Automation may only spend what a human
  pre-authorized; it never raises its own budget; wanting more is a Needs Review moment.
- **Resume = fresh session + latest artifact.** "Re-enter Doing" under an automation
  means booting a fresh agent from the ticket's most recent phase artifact — sidesteps
  stale context and survives app restarts for free. (Complements #21's live-terminal
  resume; a `handoff` recipe compacts a dying session into an artifact.)

## 5. Proposed shape of the automation record

Pure, tested TypeScript in `@volli/shared`, most likely an extension of the ticket state
machine ("move to Doing boots an agent" is already an event automation in all but name).
Recipes as small markdown files (repo `.volli/` or project-level, committable, diffable);
scheduling state and run history in SQLite (transactional, survives crashes — the OpenClaw
lesson). Runs and their events join the existing append-only event log with the
`automation` actor.

```
automation = {
  name, enabled,
  trigger:  board event (ticket enters column / label added / matching ticket created
            / agent signal: turn ended, question asked, `volli done|blocked`)
            | schedule (cron / interval / one-shot; missed-fire policy: skip |
              run-once-at-launch | notify)
            | external event (PR review comment, CI state — payload injected only
              inside an explicitly-untrusted envelope)
            | manual ("run now" — doubles as the test button),
  recipe:   prompt template (event-payload interpolation) + exactly-selected skills,
  budget:   model + effort (snapshotted at creation; on default-drift: skip + alert),
            iteration cap (default 2 verify→fix rounds), runs/hour limit,
            auto-expiry for recurring (~7 days, renewable), optional cheap pre-check
            (shell probe; skip the model when nothing changed),
  handoff:  target column/state + evidence to attach (test output always; screenshots
            for UI tickets) + notification; escalating re-notify on aging reviews,
}
```

Guardrails, all defaults-on (each is a measured failure elsewhere): iteration caps
(ralph's unlimited default is universally warned against) · runs/hour invocation limits
(Devin) · recurring auto-expiry (Anthropic) · model snapshot + drift alert (Hermes) ·
no recursion — automation management disabled inside automation runs (Hermes) ·
untrusted-payload wrapping (Anthropic Routines) · pushes only to `volli/`-prefixed
branches (existing convention) · every automated act announced + logged (existing law).

Composition rule (Pocock's, load-bearing): **automations are orchestrators; the skills
they compose are disciplines; orchestrators never call orchestrators.** Keeps user-built
workflows acyclic and predictable. Shipped defaults are managed and auto-updating until
the user edits one — then it becomes their editable copy (fork-on-write).

Structured human contact (Factor 7, via the `volli` CLI): an agent signals
`request_human_input {question, context, urgency, response_options[]}` — that is what
moves the card to Needs Review and fires the notification, and each response option
carries the exact text injected back on click ("ship it" / "add tests first" / "wrong
approach — re-research"). Rejection comments flow back into agent context. Plans split
verification into **automated criteria** (commands the agent runs; gate the auto-move)
and **manual criteria** (checklist rendered on the Needs Review card).

## 6. Opinionated shipped defaults

Five named workflows, each readable in a minute, pre-armed conservatively:

1. **Turn-based** *(default)* — today's loop. Agent works; every stop → Needs Review
   with a reason badge. No new spending behavior.
2. **Quick fix** — one session, one model, minimal preamble, no pipeline. (On short
   bounded tasks a single strong model is the measured optimum; the ceremony is pure
   overhead.)
3. **Self-check** — on entering Needs Review, a *fresh* session reviews the diff on two
   axes (standards / spec-compliance), findings capped and posted as a ticket comment,
   then the human is notified. The smallest automation that changes the experience.
4. **Plan-first (RPI)** — for bigger tickets: research artifact → plan artifact with
   automated + manual success criteria → **human approves the plan** (the zoom-out
   altitude) → fresh implementer per phase → bounded verify→fix (2 rounds, escalate one
   tier on fail) → Needs Review with evidence attached.
5. **Standing order** — schedule + recipe + hard caps + expiry + cheap pre-check; each
   firing creates a card in its own worktree that lands in Needs Review (success) or a
   visibly-failed state. The board is the run history. Templates: ticket babysitter
   (tend review comments / red CI / conflicts on owned PRs — never new initiatives),
   nightly triage, CI-failure summarizer, weekly dependency PR.

Default budget ladder (the *standard* notch; thrifty/premium shift each stage one step):

| Stage | Model tier | Effort | Why |
|---|---|---|---|
| Plan / architecture | strong | high | hard-tail reasoning; good plans cut retries |
| Implement | mid, advisor on call | medium | ~96% of quality at ~half cost; advisor is cheaper *and* better |
| Read-only scouts | cheap | low | mechanical; no write risk |
| Review | strong | high | frontier leads the hard tail; review is the gate |
| Verify (fresh context) | mid → escalate on fail | medium | binary outcome; fresh judge beats self-critique |
| Mechanical (commit msgs, PR body, triage labels) | cheap | low | the measured 8x-for-nothing square |

## 7. What nobody ships (Volli differentiators)

- **Show the bill**: per-ticket, per-phase token/cost readout. Every cost complaint in
  the plugin ecosystems is a *surprise*-cost complaint; and since token spend predicts
  outcome variance, the meter doubles as a quality signal.
- **Context-utilization meter** per session: model quality degrades past ~40–60% of the
  window (Horthy, ~100k sessions). A small "smart zone" gauge on each terminal pane,
  plus a `handoff` affordance when it reddens.
- **Takeover**: drop into any automation's live terminal mid-run. One click from
  standing-order to hands-on.
- **In-product recipe evals**: replay an edited automation against recorded ticket
  fixtures and score it (evalite-style). Nobody ships this; it's how user workflows
  avoid rotting, and it extends the repo's tested-token-budget culture.
- **A missed-fire policy** for schedules elapsing while the app is closed (skip /
  run-once-at-launch / notify) — unsolved by every local-first competitor.
- **Native Wayfinder terrain**: decision tickets, blocking edges, a claimable frontier —
  the most popular efficiency-focused skills stack currently simulates a tracker with
  markdown files; Volli can *be* that tracker natively.

## 8. Cautions (measured failures to design against)

- Unreviewed full autonomy rots codebases (dark factory: three months to corruption).
- Always-on prompt injection is the #1 waste pattern (Superpowers' mandatory preamble).
- Parallel writers produce incoherent code (Cognition); fan-out is a ~15x token
  multiplier justified only for high-value read-heavy work.
- Unbounded loops are token faucets (ralph without caps; OMC's `/ralph`).
- Review bandwidth, not generation, is the system bottleneck (Willison): parallelism
  without a review strategy just accumulates liability — pace automation to the human's
  ability to review, and make saturation visible (one human keeping several tickets'
  agents busy: review one while another plans).

---

## 9. MVP proposal: column playbooks

The buildable-today core, derived from one observation: Volli already *is* this system
with one hardcoded automation ("enters Doing → compose brief → boot agent → stops →
Needs Review"). The MVP generalizes that seam instead of adding machinery.

**One new object — the playbook.** A small markdown file in
`<project>/.volli/playbooks/<name>.md`: frontmatter for `model`, `effort`, optional
`check` (a command) and `rounds` (fix-it attempts after a failed check, default 2);
body = the instructions appended to the composed ticket brief. Committable, diffable,
fork-on-edit. The playbook *is* the budget config — no separate budget UI.

**One new setting — the same slot on every column.** "When a ticket lands here:
do nothing / run <playbook> in a fresh session." Project-level, with a per-ticket
override (`Use project default / <playbook> / Manual`). `Manual` is the HITL bit.

**Two hard laws, in the state machine, not configurable:**
1. Every automated session ends with the ticket in Needs Review, carrying a reason
   badge and what it produced. Automation never marks Done (extends #13/#20).
2. Automations never fire automations. Only a deliberate move starts a playbook —
   every token spent traces to a human act (extends #20's asymmetry law).

Chaining therefore happens *through the human*: Todo's plan playbook lands the plan at
the gate; approving it is dragging to Doing, which fires the implement playbook, which
reads the plan artifact. The board is the pipeline; drags advance it; Needs Review is
every automation's terminus. §6's default workflows collapse into shipped playbook
files plus column assignments — configurations, not features. Deferred to later
additive fields on the same record: schedule/event triggers, advisor escalation,
cost meter, budget dial, automation-to-automation chaining (if ever).

---

## Appendix: sources by track

**HumanLayer / Dex Horthy** — [12-factor-agents](https://github.com/humanlayer/12-factor-agents) ·
[ACE-FCA essay](https://github.com/humanlayer/advanced-context-engineering-for-coding-agents/blob/main/ace-fca.md) ·
[humanlayer monorepo](https://github.com/humanlayer/humanlayer) (`.claude/commands/`, `linear.md`, `create_plan.md`) ·
[Pragmatic Engineer interview](https://newsletter.pragmaticengineer.com/p/context-engineering-with-dex-horthy) ·
[Dev Interrupted on RPI/Ralph](https://linearb.io/dev-interrupted/podcast/dex-horthy-humanlayer-rpi-methodology-ralph-loop)

**Vendor loop mechanisms** — Anthropic: [scheduled tasks](https://code.claude.com/docs/en/scheduled-tasks) ·
[routines](https://code.claude.com/docs/en/routines) · [goal](https://code.claude.com/docs/en/goal) ·
[ralph-loop plugin](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/ralph-loop) ·
[long-running harnesses](https://anthropic.com/engineering/effective-harnesses-for-long-running-agents).
OpenAI: [Codex app](https://openai.com/index/introducing-the-codex-app/) ·
[automations](https://developers.openai.com/codex/app/automations) · [cloud](https://developers.openai.com/codex/cloud) ·
[config](https://developers.openai.com/codex/config-reference) · [skills](https://github.com/openai/skills).
Google: [Jules scheduled tasks](https://jules.google/docs/scheduled-tasks/) ·
[gemini-cli extensions](https://github.com/google-gemini/gemini-cli/blob/main/docs/extensions/reference.md) ·
[run-gemini-cli](https://github.com/google-github-actions/run-gemini-cli)

**Matt Pocock** — [skills](https://github.com/mattpocock/skills) (incl.
[wayfinder](https://github.com/mattpocock/skills/blob/main/skills/engineering/wayfinder/SKILL.md),
code-review, tdd, writing-great-skills) · [sandcastle](https://github.com/mattpocock/sandcastle) ·
[evalite](https://github.com/mattpocock/evalite) · [agent-rules-books](https://github.com/mattpocock/agent-rules-books) ·
[dictionary-of-ai-coding](https://github.com/mattpocock/dictionary-of-ai-coding) ·
effort-dial and AFK threads on X (links in report)

**Engineering blogs** — [How Anthropic teams use Claude Code](https://claude.com/blog/how-anthropic-teams-use-claude-code) ·
[context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) ·
[multi-agent guidance](https://claude.com/blog/building-multi-agent-systems-when-and-how-to-use-them) ·
[Stripe Minions](https://stripe.dev/blog/minions-stripes-one-shot-end-to-end-coding-agents) ·
[Ramp Inspect](https://builders.ramp.com/post/why-we-built-our-background-agent) ·
[Cloudflare AI code review](https://blog.cloudflare.com/ai-code-review/) ·
[Amp manual](https://ampcode.com/manual) / [Oracle](https://ampcode.com/news/oracle) ·
[Cognition: don't build multi-agents](https://cognition.com/blog/dont-build-multi-agents) ·
[Factory](https://factory.ai/news/factory-is-ga) ·
[Notion spec-driven](https://www.lennysnewsletter.com/p/spec-driven-development-the-ai-engineering) ·
[Linear agent guidelines](https://linear.app/developers/aig) ·
[Vercel AGENTS.md evals](https://vercel.com/blog/agents-md-outperforms-skills-in-our-agent-evals) ·
[Zed × Mitchell Hashimoto](https://zed.dev/blog/agentic-engineering-with-mitchell-hashimoto) ·
[non-trivial vibing](https://mitchellh.com/writing/non-trivial-vibing) ·
[Willison on parallel agents](https://simonwillison.net/2025/Oct/5/parallel-coding-agents/) ·
[Armin Ronacher: the coming loop](https://lucumr.pocoo.org/2026/6/23/the-coming-loop/)

**Multi-model benchmarks** — [Pilotfish](https://github.com/Nanako0129/pilotfish) ·
[advisor-tool measurements](https://blog.imseankim.com/claude-advisor-tool-executor-opus-sonnet-haiku-swe-bench-cost-2026/) ·
[MTRouter](https://arxiv.org/html/2604.23530) · [TwinRouterBench](https://arxiv.org/html/2605.18859v1) ·
[RouteLLM](https://arxiv.org/abs/2406.18665) · [effort benchmarks](https://www.digitalapplied.com/blog/reasoning-effort-cost-vs-quality-benchmarks-2026) ·
[When More Thinking Hurts](https://arxiv.org/pdf/2604.10739) ·
[equal-budget single vs multi](https://arxiv.org/pdf/2604.02460) ·
[planner+executor counterpoint](https://akitaonrails.com/en/2026/04/25/llm-benchmarks-vale-a-pena-misturar-2-modelos/)
*(several Anthropic first-party figures corroborated via secondary sources; treat as approximate)*

**Plugin ecosystems** — [obra/superpowers](https://github.com/obra/superpowers) ·
[honest tradeoffs](https://www.joanmedia.dev/ai-blog/the-honest-tradeoffs-of-superpowers-token-costs-overkill-and-the-alternatives) ·
[Yeachan-Heo/oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode) ·
[TechDufus/oh-my-claude](https://github.com/TechDufus/oh-my-claude) ·
[SuperClaude](https://github.com/SuperClaude-Org/SuperClaude_Framework)

**Schedulers/frameworks** — [Hermes Agent cron](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron) ·
[OpenClaw heartbeat/cron](https://deepwiki.com/openclaw/docs/9.1-cron-jobs-and-heartbeat) ·
[Devin automations](https://docs.devin.ai/product-guides/automations) ·
[OpenHands automations](https://docs.openhands.dev/openhands/usage/automations/event-automations) ·
[claude-code-action](https://github.com/anthropics/claude-code-action) ·
[Claude Squad](https://github.com/smtg-ai/claude-squad) · [Conductor](https://www.conductor.build/) ·
[Terragon (open-sourced)](https://github.com/terragon-labs/terragon-oss) ·
[Aider watch mode](https://aider.chat/docs/usage/watch.html) · [Temporal for agents](https://temporal.io/solutions/ai)
