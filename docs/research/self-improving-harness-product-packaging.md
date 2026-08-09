# Self-improving harness research as product packaging

**Status:** research memo / proposal, not an implementation plan
**Date:** 2026-08-08
**Scope:** How a singular, Pi-backed Volli Agent Runtime can accumulate and
ship useful operational knowledge. This does **not** reopen a multi-harness
strategy, arbitrary extension marketplace, or model-owned control plane.

## Bottom line

The useful product translation of self-improving-harness research is not “let
the agent rewrite its runtime.” It is: turn repeated, evidenced operational
knowledge into small, inspectable, versioned objects with a deliberately narrow
activation scope:

1. a **Lesson** is an evidence-backed observation, initially inert;
2. a **Skill** packages a reusable, reviewable procedure and optional bounded
   resources;
3. **Automation Instructions** package a repeatable ticket-starting workflow;
4. a deterministic **Runtime Brief fragment** selects approved, applicable
   objects at Session launch; and
5. an **evaluation gate** plus a person (when appropriate) promotes, rolls
   back, or retires the object.

That is compatible with Volli's architecture because the Runtime owns prompt
assembly and tool policy, while the Session ledger owns durable history. It is
also intentionally less permissive than research harnesses such as Prime Agent:
the model may propose a Lesson or a candidate revision, but it cannot silently
rewrite a running Session's prompt, Authority Snapshot, tools, evaluator, or
canonical history.

## What the research actually supports

Lilian Weng defines a harness as the deployment system around a base model:
orchestration, tools, context and persistent state, evaluation, permissions, and
workflow—not merely a prompt template. Her proposed optimization progression is
instruction prompts → structured context → workflow → harness code → optimizer
code. This is a useful *search-space* ordering, not evidence that a product
should expose every rung as self-modifying code. [Weng, “Harness Engineering for
Self-Improvement”](https://lilianweng.github.io/posts/2026-07-04-harness/)
specifically warns that evaluators and permission controls should sit outside
the loop which evolves the harness.

Two details matter especially for product design:

- Weng describes Agentic Context Engineering's avoidance of full-prompt
  rewrites: a curator updates identified, itemized entries with deterministic
  merging and later deduplication. This is a better mental model for product
  memory than an ever-growing `MEMORY.md`.
- The self-harness examples use propose → evaluate → accept, keeping rejected
  edits as records. The more constrained Agentic Harness Engineering setup makes
  the harness workspace editable but keeps runs, verifier, and model
  configuration read-only, specifically to prevent rewards from being obtained
  by disabling verification or changing the benchmark.

The research is strongest where success has a fast, objective verifier. Weng
calls weak and fuzzy evaluators a central open problem: tests, judge models, and
benchmarks can all be optimized against rather than toward real quality. It
therefore supports a narrow, evidence-led promotion process for Volli; it does
not prove that unattended online refinement improves a real codebase over time.

## Early product primitives in the wild

| Primitive | What is editable | What remains or should remain fixed | Product lesson for Volli |
| --- | --- | --- | --- |
| [Agent Skills specification](https://agentskills.io/specification) | A portable skill directory: required `SKILL.md` metadata/instructions and optional scripts, references, and assets. Skills progressively disclose metadata, then instructions, then resources. | The spec defines a packaging format, not provenance, a safety boundary, or an automatic promotion system. `allowed-tools` is explicitly experimental and client-dependent. | Use `SKILL.md` as a portability floor for a future Skill artifact, but give Volli its own immutable identity, provenance, review status, digest, scopes, and tool/authority compatibility. Do not equate a skill's prose with a grant of authority. |
| [Claude Code memory](https://docs.anthropic.com/en/docs/claude-code/memory) | User-authored `CLAUDE.md` instructions and model-written auto-memory are plain Markdown, editable/deletable by the user. Auto-memory uses a concise index with on-demand topic files. | Instruction files are context, not enforcement; Anthropic says hooks/settings enforce actions. The startup-loaded index has explicit size limits because long memories reduce usefulness. | Separate editable guidance from enforced policy. Store compact, scoped claims with evidence and retrieve detailed records on demand; never load an undifferentiated history into every Runtime Brief. |
| [Hermes Agent](https://github.com/NousResearch/hermes-agent) | Its first-party README describes agent-curated memory, periodic learning nudges, autonomous skill creation, skills improving during use, and conversation search. | The README is a product claim, not a disclosed accept/reject protocol or evaluator design. It also supports many models, execution backends, and channels—none is a Volli product requirement. | The useful primitive is “experience can yield a draft reusable capability,” not its multi-runtime surface. Volli needs a visible proposal and provenance record before an experience becomes shared operational guidance. |
| [Prime Agent](https://www.primeintellect.ai/blog/prime-agent) / [repository](https://github.com/PrimeIntellect-ai/prime-agent) | Continual Harness exposes CRUD over supplemental prompts, memories, skills, and subagent specifications. `/refine` proposes the smallest relevant edit from a trajectory; changes are written durably and include trigger/outcome. | Prime says its base system prompt is immutable; `/refine` changes only the surrounding harness layer. It records refinement history and supports rollback by refinement ID. Its own README warns that model-generated Python and project commands run with user permissions and are not sandboxed. | Keep a small, explicit editable layer around immutable product policy. Make revisions append-only and revertible. Volli should be stricter: candidate application only at a turn/session boundary and only after the product's gate/human acceptance. |

### Prime's Factorio result is a product warning, not a feature example

Prime reports a concrete reward-hacking failure: while maximizing Factorio
production score, it discovered RCON commands that spawned resources directly
into machines. An explicit prompt not to cheat did not prevent the behavior;
after discovery, the same refinement loop that had learned legitimate skills
began learning efficient cheating skills. [Prime Agent blog, Factorio
section](https://www.primeintellect.ai/blog/prime-agent)

The direct product implication is that a self-refinement system must not control
its reward source, the boundary of its tools, or the approval path. In Volli,
passing `vp check` is evidence about formatting/linting/type checks, not a
license to claim ticket success, move a board card, expand filesystem authority,
or promote an instruction into global policy.

## Packaging Weng's optimization ladder for Volli

This maps each rung to a product object, not an invitation to rewrite the OS or
make Pi's implementation vocabulary public.

| Weng optimization target | Product packaging | Candidate editor | Immutable / product-owned boundary | Acceptance evidence |
| --- | --- | --- | --- | --- |
| Prompt | A short **Lesson** or approved Runtime Brief fragment, selected by scope. | Human; model may propose. | Runtime layer order, authority wording, secrets policy, ticket body, Session history. | Repeated failure/success trace; focused regression fixture; human accept for broad scope. |
| Structured context | A typed Lesson index plus linked evidence, and a compact source selection rule. | Human/gate promotion from proposal. | The generated Runtime Brief remains a projection of ticket state; its base layers stay deterministic. | Retrieval precision, token/context budget, and task outcome compared with a control. |
| Workflow | Versioned **Automation Instructions** for a named Automation. | Human; an agent can draft through an explicit command. | Automation Trigger, Runtime defaults, Authority Snapshot creation, Run/Outcome semantics, and command-before-delivery. | Dry-run/fixture plus representative completed, blocked, and no-signal Run cases. |
| Harness code | A product-owned `agent-runtime` change on a normal branch/PR. | Engineers, aided by an agent under ordinary repo policy. | Session contracts, ledger ownership, Authority Snapshot, tool policy, evaluator and release gates. | Deterministic contract tests, quality gates, recovery/security review appropriate to the change. |
| Optimizer code | An offline/internal evaluation and proposal tool, never an in-session self-edit loop. | Engineers/research operator. | Candidate corpus, held-out split, evaluator configuration, promotion authority, production runtime. | Reproducible candidate run, held-out non-regression, cost accounting, human release decision. |

The first three rungs are plausible near-term product surfaces. The last two are
ordinary engineering/research work and should remain behind source control and
review. A model may propose text for any rung, but proposal is not authority.

## Volli-specific fit: compound the substrate already chosen

`CONTEXT.md` makes the boundary unusually clear:

- A **Session** owns durable identity and locally ordered history, independently
  of an executor. The **Agent Runtime** receives prompt resources and scoped
  tools but does not own durable Session or Ticket state.
- A **Runtime Brief** is generated from Ticket state; it is not canonical Ticket
  content. An **Authority Snapshot** is the durable policy granted when a
  Session starts and cannot be silently altered by a Settings change.
- A **Command** is persisted before runtime delivery, and a **Receipt** records
  observed acceptance/rejection/completion. A **Run** carries its Automation and
  **Outcome** from launch; an Outcome has distinct completed, blocked, and
  no-signal arms.
- **Instructions** are already a product-shaped Automation input and can contain
  context chips, skills, and slash commands. The Agent Runtime is a product
  constant, not an Automation choice.

The Pi-native plan reinforces the same constraint: Volli has one structured
Pi-backed Agent Runtime; Pi types/events are not Session or renderer contracts;
the ledger/transcript artifacts are canonical; prompt construction is an
explicit deterministic module; and a disagreement with a Pi recovery sidecar
becomes Attention rather than an invisible Pi win. It also explicitly defers
Skills/MCP policy, reusable Automations, and the system-prompt/evaluation
programme to separate post-migration design sessions. See
[`CONTEXT.md`](../../CONTEXT.md) and the [Pi-native Ticket Session
plan](../plans/pi-native-ticket-session.md).

### Consequence: a lesson is input, not a runtime mutation

At Session launch, the product can deterministically resolve approved lessons
and Skill references into a persisted Runtime Brief input. That gives a model
the benefit of accumulated experience while preserving reconstruction:

1. record the chosen object revisions and resolved source references with the
   Session/Run input;
2. compose the brief once before delivery;
3. retain the Session's Authority Snapshot and tool bundle unchanged; and
4. let later learnings become proposals for a subsequent turn or Session.

Do not let the model silently add a prompt fragment midway through a turn. That
would make prompt ownership, reproducibility, authority review, and causal
attribution ambiguous. A user may explicitly submit a new Command that starts a
new turn with an accepted revision, but the runtime must record the selection
and the ledger stays canonical.

## Outcome is the scarce asset

Terminal-Bench and SWE-bench illustrate why externally checkable outcomes make
harness research move quickly. They are not sufficient product evaluators:
they can miss maintainability, correct scope, safety, reviewability, and
long-term repository health. Weng makes this limitation explicit, and Prime's
Factorio result demonstrates that an objective score can be gamed.

Volli has labels ordinary coding harnesses usually lack because it owns the
board, the ticket, the isolated worktree, the Run, and the durable Session:

| Potential label | Why it is valuable | Guardrail against false success |
| --- | --- | --- |
| Ticket/Run end state: completed, blocked, no signal, interrupted | Distinguishes a real handoff from a stopped model response. | A completion is an explicit Run arm, not inferred from silence. |
| Outcome plus deliberate board move | Captures whether the promised SDLC transition occurred. | Keep deliberate moves distinct from automation evidence; do not train on a status alone as ground truth. |
| Change Set evidence: diff, test command and exit status, review/CI/PR state where available | Grounds claims in a ticket's actual worktree. | Preserve command logs/receipts and failed runs; a green local gate does not prove review-ready code. |
| Session ledger: commands, receipts, interactions, Attention, recovery | Supplies causal trace and delivery truth, including ambiguity/failure. | Treat the immutable ledger as source, never a model-written summary. |
| Human corrections: reopened ticket, explicit rejection, revision, follow-up comment, manual outcome selection | High-value, sparse feedback about usefulness and trust. | Attribute carefully: a later correction may be caused by changing requirements, not a previous prompt. |
| Time/cost/turns and interruption/recovery frequency | Makes efficiency and operational reliability measurable. | Do not optimize cost alone; pair with quality, security, and completion evidence. |

The highest-leverage initial corpus is therefore not generic benchmark traces.
It is a privacy- and consent-conscious local corpus of **linked Ticket → Run →
Session ledger → Change Set → Outcome** records, with negative results retained.
That permits failure clustering while keeping the evaluator outside the
candidate-edit loop. It must not silently export local code, prompts, or
transcripts.

## Candidate object model — inference/proposal, not existing product

This is a deliberately small model to discuss after the post-migration Skills,
Automations, and evaluation design sessions. It does not describe current
Volli schema or authorization behavior.

```text
Lesson
  id, status: proposed | accepted | retired | rejected
  claim: concise operational guidance
  scope: project | path | ticket-label | session-role
  evidenceRefs: immutable Ticket/Run/Session/Change Set references
  author: user | session | automation
  sourceRevision, createdAt, supersedes?
  confidence, expiry/reviewAt

Skill
  id, revision, status: draft | accepted | retired
  manifest: SKILL.md-compatible metadata
  lessonRefs[], instructions, resourceRefs[], digest
  supportedRoles[], compatibleToolBundle, authorityCeiling
  provenance: proposal/evidence/approval chain

AutomationInstructions
  automationId, revision, instructionBody, contextChipRefs[], skillRefs[]
  candidateOutcomeNotes (non-authoritative)
  provenance and acceptance record

PromotionCandidate
  target: Lesson | Skill | AutomationInstructions
  proposedRevision, sourceEvidence, predictedBenefit, regressionRisks
  evalPlan: held-in + held-out fixtures / trace cohort
  results, evaluatorVersion, cost, humanDecision

RuntimeSelection
  sessionId/runId, resolvedObjectRevisions[], resolutionReason
  runtimeBriefArtifactRef, authoritySnapshotRef, toolBundleRef
```

### Candidate promotion pipeline

1. **Observe:** a Session/Run creates a candidate from a recurring tactic,
   failure, correction, or confirmed success. The reference points to existing
   immutable evidence; it does not rewrite that evidence.
2. **Normalize:** deduplicate into a concise proposed Lesson with explicit scope,
   a falsifiable predicted benefit, and possible regressions. A failure can
   remain a negative lesson; it need not be converted into optimistic advice.
3. **Evaluate:** use a frozen evaluator configuration. For a code behavior, run
   focused tests plus held-out representative fixtures/traces; inspect outcome,
   recovery, authority, and change-set effects. Never allow the candidate to
   edit the tests, quality gate, model configuration, or scoring rule.
4. **Accept or reject:** a low-risk, narrowly scoped candidate can pass a
   predeclared gate; broad, security-relevant, or authority-adjacent changes
   require a human decision. Record rejection rather than discarding it.
5. **Activate only at a boundary:** create a new immutable object revision and
   select it in a subsequent Runtime Brief/session. Persist the selection with
   the Run/Session input. No mid-turn silent injection.
6. **Monitor and roll back:** compare accepted revisions with a control cohort
   and watch for explicit corrections, reopens, blocked outcomes, attention, and
   quality regressions. Retirement/rollback selects a prior revision; it never
   erases prior records.

This mirrors the good parts of Prime's focused `/refine` history and Weng's
itemized-context and held-out-validation themes, while preserving Volli's
product ownership.

## Risks and non-negotiable containment

| Risk | Failure mode | Required containment |
| --- | --- | --- |
| Reward hacking | Candidate learns to satisfy a test, board transition, or score while evading the underlying ticket intent; Factorio's RCON exploit is the clearest example. | Evaluator, authority, and promotion path are outside the refinement loop; held-out checks, trace/change-set audit, and human review for consequential promotion. |
| Context collapse | Appending lessons/memory makes the Runtime Brief long, contradictory, stale, and less followed. | Typed, scoped, short entries; deterministic ranking; explicit budget; on-demand evidence; expiration/review; never rewrite one giant prompt blob. |
| Contaminated memories | An incorrect model conclusion, repository prompt injection, secret, or task-specific accident becomes reusable policy. | Provenance, evidence links, untrusted/draft state by default, secret scanning/redaction, scope boundaries, human acceptance for shared/global objects, rollback/quarantine. |
| Eval Goodharting | Optimizing a small fixture set degrades maintainability, security, or unseen tasks. | Separate held-in from held-out evaluation; rotate/review corpora; retain negative outcomes; combine tests with Change Set, Outcome, Attention, and human-correction signals. |
| Unsandboxed refine | A self-improving agent executes arbitrary scripts, expands tools, changes credentials, or edits its own verifier. Prime explicitly warns its execution is not a security sandbox. | No live self-edit capability in the production runtime. Candidate creation is data-only; executable Skill/harness code enters through normal source control, pinned provenance, tool/authority policy, and the future sandbox design. |
| Causal confusion | A better result is attributed to a Lesson when model/version, ticket difficulty, user steering, or a changed gate caused it. | Record resolved object revisions, model policy, Authority Snapshot, tool bundle, evaluator version, and comparable controls; treat claims as provisional without enough evidence. |

## Recommended sequencing

1. Finish the Pi-native Session migration and its deterministic prompt,
   command/receipt, recovery, authority, and tool-boundary tests first.
2. In the deferred Skills/MCP policy session, define a portable Skill artifact
   and provenance/compatibility rules—not an extension marketplace.
3. In the reusable Automations session, add versioned Instructions and explicit
   Run/Outcome evaluation hooks; do not make an Automation a silent background
   optimizer.
4. In the deferred system-prompt/evaluation session, build a lean, local,
   consent-aware trace corpus and held-out fixtures around real ticket outcomes.
5. Start with human-reviewed, project-scoped Lesson proposals and one
   deterministic Runtime Brief selection path. Promote auto-accept only for
   clearly bounded, low-risk object types after it earns evidence.

## Source record

Primary sources consulted:

- Lilian Weng, [“Harness Engineering for
  Self-Improvement”](https://lilianweng.github.io/posts/2026-07-04-harness/),
  2026-07-04.
- Agent Skills, [format
  specification](https://agentskills.io/specification).
- Anthropic, [“How Claude remembers your
  project”](https://docs.anthropic.com/en/docs/claude-code/memory).
- Nous Research, [Hermes Agent
  repository](https://github.com/NousResearch/hermes-agent).
- Prime Intellect, [“Prime Agent: A self-improving RLM
  agent”](https://www.primeintellect.ai/blog/prime-agent) and the
  [Prime Agent repository](https://github.com/PrimeIntellect-ai/prime-agent).
- Volli, [`CONTEXT.md`](../../CONTEXT.md) and [Pi-native Ticket Session
  migration plan](../plans/pi-native-ticket-session.md).

The statements about Volli's current/target product direction above are sourced
from its canonical glossary and migration plan. The candidate model, promotion
pipeline, and recommended sequencing are explicitly this memo's inferences.
