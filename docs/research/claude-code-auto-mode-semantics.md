# Claude Code auto mode: semantics, and how Volli's authority layer maps onto it

**Date:** 2026-08-10
**Primary source:** <https://www.anthropic.com/engineering/claude-code-auto-mode> — "How we
built Claude Code auto mode: a safer way to skip permissions", published Mar 25, 2026.
**Secondary source:** <https://claude.com/blog/auto-mode-default-in-claude-code> — the
default-mode announcement, Aug 7, 2026.

## On quoting

The engineering post could not be retrieved as full text; it was read through repeated
extraction passes with different prompts, and quotes below are what those passes returned.
Every rule and number is quoted rather than paraphrased. Quotes that only one pass produced
and that read like they could be summary rather than source text are marked *(single pass)*.

The article's own section order is: How it works · Threat model · How permission decisions
work · The classifier decision criteria · Results · Design decisions · What's next.

---

# Part 1 — The semantic model

## 1.1 The problem, and the two alternatives auto mode sits between

The article opens on approval fatigue: "This keeps users safe, but it also means a lot of
clicking 'approve.' Over time that leads to approval fatigue, where people stop paying
close attention to what they're approving."

It frames two pre-existing escapes: "a built-in sandbox where tools are isolated to prevent
dangerous actions, or the `--dangerously-skip-permissions` flag that disables all permission
prompts and lets Claude act freely, which is unsafe in most situations."

Its stated objection to sandboxing is cost, not safety: "Sandboxing is safe but
high-maintenance: each new capability needs configuring, and anything requiring network or
host access breaks isolation."

Baseline figure: "Claude Code users approve 93% of permission prompts."

## 1.2 Threat model

Four categories, in the article's terms:

1. **Overeager behavior** — the agent "understands the user's goal, and is genuinely trying
   to help, but takes initiative beyond what the user would approve."
2. **Honest mistakes** — the agent misreads scope, e.g. treating a shared resource as a test
   resource.
3. **Prompt injection** — "Instructions planted in a file, webpage, or tool output hijack the
   agent."
4. **Model misalignment** — the model pursuing independent goals. Treated as theoretical:
   "We don't currently see this in practice."

Categories 1 and 2 are the ones the published false-negative number is measured against
(§1.11).

## 1.3 What auto mode drops on entry

"On entering auto mode, we drop permission rules that are known to grant arbitrary code
execution, including blanket shell access, wildcarded script interpreters (python, node,
ruby, and similar), and package manager run commands."

Kept: "Narrow rules ('allow running code formatters') carry over, but broad interpreter
escapes don't."

Stated limit: "While this is best-effort based on real-world usage, any list will inevitably
be incomplete."

The article does not describe how auto mode interacts with deny rules, ask rules,
`.claude/settings.json`, or hooks. Silent.

## 1.4 The three decision tiers, in precedence order

**Tier 1 — fixed allowlist, no classifier call.** "A fixed allowlist includes tools that
can't modify state, including file reads, text and file-pattern search, code navigation,
todo and plan-mode transitions." User-configured always-allow rules act as additions here,
subject to the drop in §1.3.

**Tier 2 — in-project file writes, no classifier call.** "File writes and edits inside the
project directory are allowed without a classifier call. Routine coding (e.g. editing source
files in your repo) doesn't pay classifier latency; in-project edits are reviewable via
version control."

**Tier 3 — the transcript classifier.** Everything else: "shell commands, web fetches,
external tool integrations, subagent spawns, filesystem operations outside the project
directory."

The article states no carve-out from tier 2 — nothing about `.git`, `.claude/settings.json`,
or other in-project paths whose contents change what later commands do. Whether the shipped
implementation carves any out is not addressed.

## 1.5 The two-stage classifier

Model: "the transcript classifier (running on Sonnet 4.6)".

**Stage 1** — "fast single-token (yes/no) filter instructed to err toward blocking". No
reasoning emitted.

**Stage 2** — chain-of-thought, run only on actions stage 1 flags.

Cost property: "stage 2's prompt is almost entirely cache-hit from stage 1", because the
inputs are identical except the final instruction.

The article gives **no latency figure** — no per-call milliseconds, no added turn time, no
token cost. It refers to "classifier latency" as the thing tier 2 exists to avoid, without
quantifying it.

The accuracy trade is the whole point of the split: stage 1 alone is 8.5% FPR / 6.6% FNR;
the pipeline is 0.4% FPR / 17% FNR (§1.11). Stage 2 only converts blocks into allows.

## 1.6 What the classifier is shown, and what is stripped

**Shown:** user messages, and the agent's tool calls (the executable payloads).

**Stripped — assistant text and reasoning.** "We strip assistant text so the agent can't talk
the classifier into making a bad call." The article names the resulting property: the
classifier is "reasoning-blind by design", and this buys a complementary defence — "a model
that conceals misaligned reasoning can still be caught here if the resulting action trips a
block rule."

**Stripped — tool outputs/results.** Two reasons. "the classifier rarely needs them"; and it
is "the primary prompt-injection defense, since tool outputs are where hostile content enters
the context."

**Stripped — tool-call descriptions**, to keep the transcript short. *(single pass)*

**Accepted cost — provenance.** "There is a tradeoff in terms of provenance. If the user
never named 'job abc123,' the classifier can't tell whether the agent pulled it from a query
or fabricated it."

**Rejected variant — tool calls only.** "A tool-calls-only variant had the lowest
false-negative rate still but lost the user-intent anchor, blocking actions the user had
plainly asked for." User messages are in the input precisely to anchor intent.

## 1.7 The prompt: fixed template plus three customizable slots

"The fixed parts do the interpretive work—how to determine what an action actually does, how
to read user authorization, the classification process itself—and they're the same for
everyone."

The three slots:

1. **Environment** — "defines the trust boundary of which domains, cloud buckets,
   source-control orgs, and internal services count as 'inside' versus 'external.'" Default:
   "By default, the only thing the classifier trusts is the git repo you're currently working
   in."
2. **Block rules** — "the default has more than twenty block rules".
3. **Allow exceptions** — "mandatory carve-outs where a block rule technically matches but
   the action is benign." Default: "installing packages already declared in the repo's
   manifest, standard credential flows, and pushing to the session's working branch."

**Classification process** (fixed): block rules → allow exceptions → user intent → decision.

## 1.8 The block rules

The article does not enumerate the twenty-plus rules. It gives four groupings, each with
examples:

1. **Destroy or exfiltrate** — "Cause irreversible loss by force-pushing over history,
   mass-deleting cloud storage, or sending internal data externally."
2. **Degrade security posture** — "Make the system harder to monitor or defend by disabling
   logging, installing persistence like SSH keys or cronjobs, or modifying the agent's own
   permission config."
3. **Cross trust boundaries** — "Act on things the agent has no basis to trust, like running
   code cloned from external repos, scanning credential stores for usable tokens, or sending
   data to a service the user never specified."
4. **Bypass review or affect others** — "Skip safeguards on shared infrastructure by pushing
   directly to main, running production deploys, or modifying shared resources or jobs the
   agent didn't create."

Individual rule text, rule count per group, and rule identifiers: **not published**.

## 1.9 The evaluation rules (fixed template)

The governing rule: "evaluate the real-world impact of an action, rather than just the
surface text of the invocation."

Two stated consequences:

- **Chains are one action.** "If a chain of commands is joined with `&&`, the whole chain is
  one action."
- **Payloads are evaluated before execution.** "If the agent writes a Python script assembling
  a shell command, the classifier evaluates the assembled command from the transcript context
  before allowing the script to be executed."

## 1.10 The user-intent rules (fixed template)

"The classifier has to decide whether the action is something the user authorized, not just an
action related to the user's goal. The classifier is deliberately conservative."

The anchor: "The prompt establishes what is authorized; everything the agent chooses on its
own is unauthorized until the user says otherwise."

Worked example: "clean up my branches" does not authorize a batch delete.

## 1.11 Results — every published number

| Figure | What it measures | Dataset | n |
| --- | --- | --- | --- |
| 93% | permission prompts users approve | Claude Code users | not stated |
| 8.5% | **stage 1** false-positive rate | real internal traffic | 10,000 |
| 6.6% | **stage 1** false-negative rate | real overeager actions | 52 |
| 1.8% | **stage 1** false-negative rate | synthetic data exfiltration | 1,000 |
| 0.4% | **pipeline** false-positive rate | real internal traffic | 10,000 |
| 17% | **pipeline** false-negative rate | real overeager actions | 52 |
| 5.7% | **pipeline** false-negative rate | synthetic data exfiltration | 1,000 |
| >20 | default block rules | — | — |
| 3 / 20 | escalation thresholds | — | — |

Dataset construction, as described: real internal traffic is Claude Code tool calls from
Anthropic employees; **real overeager actions (n=52)** is curated from sessions where
employees denied an action or an incident was flagged retroactively, and its size reflects how
rare it is to capture genuinely dangerous behaviour in real usage; **synthetic exfiltration
(n=1,000)** is generated attempts — HTTP POSTs carrying sensitive data, unauthorized git
pushes, embedded credentials, often obfuscated.

Note the direction: stage 2 only turns blocks into allows, so FPR falls (8.5 → 0.4) and FNR
rises (6.6 → 17; 1.8 → 5.7).

## 1.12 The stated false-negative failure mode

"The classifier finds approval-shaped evidence and stops short of checking whether it's
consent for the blast radius of the action."

In most misses the classifier "correctly identifies the danger" — the failure is in the
consent judgement, not in the risk judgement. This is the failure mode of §1.10, not of §1.8.

## 1.13 Denial handling, escalation, and headless

**Deny-and-continue is the default.** A denial does not end the session; the agent is expected
to "recover and try a safer approach where one exists", and in practice will "reconsider, and
usually find an alternative path".

**The denial reaches the agent as a tool result plus an instruction.** The denial "comes back
as a tool result along with an instruction" to "treat the boundary in good faith: find a safer
path, don't try to route around the block."

**Escalation thresholds.** "3 consecutive denials or 20 total". On trip, the system "stop[s]
the model and escalate[s] to the human."

The Aug 7 blog states the same thresholds as a **mode change**: "If it can't make progress—three
blocks in a row, or twenty across a session—Claude Code falls back to manual approvals."

**Headless.** "In headless mode (`claude -p`) there is no UI to ask the human, so we instead
terminate the process."

**Why deny-and-continue rather than deny-and-kill.** "A 0.4% FPR sounds small, but if every
false positive killed the session it would be a serious usability problem for long-running
tasks." A false positive is priced as one retry, not one lost session.

## 1.14 Prompt injection: two layers that compose

**Input layer — a probe on tool output, separate from the classifier.** It screens tool
outputs — "file reads, web fetches, shell output, external tool responses" — before they enter
the agent's context. On detection it does not drop the content: "the probe adds a warning to
the agent's context before the result is passed along—telling the agent to treat this content
as suspect and anchor on what the user actually asked for". The blog calls it "an API-side
probe".

**Output layer — the transcript classifier**, which by construction never sees the tool output
that carried the injection (§1.6).

**Composition, stated explicitly:** "For an injection to succeed end-to-end, it must evade
detection at the input layer, then steer the agent into emitting a tool call that the
transcript classifier independently judges as both safe and aligned with user intent."

This is the article's most important structural claim, and it is the one our own plan doc gets
wrong — see §2.5.

## 1.15 Multi-agent handoffs, both directions

**Outbound** — classify the delegation before it happens, "while it's still recognizable as an
agent choice rather than a user request." Reason: "The outbound check exists because, without
it, the transcript classifier that monitors the subagent may not have the full context to know
if the task it was given was originally intended by the user."

**Inbound** — "Before results go back to the orchestrator, the classifier reviews the
subagent's full action history. If it flags, we prepend a security warning for the agent that
started the subagent rather than discard the results."

Both directions warn rather than discard.

## 1.16 Where the article says auto mode is not appropriate

"Whether 17% is acceptable depends on what you're comparing against." The comparison is drawn
between users on unrestricted mode and users manually reviewing every action, and only the
first group is the audience:

> "not a drop-in replacement for careful human review on high-stakes infrastructure"

And on residual risk: "We encourage users to stay aware of residual risk, use judgment about
which tasks and environments they run autonomously, and tell us when auto mode gets things
wrong."

The stance on completeness: "The classifier doesn't need to be flawless to be valuable" —
the bar is "enough dangerous actions to make autonomous operation substantially safer than no
guardrails".

## 1.17 What's next (as published)

Expanding the real-overeagerness test set, and iterating on the safety and cost of the
feature. No architectural change signalled.

## 1.18 What the article is silent on

Stated explicitly so nothing below reads as inference from a gap:

- Any latency, token, or dollar cost figure for a classifier call.
- The identity or text of the individual block rules, or how many fall in each of the four
  groups.
- Whether tier 2 carves out any in-project path.
- How auto mode composes with deny rules, ask rules, settings files, or hooks.
- What the classifier does with a tool call it cannot parse.
- Whether a denial is recorded durably, attributed to a rule, or countable per rule — the 3/20
  counters must count something, but the article never says the count is attributable or
  persisted.
- Any evaluation of a deterministic-rule baseline. There is no published comparison of "rules
  plus sandbox" against "classifier", in either direction.
- Any distinction between working trees — one project directory, one trust boundary.
- Whether a git push destination is checked for public/private/trusted, or repository state is
  read before a destructive git command. **Both appear only in the Aug 7 blog**, not the
  engineering post.

## 1.19 What the blog says that the engineering post does not

The Aug 7 post is a product announcement and carries a different, larger set of numbers. It is
worth reading as a separate evidence base, not as a restatement.

Classifier mechanics not in the engineering post:

- "checks whether the destination of a git push or pull request is public, private, or trusted
  before the action runs".
- "Before a command that could discard uncommitted work, like `git reset --hard`, the
  classifier sees the repository's current git status, letting auto mode know what is being
  reset."
- A hard-deny category: "Data exfiltration, like sending your code or secrets somewhere
  external, sits in a category the classifier is designed to never approve."
- The injection probe described as API-side.

Numbers, all blog-only:

| Figure | What it measures |
| --- | --- |
| 97% / 3% | permission prompts approved / rejected |
| 39% | plans rejected |
| 49.5% | active CLI users who created a Bash allow-rule |
| 43% | users with interpreter rules (`Bash(python:*)`, `Bash(node:*)`) |
| 5% | users allowing any shell command outright |
| 62% | users who have used `bypassPermissions` or "don't ask again" on Bash |
| 25% | interactive sessions starting in bypass permissions mode |
| 13.6% (143 of 1,053) | dangerous commands caught by human testers |
| 89% (937 of 1,053) | the same commands blocked by auto mode |
| 800 vs 6 | commands auto mode blocked that a human approved, vs the reverse |
| 6.3% vs 2.4% | severity-7+ harmful actions in manual vs auto mode sessions |
| 12% → 7% | Apollo Research red-team miss rate, before and after hardening |
| 720 | injection attempts, none successful against Claude models in auto mode |
| 5.83% / 19.03% | attack success against GPT-5.6 Sol in Codex Auto-review / Full Access |
| ~25% | more PRs shipped by auto mode users among Teams & Enterprise adopters |
| ~10% | Gusto sessions containing a classifier denial |

Study design, blog-only: "1,053 paid testers through a research vendor for a coding study",
in a purpose-built test environment, blind as to what was being measured; "Partway through
each session, a single permission prompt was swapped for a clearly dangerous command", and
"approving the prompt never resulted in anything dangerous being run."

The 93% (Mar) and 97% (Aug) approval figures are both real and from different posts five
months apart. `docs/plans/authority-and-runtime-shape.md` cites the 97%/39% pair; that is the
blog's number and the citation is correct, but the engineering post's 93% should be the one
quoted whenever the engineering post is the source.

---

# Part 2 — The mapping onto Volli

What exists on our side, for reference:

- `packages/shared/src/authority.ts` — `AuthoritySnapshot`, `WorkLocationKind`,
  `AUTHORITY_RULE_IDS` (10), `OVERRIDABLE_AUTHORITY_RULES` (3), `AuthorityDenialCause`
  (11 = 10 rules + `call.unreadable`), `AuthorityFallback` (3 consecutive / 20 per Session),
  `classifierModel: null`.
- `packages/shared/src/authority-policy.ts` — `evaluate()`, first-match-wins over
  `AUTHORITY_RULE_IDS`.
- `packages/agent-runtime/src/authority/` — `gate.ts` (fails closed on an unnormalizable
  call), `normalize.ts` (path resolution, shell lexing, transparent-prefix peeling, nested
  `sh -c` splicing to depth 4), `vendor/{shell,paths}.ts`.
- `packages/agent-runtime/src/pi/runtime.ts:591` — `beforeToolCall` calls the gate, commits
  `authority.denied` through the ordered queue, then returns `{ block: true, reason }`;
  `terminate` deliberately unset.
- `packages/agent-runtime/src/pi/scoped-execution-env.ts:179` — per-command Seatbelt:
  `deniedDomains: ["*"]` with `strictAllowlist`, `denyRead: [homeDir]`,
  `allowRead/allowWrite: [workspace]`, `denyWrite` covering `.git/hooks`, `.git/config`,
  `.git/modules/**/hooks`, `.git/modules/**/config`, plus scratch paths; sanitized child env.
- Tool bundle: `CodingToolId = "read" | "edit" | "write" | "execute"`. No web fetch, no
  subagent tool, no MCP tools.

## 2.1 Where the designs agree, and where they deliberately differ

### The real axis of difference is not model-vs-rules. It is intent-blindness.

Anthropic's classifier is anchored on user messages: "The prompt establishes what is
authorized; everything the agent chooses on its own is unauthorized until the user says
otherwise." When they removed that anchor, the result was worse — the tool-calls-only variant
"had the lowest false-negative rate still but lost the user-intent anchor".

Volli's `evaluate(call, snapshot, context)` sees a normalized call, the snapshot, and a
workspace path. It never sees a user message. Volli is not running the tool-calls-only variant
Anthropic rejected — it is running something narrower than that variant: a fixed rule table
over one call, with no transcript at all.

That framing matters because it relocates the disagreement. The two designs do not disagree
about whether a model is needed to judge risk. They disagree about whether *authorization
scope* is part of the decision. Anthropic says it is the decision. Volli currently answers a
different question — "does this call cross a boundary" — and answers it well.

### Agreements

- **Auto by default, scrutiny at intent.** Both. Volli's plan cites the same reasoning from
  the blog.
- **Deny-and-continue, not deny-and-kill.** `runtime.ts:588` leaves Pi's `terminate` unset on
  purpose; the article's rationale is the FPR-times-session-length argument in §1.13. Same
  choice, same reason.
- **Denial text is written for the model.** `authority-policy.ts` header: "Reasons are written
  for the model, not for a log." Article: the denial "comes back as a tool result along with
  an instruction". Same instinct, and Volli's reasons name the offending path and the remedy.
  The good-faith instruction itself is missing — §2.2 item 3.
- **A category that is never approvable.** `OVERRIDABLE_AUTHORITY_RULES` names 3 of 10;
  the other 7 report only. Blog: exfiltration "sits in a category the classifier is designed to
  never approve." Same shape, different membership.
- **Chained commands do not launder intent.** Article: "If a chain of commands is joined with
  `&&`, the whole chain is one action." Volli lexes the chain into segments and any refusing
  segment refuses the call. Same outcome by a different mechanism — with one asymmetry worth
  naming: Volli judges each segment *independently*, so it catches a dangerous segment but
  cannot see a dangerous *aggregate* assembled from individually-innocent parts. Anthropic's
  rule can, because a model reads the whole chain.
- **Immunity to being argued with.** Anthropic strips assistant text "so the agent can't talk
  the classifier into making a bad call." Volli gets that property for free: nothing textual
  reaches `evaluate()`.
- **Fail toward the deny-list under ambiguity.** Anthropic's stage 1 is "instructed to err
  toward blocking". Volli folds case for every deny-list comparison and not for containment,
  for the same directional reason, and `gate.ts` refuses a call it cannot normalize.
- **3 / 20.** Copied verbatim, and `authority.ts` says so.

### Deliberate differences

| | Anthropic | Volli |
| --- | --- | --- |
| Decider | Sonnet 4.6, two stages | 10 pure predicates, first-match-wins |
| Input | user messages + tool calls | one normalized call |
| Boundary underneath | none (sandbox declined) | per-command Seatbelt, network denied |
| Network | agent has it; classifier polices it | denied outright, `deniedDomains: ["*"]` |
| Tool surface | open, allowlisted by tier | closed bundle of 4; unlisted tool is a denial |
| In-project writes | tier 2, no classifier call | judged by rules 2–4 |
| Work location | one project directory | `worktree` vs `main-checkout` changes the rules |
| Denial identity | aggregate rate | named rule id, durable event, per-Session count |

### Scoring our own stated reasons against the article

The plan doc's "Why no classifier yet" makes three claims. The article's verdict on each:

**(a) "A classifier earns its cost when the dangerous categories are reachable … a per-call
model invocation would mostly re-derive what the kernel already guarantees."**

*Partly supported, and the supported part is large.* Three of the four block-rule groups are
substantially unreachable for a Volli Session: "sending internal data externally" and "sending
data to a service the user never specified" need network; "scanning credential stores for
usable tokens" and "installing persistence like SSH keys or cronjobs" need the home directory;
"mass-deleting cloud storage", "running production deploys" and "pushing directly to main" all
need network. With `deniedDomains: ["*"]` and `denyRead: [homeDir]`, most of Anthropic's own
default block set is enforced by the kernel before any decider runs.

The article also supports the *shape* of the argument in its own tier 2: it skips the
classifier for in-project writes because "in-project edits are reviewable via version control."
A Ticket worktree is that argument taken further — branch-isolated and disposable. Anthropic's
own tiering endorses not paying for a decider where the blast radius is already bounded.

*But the claim is too strong as written.* Anthropic's classifier is not primarily a boundary
enforcer; it is an intent checker. Group 1's "force-pushing over history", group 2's
"modifying the agent's own permission config", group 4's "modifying shared resources … the
agent didn't create" and every one of the five illustrated incidents are scope failures inside
capability the agent legitimately has. A kernel cannot guarantee anything about those, so
"re-derive what the kernel already guarantees" understates what the classifier does. Correct
the sentence.

**(b) "Deterministic rules plus the existing sandbox cover the realistic risk."**

*Not undercut on safety; undercut on coverage.* The article's objection to sandboxing is
maintenance and capability loss — "each new capability needs configuring, and anything
requiring network or host access breaks isolation" — which is a cost claim, and one Volli
knowingly paid (the agent has no network at all). Nothing in the article argues a sandbox
fails to contain what it contains.

What does undercut (b) is the residual the article catalogues *inside* a bounded workspace:
overeager scope escalation, honest mistakes, and injected instructions that produce
rule-legal calls. Volli's ten rules have no predicate that could fire on any of them. "Covers
the realistic risk" is true for the exfiltration and persistence classes and false for the
overeagerness class, which is the class the article's 17% is measured against.

**(c) "It becomes warranted when either … network egress is allowlisted … or the Main-checkout
Role ships."**

*Not addressed.* The article never discusses two work locations, and never treats network
egress policy as a variable that changes whether a classifier is needed — it assumes the agent
has network and builds the classifier around that. The trigger conditions are ours alone; the
article neither supports nor contradicts them.

**One more thing the article does not give us:** any number to argue this with. There is no
published deterministic-rule baseline, in either direction. The 0.4%/17% pair describes a
classifier against no guardrails, not a classifier against rules-plus-sandbox.

## 2.2 What the article has that we lack, ranked by outcome change

**1. User-intent anchoring. The largest gap by a wide margin.**

Mechanism: the classifier reads user messages and asks whether the action is *authorized*, not
merely related — "clean up my branches" not authorizing a batch delete.

Where it would land: not in `authority-policy.ts`, which is pure over one call and structurally
cannot see a transcript. It is exactly what `AuthoritySnapshot.classifierModel` was left null
for, called from `packages/agent-runtime/src/authority/gate.ts` after `evaluate()` returns
allow — the deterministic table first, the intent check second, matching the article's block
rules → allow exceptions → user intent order.

What it catches that we miss today, all inside the sandbox and all rule-legal:

- A `git branch -D` sweep, or `git push --force` to the Session branch, after the user asked
  for a commit. Nothing in the ten rules touches either in a worktree.
- `rm -rf src/legacy` when the user named one file. `command.destructive-removal` allows any
  strict descendant of the workspace.
- A bulk rewrite across files the user never mentioned. Rules 2–4 pass every in-workspace write
  that is not `.git` or `.volli`.
- The four of Anthropic's five illustrated incidents that do not need network — branch cleanup,
  credential grepping (partly blocked by `denyRead: [homeDir]`, not blocked for
  in-workspace `.env`), name-similarity target guessing, and safety-check bypass by retrying
  with a skip flag.

**2. The input-layer prompt-injection probe.**

Mechanism: screen tool output before it enters context; on detection prepend a warning telling
the agent "to treat this content as suspect and anchor on what the user actually asked for".

Where it would land: `packages/agent-runtime/src/pi/runtime.ts`, on the result path.
*Inference, not fact:* whether Pi exposes an after-tool-call seam is not established anywhere
in our plan docs and was not verified in this pass — that is the first thing to check.

What it catches: our bundle has no web fetch tool, so the injection surface is narrower than
Anthropic's — it is file reads and command output inside the workspace. Network denial closes
the exfiltration path but not the destructive one: an injected instruction in a vendored
README or a dependency's source can still steer a Session into destroying its own tree, or
into writing code that the publish path — which runs `add`/`commit` in main, **outside the
sandbox** (`apps/desktop/src/main/worktree/publish.ts`) — later commits.

The composition point is what makes this rank second rather than fifth. The article's guarantee
is that an injection must beat *two independent* layers, one of which is intent-anchored.
Volli has one layer, and it is intent-blind. An injected instruction that produces a rule-legal
call is allowed with no further check.

**3. The good-faith instruction on a denial. Cheapest item on this list.**

Mechanism: the denial "comes back as a tool result along with an instruction" to "treat the
boundary in good faith: find a safer path, don't try to route around the block."

Where it would land: `packages/agent-runtime/src/pi/runtime.ts:614`, as a fixed suffix on the
returned `reason`, or in `authority-policy.ts` as a shared constant appended by `evaluate()`.

What it catches: the exact failure the Part I record already prices — "`rm` is strict on every
operand, and that has a priced cost … the natural retry is another `rm` in the same loop and
three of them trip the consecutive-denial threshold." A model told not to route around a block
retries differently. This is the mechanism that makes deny-and-continue work at all, and it is
one string.

**4. The two-stage cost architecture.**

Not an outcome change today; it changes what the classifier option costs when we take it.
Stage 1 single-token, "instructed to err toward blocking", 8.5% FPR; stage 2 chain-of-thought
only on flags, 0.4% FPR; "stage 2's prompt is almost entirely cache-hit from stage 1". Take
the shape wholesale when `classifierModel` becomes non-null.

**5. Trust-boundary configuration (the `environment` slot).**

Volli's trust boundary is one string, `PolicyContext.workspacePath`. Anthropic's is a
configurable set of "domains, cloud buckets, source-control orgs, and internal services". This
only starts to matter under our own stated trigger — network egress allowlisting — at which
point `PolicyContext` in `packages/shared/src/authority.ts` is where it goes.

**6. Repository state before a destructive git command** (blog-only). "the classifier sees the
repository's current git status, letting auto mode know what is being reset."
`command.git-discards-work` fires on command shape alone and only in a Main checkout, so it
refuses `git reset --hard` in a clean tree where nothing would be lost. This is a
false-positive reducer, and the plan already establishes that machine facts are computed per
call, so the seam exists.

**7. Multi-agent handoff checks.** Not applicable. Our bundle is `read | edit | write |
execute` and `tool.not-bundled` denies anything else, so a subagent spawn is already a denial —
a stricter answer than the outbound check. It becomes relevant the day a task tool joins the
bundle, and both directions should be built then.

### The Part I accepted residuals, checked against the article

| Residual (from the Part I implementation record) | Would a classifier close it? |
| --- | --- |
| `cp <workspace>/secret /tmp/leak` not refused | **No, and it does not need to.** Anthropic's block rule is "sending internal data externally"; a local copy on the user's own machine with no network is not that. A classifier would likely flag it on shape and be wrong. Leave it. |
| `cp evil.sh .git/hooks/pre-commit` unreachable by the rule table | **No.** The sandbox `denyWrite` closes it. Worth noting the article would be *weaker* here — tier 2 allows in-project file writes with no classifier call and states no `.git` carve-out. |
| `rm -rf $f` in a loop refused (false positive, self-amplifying) | **Yes.** This is precisely what stage 2 exists for: convert an over-blocking fast decider into 0.4% FPR. Until then, item 3 above is the mitigation. |
| A Session cannot set its own git identity | Not addressed by the article; irrelevant. |
| `beforeToolCall` is advisory, covers tool calls only | **No.** Anthropic's classifier has the same property — it judges tool calls and enforces nothing below them. Their gap is larger, because they have no sandbox under it. |
| Shell lexer bypasses: `eval`, base64, command substitution, `xargs` | **Yes, in principle.** "evaluate the real-world impact of an action, rather than just the surface text" is exactly the rule a lexer cannot implement. This is the strongest *technical* argument in the article for a classifier over a rule table, and the plan doc already concedes the lexer is "unsound as a standalone boundary". |

## 2.3 What we have that the article does not

**1. Work location as a policy variable.** `WorkLocationKind = "worktree" | "main-checkout"`,
carried on the snapshot, read by `command.git-discards-work`, and set from
`ticket.usesWorktree` rather than inferred from Role. The article has one project directory
and one trust boundary. Its tier 2 rationale — "in-project edits are reviewable via version
control" — assumes a version-control safety net without asking whether the tree contains
uncommitted human work. Volli asks. The precedent for this is Codex's `writable_roots`, not
Claude Code; the plan doc already says so, and the article confirms it by omission.

**2. Named, countable, durable denials.** `AUTHORITY_RULE_IDS` gives ten names,
first-match-wins gives exactly one per refusal, `authority.denied` persists which tool, which
rule and the rule's own words, and `SessionProjection.authorityDenials` counts them. The
article publishes aggregate rates and never says a denial is attributable or persisted. The
practical consequence is real: our open decision "whether the fallback thresholds stay at 3/20
or are tuned against real usage" is answerable from our own ledger, per rule. Anthropic's
equivalent answer is "expanding the real overeagerness testset".

**3. A kernel boundary underneath.** Per-command Seatbelt with network denied, home denied,
workspace-scoped writes, a sanitized child environment, and symlink-proof file tools. Anthropic
declined this and said why. We paid the cost they name — the agent has no network at all — and
got the containment they gave up. This is a trade in the opposite direction, not an oversight,
and it is the reason most of their default block set is moot for us.

**4. Overridable versus reporting-only refusals.** `OVERRIDABLE_AUTHORITY_RULES` splits the ten
by whether consent could do anything: three rules where a "yes" is both honourable and
reasonable, seven where it is either unhonourable (`path.outside-workspace` — Seatbelt refuses
regardless) or must not be granted (a login item outlives the Session). The article has one
approve/deny verdict and one escalation; nothing in it distinguishes "the user could grant
this" from "the user's yes cannot be honoured".

**5. Fail-closed on an unreadable call.** `gate.ts` refuses with `call.unreadable` when a path
will not resolve or an argument is not the shape the schema promised, and refuses under its own
name rather than borrowing a rule's. The article does not say what its classifier does with a
call it cannot parse.

**6. A closed tool bundle rather than an allowlist over an open surface.** `tool.not-bundled`
means an unlisted tool is a policy denial, not merely absent. Anthropic's tier 1 is an
allowlist over whatever tools exist; ours is a bundle with nothing outside it.

**7. Case-folding discipline.** Deny-list comparisons fold, containment does not, and the
reason is written down. The article says nothing about obfuscation at the lexical level.

## 2.4 Corrections to the Slice 4 design

Read `docs/plans/authority-and-runtime-shape.md` § "Slice 4 — scope, settled" against §1.13.

**(a) Our escalation is a check-in; Anthropic's is a mode change. Name it correctly.**

Slice 4: "After any escalation both trips move forward — consecutive to zero, the session trip
to `total + sessionDenials` — so it fires every twenty rather than once and then on every call
after."

Anthropic: on trip they "stop the model and escalate to the human", and the blog says Claude
Code "falls back to manual approvals". That is not one question — it is the end of auto mode
for that session.

Volli asks one question and re-arms auto. **This is a deliberate fit, not a mistake:** Volli
has no manual-approval mode to fall back *to*. `interaction.permission` gates one call; there
is no per-call approval surface for every subsequent call, and building one would rebuild the
prompt fatigue the whole design rejects. But the plan calls it a "fallback", which is
Anthropic's word for something we are not doing. Call it a check-in, and note in the doc that
the third option Anthropic actually takes — stay in the session, stop deciding automatically —
is not expressible here.

**(b) The thresholds were tuned against a 0.4%-FPR decider. Ours is not that decider.**

This is the sharpest correction, and it is still fixable because slice 4 has not shipped.

Anthropic's 3-consecutive and 20-total count denials from a pipeline measured at **0.4% FPR on
10,000 real tool calls**. Volli's counters count refusals from a rule table whose false-positive
rate is unmeasured and, on the evidence in our own Part I record, plausibly far higher: the
record documents that `2>/dev/null` alone "would have tripped the three-consecutive fallback on
ordinary work" before `path.outside-workspace` was narrowed, and that `rm -rf $f` in an ordinary
cleanup loop is refused and self-amplifying.

Copying a threshold across two deciders with different error profiles is copying a number, not
a design. Slice 3 already made denials countable per rule. **Before slice 4 ships the
thresholds, read the `authority.denied` records and compute a per-rule denial rate.** The plan's
open decision already anticipates this ("Slice 3 made denials countable, so there is a record to
tune against"); what is new is that the article gives the reason it matters: 3-consecutive
against a 0.4%-FPR classifier and 3-consecutive against a rule table that refuses a cleanup
loop are different products.

**(c) `call.unreadable` should probably not feed the consecutive counter.**

Anthropic's counters count classifier denials — policy judgements. Volli's
`AuthorityDenialCause` is wider by exactly one, and `call.unreadable` is a parse failure, not a
risk judgement. Three unresolvable `$VAR` operands in an `rm` loop trip escalation on a lexer
limitation. Either exclude it from the consecutive counter, or accept it as a deliberate
"policy cannot read this, ask a human" escape hatch — which is defensible — but make it a
stated decision rather than a side effect of the union's width.

**(d) The good-faith instruction is missing, and slice 4 does not add it.**

§2.2 item 3. It belongs on *every* denial, not on escalating ones, because it is what keeps the
consecutive counter from filling with retries of the same blocked shape.

**(e) Headless: our answer differs and is defensible.**

Anthropic terminates the process because "there is no UI to ask the human". Volli's `ask` port
"blocks with no invented timeout", and cancellation comes from the existing vocabulary
(`abandoned`, `superseded`, `withdrawn`). An unattended Session parks rather than dies.

That is the right answer here and the reason is already in the code:
`sessionAwaitsUser()` in `packages/shared/src/session-ledger.ts` treats an open interaction as
"waiting on the user", so a parked Session surfaces in the chat listing and the sidebar's
Active band, and the interaction is durable across restarts. Anthropic terminates because their
headless process has no such surface. Not a divergence to fix — but the plan doc should say
this explicitly, because the article's headless rule reads as a gap in ours until you know
`sessionAwaitsUser` exists.

**(f) The false-positive framing agrees, and slice 4 keeps it.**

"A 0.4% FPR sounds small, but if every false positive killed the session it would be a serious
usability problem for long-running tasks." `runtime.ts` leaves `terminate` unset; slice 4's
`[stop, continue]` gives the user the kill switch rather than the policy. Correct, and the
article's framing is the argument for keeping it that way.

**(g) `[once, reject]` versus `[stop, continue]` has no counterpart in the article.**

Nothing to correct — the article has one verdict and one escalation. Our split is finer, and
§2.3 item 4 is the reason it is worth keeping.

## 2.5 One factual error in our own plan doc

`docs/plans/authority-and-runtime-shape.md` § "Product decision" says Anthropic's auto mode
"routes every tool call through a classifier that … screens fetched content for prompt
injection".

It does not. Injection screening is a **separate input-layer probe** on tool output, and the
transcript classifier is defined by *never seeing* tool output — that stripping is, in the
article's words, "the primary prompt-injection defense". The two are independent layers whose
independence is the guarantee: "For an injection to succeed end-to-end, it must evade detection
at the input layer, then steer the agent into emitting a tool call that the transcript
classifier independently judges as both safe and aligned with user intent."

Collapsing them into one sentence hid the fact that Volli lacks an entire layer, and made the
"why no classifier yet" argument look like it covered injection when nothing in Volli does.
Worth correcting in the plan doc when it is next touched.

The same paragraph's other claims check out against the blog (§1.19): the push-destination
check and the pre-`reset --hard` git status are both real, both blog-only, and neither appears
in the engineering post.
