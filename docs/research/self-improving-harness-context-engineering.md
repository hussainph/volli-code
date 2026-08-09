# Context engineering to meta-harness: an evidence memo

**Research memo — 2026-08-08**
**Scope:** the lineage surveyed in [Lilian Weng, *Harness Engineering for
Self-Improvement*](https://lilianweng.github.io/posts/2026-07-04-harness/),
from learned context artifacts to learned context-construction methods and
then harness-code search. This is not a product plan.

## Bottom line

**Fact:** The three systems change the level of the optimized object:

1. **ACE** optimizes an evolving, itemized *context playbook* with a fixed
   generation/reflection/curation procedure.
2. **MCE** adds an outer loop that optimizes the *skill*—the executable
   procedure that represents and builds a context function—while an inner
   agent optimizes the resulting context artifacts.
3. **Meta-Harness** searches the surrounding *harness program*: retrieval,
   memory, prompt construction, and orchestration code, with a coding-agent
   proposer inspecting prior candidate code and raw traces.

**Inference:** This is not evidence for unrestricted self-modification. Each
paper obtains its result from an evaluation boundary and a comparatively
constrained experiment. The reusable design claim is narrower: separate the
durable evidence and evaluator from the editable artifact; make edits
inspectable, attributable, and reversible.

## The lineage at a glance

| System | Optimized object | Frozen / externally supplied | Update and selection | Evaluator’s job | Principal caveat |
| --- | --- | --- | --- | --- | --- |
| **Dynamic Cheatsheet** (DC) | Persistent cheatsheet entries | Black-box LM weights; task environment | A curator rewrites/self-curates a cheatsheet after queries | Often execution outcome or task answer; can operate without labels | A full accumulated-memory rewrite is the concrete precursor to later “context collapse.” |
| **ACE** | Identified context bullets: strategies, concepts, failure modes | Generator/Reflector/Curator workflow and deterministic merge policy; base model in each experiment | Generator trace → Reflector lessons → Curator `ADD`/`UPDATE`/`REMOVE` deltas; grow-and-refine de-duplicates/prunes | Supplies ground truth where available or natural execution feedback | Reliable feedback and a capable Reflector are required; additive playbooks can still bloat. |
| **MCE** | Inner: a file/code context function. Outer: its context-engineering skill | Frozen underlying LLMs; task interface; train/validation split and role-scoped filesystem permissions | Meta-agent performs history-informed agentic crossover over skills; base agent executes the new skill against rollouts; a `(1+1)` strategy retains the stronger validation result | Separates training optimization from validation selection | The reported method can be weak on long, complex trajectories; its online variant cannot evolve skills iteratively. |
| **Meta-Harness** | Harness source code: prompt/retrieval/memory/orchestration logic | Base model; search/test separation where used; interface validation; fixed iteration budget | Coding-agent proposer reads candidate code, scores, and raw traces from a filesystem; candidates are evaluated and a Pareto frontier returned | Produces feedback traces and scores; test results withheld from proposer | Search can optimize a public benchmark: TerminalBench-2 search and final evaluation used the same 89 tasks. |

Sources: [DC paper](https://arxiv.org/abs/2504.07952);
[ACE paper](https://arxiv.org/abs/2510.04618);
[MCE paper](https://arxiv.org/abs/2601.21557);
[Meta-Harness paper](https://arxiv.org/abs/2603.28052).

## 1. ACE — Agentic Context Engineering

**Fact — object and mechanism.** ACE treats context as an evolving playbook,
not a single prompt string. A playbook is a collection of bullets; each bullet
has an identifier, content, and helpful/harmful counters. The
[paper’s §3.1](https://arxiv.org/html/2510.04618#S3.SS1) defines three
specialized roles:

- **Generator:** uses the current playbook to produce a trajectory for a new
  query and identifies helpful or misleading bullets.
- **Reflector:** compares trajectory and outcome, extracting reusable lessons;
  it may refine those lessons for several rounds.
- **Curator:** turns lessons into local delta entries, which non-LLM code
  deterministically merges into the playbook.

The Curator does not rewrite the whole context. It emits localized
`ADD`/`UPDATE`/`REMOVE` changes; grow-and-refine appends new bullets, updates
known bullets, deduplicates semantically, and prunes harmful ones. This is
directly described in [§§3.1–3.2](https://arxiv.org/html/2510.04618#S3) and
implemented by the authors’ [official repository](https://github.com/ace-agent/ace).

**Fact — what is frozen.** ACE’s paper fixes the high-level
Generator→Reflector→Curator architecture and merge policy; it does not search
for a different context construction algorithm. For the reported comparison it
also uses the same DeepSeek-V3.1 model for the three roles, specifically to
isolate context construction rather than import a stronger curator’s
knowledge ([§4.2](https://arxiv.org/html/2510.04618#S4.SS2)).

**Fact — why bullets instead of prompt rewrites.** The authors identify two
failure modes of monolithic prompt optimization:

- **Brevity bias:** iterative prompt methods favor short, generic instructions,
  dropping detailed heuristics and failure modes.
- **Context collapse:** a full rewrite can abruptly compress accumulated
  knowledge into an uninformative summary. Their AppWorld case study reports a
  18,282-token context at 66.7 accuracy becoming 122 tokens at 57.1 on the
  next update—below the 63.7 no-adaptation baseline
  ([§2.2](https://arxiv.org/html/2510.04618#S2.SS2)).

Itemization does not guarantee correctness, but it changes the failure shape:
an update has an address, can be merged without an LLM, and can be
deduplicated/pruned independently rather than silently replacing the entire
body of knowledge.

**Fact — evaluator role and limits.** ACE works offline with labeled training
data or online from execution signals. The authors explicitly report that ACE
and Dynamic Cheatsheet can degrade without reliable feedback: misleading or
spurious signals pollute the constructed context
([§4.4](https://arxiv.org/html/2510.04618#S4.SS4)). They also note a
dependency on a sufficiently capable Reflector and that some tasks benefit more
from concise context than rich playbooks
([limitations](https://arxiv.org/html/2510.04618#S5)).

**Transfer evidence, bounded.** ACE evaluates both interactive AppWorld tasks
and financial benchmarks, and claims online adaptation can use natural
execution outcomes rather than labels. That supports transfer across those
evaluation domains, not a claim that bullet curation generalizes to arbitrary
long-running software projects. The cited experiment is the source of the
claim; no repository-scale maintenance or safety outcome is measured.

## 2. MCE — Meta Context Engineering

**Fact — the added meta-level.** MCE formalizes a context function
`c(x) = (F_k ∘ … ∘ F_1)(x; ρ)`: static components `ρ` include prompts,
knowledge bases, examples, and code libraries; dynamic operators `F` retrieve,
filter, format, and compose them. The new object is a **skill** `s`, an
executable specification of how the context function is represented and learned.
The paper’s bi-level objective is:

```text
inner:  c*_s = argmax_c J_train(c; s)
outer:  s*   = argmax_s J_val(c*_s)
```

This decouples the context artifact (“what”) from the context-engineering
procedure (“how”). See [MCE §3.1](https://arxiv.org/html/2601.21557#S3.SS1).

**Fact — concrete file-backed representation.** A skill is a folder in the
base-agent workspace. It may contain a methodology, executable scripts,
context templates, validation protocols, and dynamic operators. The context
function is likewise a designated directory of static files and executable
dynamic components. Both agents use ordinary coding tools
(`Read`, `Write`, `Edit`, `Bash`, `Glob`, `Grep`, `TodoWrite`) under
role/iteration-scoped filesystem permissions
([§§3.2–3.4](https://arxiv.org/html/2601.21557#S3)).

In the paper’s terminology, `SKILL.md` is one possible static artifact in that
folder, rather than an invariant single-file contract. The official
[MCE repository](https://github.com/henry-yeh/meta-context-engineering)
documents the same skill/context workspace shape.

**Fact — update and evaluation.**

1. The meta-agent stores a history
   `(skill, resulting context function, training metric, validation metric)`.
2. It performs **agentic crossover**: it inspects the task and any useful
   historical skill directories, diagnoses success/failure patterns, and
   writes a new skill.
3. The base agent receives that skill, the prior best context as a warm start,
   training rollouts, and optional utilities; it produces a new context
   function.
4. The new context is evaluated on train and validation data. A simple
   history-informed `(1+1)` evolution strategy retains the better
   validation result.

These are facts from [Algorithm 1 and §3.4](https://arxiv.org/html/2601.21557#S3.SS4),
not merely an analogy to evolutionary search.

**Fact — what remains frozen.** MCE does not update model weights. It treats
the LLM as frozen and searches non-parametric context artifacts and their
construction procedure. Its experimental setup also fixes task interfaces,
train/validation data, the coding-agent runtime, and their role-scoped
read/write permissions ([§§3.1, 3.4, 4.1](https://arxiv.org/html/2601.21557#S3)).

**Fact — failure modes and scope.** MCE argues that ACE’s additive curation
can cause context bloat and that GEPA tends toward short prompts; its results
show task-dependent preferred context lengths rather than one universal length
([§4.2.2](https://arxiv.org/html/2601.21557#S4.SS2.SSS2)). The authors’ own
limitations are material: batch-level context engineering may not assign credit
well on long, complex trajectories; it is especially aimed at domain knowledge
and pattern matching; and online processing does not permit iterative
skill evolution ([limitations](https://arxiv.org/html/2601.21557#S5)).

**Transfer evidence, bounded.** The paper evaluates five domain benchmarks
and reports strong-to-weak-model context transfer. That establishes evidence
for transfer of learned *context artifacts* across the tested models and
domains, not for automatic transfer of a skill to new tool policies, a
different verifier, or a production agent runtime.

## 3. Meta-Harness — search over harness code

**Fact — object and search state.** Meta-Harness moves from optimizing context
to optimizing the program that constructs and uses context: in the authors’
experiments, a single-file Python harness controls task-specific prompting,
retrieval, memory, and orchestration. An outer-loop coding-agent proposer reads
a filesystem of prior candidate directories, each containing source, scores,
and execution traces (prompts, tool calls, outputs, and state updates).
It proposes candidates, interface validation rejects invalid ones, evaluation
adds new evidence to the filesystem, and the loop returns a Pareto frontier
([§3](https://arxiv.org/html/2603.28052#S3)).

**Fact — selection is multi-objective.** The search maintains a population and
Pareto frontier rather than requiring one fixed scalar objective. The text
classification experiment explicitly makes the accuracy/context-token trade-off
an output frontier ([§4.1](https://arxiv.org/html/2603.28052#S4.SS1)).
This is a useful distinction from “maximize pass rate” alone: a candidate can
be retained because it represents a different useful cost/quality trade-off.

**Fact — what is frozen.** The base model is frozen, the proposer cannot see
test-set results, and each candidate must pass an interface check. The
published experiment uses Claude Code with Opus 4.6 as proposer, a fixed
iteration budget, and the task’s search set as the proposer’s evaluation
feedback. The proposer is unconstrained in *which* historical candidate and
trace it reads or whether it makes a local edit versus a larger rewrite
([§3](https://arxiv.org/html/2603.28052#S3)).

**Fact — raw traces matter.** On their online classification ablation, the
full code-plus-traces interface has a 50.0 median and 56.7 best search-set
score, versus 34.6/41.3 for scores-only and 34.9/38.7 for scores plus LLM
summaries ([Table 3](https://arxiv.org/html/2603.28052#S4.T3)). This is
evidence for diagnostic value in that setup; it does not prove that all raw
logs should always be put into the active model context. The system uses
filesystem navigation precisely because history is larger than a context
window.

### TerminalBench-2: a qualified result, not a deployment claim

**Fact:** TerminalBench-2 is a public 89-task containerized terminal benchmark
with human-written solutions and comprehensive tests
([benchmark paper](https://arxiv.org/abs/2601.11868);
[official repository](https://github.com/harbor-framework/terminal-bench)).
Meta-Harness initializes from Terminus 2 and Terminus-KIRA. On this benchmark
it reports 76.4% with Claude Opus 4.6 versus Terminus-KIRA’s 74.7%, and 37.6%
with Claude Haiku 4.5 versus Goose’s 35.5%; the paper calls these #2 and #1
among reported agents respectively ([Table 7](https://arxiv.org/html/2603.28052#S4.T7)).
The authors released the discovered
[TerminalBench-2 artifact](https://github.com/stanford-iris-lab/meta-harness-tbench2-artifact).

**Critical qualification — Fact:** Search and final evaluation use the same
89 TerminalBench-2 tasks. The authors label that a benchmark “discovery
problem,” then use manual inspection and regex audits for task-specific string
leakage instead of a held-out benchmark split
([§4.3](https://arxiv.org/html/2603.28052#S4.SS3)).

**Inference:** The score is good evidence that code-space search can improve a
strong terminal benchmark harness. It is weaker evidence of out-of-benchmark
generalization than Meta-Harness’s separately held-out classification and
cross-model math results. It cannot establish that the discovered coding
harness will improve a product’s recovery, permission handling, code quality,
or maintainability.

**Fact — available transfer evidence.** In separate experiments, one selected
harness performs best on average across nine unseen classification datasets,
and a discovered retrieval harness improves a 200-problem held-out math set
across five models ([§§4.1–4.2](https://arxiv.org/html/2603.28052#S4)).
Those results support the narrower proposition that some discovered
context/retrieval procedures can transfer. They do not erase the
TerminalBench-2 search/evaluation overlap.

## Adjacent work that changes the design picture

### Dynamic Cheatsheet: the direct precursor, and a warning

**Fact:** Dynamic Cheatsheet maintains self-curated persistent memory for a
black-box language model at inference time; the official implementation exposes
cumulative, retrieval/synthesis, hybrid, full-history, and dynamic-retrieval
variants ([paper](https://arxiv.org/abs/2504.07952);
[official code](https://github.com/suzgunmirac/dynamic-cheatsheet)).
ACE explicitly builds on DC’s agentic design while replacing full-context
rewriting with an itemized delta log.

**Design consequence — Inference:** “Memory” is not inherently a safe
append-only store. DC makes useful persistence concrete; ACE’s collapse case
shows why a curator needs local edit semantics and evidence rather than an
unversioned rewrite of all accumulated experience.

### GEPA: Pareto search and trace-grounded reflection predate full harness search

**Fact:** GEPA samples system trajectories, reflects in natural language to
diagnose failures and propose prompt updates, then recombines lessons from a
Pareto frontier of candidates
([paper](https://arxiv.org/abs/2507.19457);
[official code](https://github.com/GEPA-ai/GEPA)). It is a direct baseline for
ACE, MCE, and Meta-Harness.

**Design consequence — Inference:** Pareto retention and trace-based diagnosis
are not exclusive to code search. Meta-Harness broadens the editable surface
from prompts to code and broadens trace access from prescribed reflection input
to filesystem-selective inspection. The safety risk also broadens: prompt
mutation cannot directly disable a verifier; harness code can unless the
evaluation boundary is outside the editable workspace.

### Agent Workflow Memory and A-MEM: retrieval and topology are independent axes

**Fact:** Agent Workflow Memory induces reusable workflows from past
experiences and selectively supplies them in offline or online settings
([ICML paper](https://proceedings.mlr.press/v267/wang25bx.html)). A-MEM stores
structured notes with contextual descriptions, keywords, tags, and links, and
can revise earlier notes when adding new information
([paper](https://arxiv.org/abs/2502.12110);
[authors’ evaluation repository](https://github.com/WujiangXu/AgenticMemory)).

**Design consequence — Inference:** The lineage is not simply “ever more
autonomy.” It separates at least three decisions that a system should not
conflate: what is stored, how it is organized/retrieved, and how the procedure
that changes either is selected. ACE primarily addresses local mutable
knowledge; MCE makes construction policy editable; Meta-Harness makes the
larger execution policy editable.

## Cross-paper failure model

| Failure | What the papers establish | Boundary that remains necessary |
| --- | --- | --- |
| **Context collapse** | ACE gives a measured example of a full rewrite erasing detailed accumulated context. | Addressable items, retained prior versions, deterministic merges, and a way to inspect the delta. |
| **Brevity bias / bloat** | ACE identifies prompt brevity bias; MCE reports both GEPA-short and ACE-long context biases. | Evaluate accuracy *and* context cost, retain alternatives where trade-offs differ, and do not prescribe one universal context length. |
| **Bad credit assignment** | ACE needs reliable feedback; MCE names long complex trajectories as a limitation; Meta-Harness relies on trace diagnosis. | Preserve execution evidence and distinguish an observed failure from a hypothesized root cause. |
| **Reward hacking / evaluator tampering** | These three systems do not demonstrate a general solution. Meta-Harness validates the harness interface, but its search task is still defined by the evaluator. | Keep verifier, task definitions, model/budget policy, and permissions outside the editable candidate surface; use held-out evaluation where the objective is generalization. |
| **Benchmark overfitting** | Meta-Harness has held-out evidence in two domains but intentionally shares TerminalBench-2 search/final tasks. | State benchmark-specific results as such; use held-out tasks, trace audits, and operational evaluations before claiming product transfer. |
| **Irreversible bad updates** | ACE makes local changes technically possible; MCE and Meta-Harness retain history in workspaces/filesystems. | Record parentage, inputs, metrics, accepted/rejected state, and rollback targets rather than overwriting the active artifact. |

## Implications for a product Session/ledger system

These are architectural lessons, not Volli implementation instructions.

1. **Editable surfaces should be explicit and narrow.** A prompt resource,
   curated memory entry, skill artifact, and harness program are different
   optimization targets with different blast radii. They should not be one
   opaque “agent memory” field.
2. **Prefer curator-style deltas over silent rewrite for durable knowledge.**
   ACE’s itemized updates are valuable because they preserve identity and make
   provenance and selective rollback possible; they do not prove that all
   context should grow forever.
3. **The ledger should preserve evidence, not only summaries.** The
   Meta-Harness ablation supports retaining addressable raw traces and artifacts
   that a future investigator can selectively inspect. Summaries are projections,
   not substitutes for primary evidence.
4. **Provenance needs both fact and hypothesis.** A durable record can say
   “this verifier failed,” “this curator proposed edit X,” “candidate Y was
   accepted on metric Z,” and separately retain an agent’s causal diagnosis.
   Conflating diagnosis with outcome turns a flawed explanation into history.
5. **Rollback is a product property, not merely git history.** Keep candidate
   lineage, evaluator version, model/budget configuration, source artifact,
   result, and acceptance decision together so a prior known-good surface can
   be restored without rewriting Session history.
6. **Keep the evaluator and authority boundary outside self-improving
   artifacts.** The research demonstrates search under controlled evaluation;
   it does not justify letting an optimizing agent modify its own verifier,
   permission policy, or durable historical record.

## Primary-source ledger

- Zhang et al., 2025/ICLR 2026, [*Agentic Context Engineering*](https://arxiv.org/abs/2510.04618), [official code](https://github.com/ace-agent/ace).
- Ye et al., 2026, [*Meta Context Engineering via Agentic Skill Evolution*](https://arxiv.org/abs/2601.21557), [official code](https://github.com/henry-yeh/meta-context-engineering).
- Lee et al., 2026, [*Meta-Harness: End-to-End Optimization of Model Harnesses*](https://arxiv.org/abs/2603.28052), [project page](https://yoonholee.com/meta-harness/), [TerminalBench artifact](https://github.com/stanford-iris-lab/meta-harness-tbench2-artifact).
- Merrill et al., 2026, [*Terminal-Bench*](https://arxiv.org/abs/2601.11868), [official benchmark repository](https://github.com/harbor-framework/terminal-bench).
- Suzgun et al., 2025, [*Dynamic Cheatsheet*](https://arxiv.org/abs/2504.07952), [official code](https://github.com/suzgunmirac/dynamic-cheatsheet).
- Agrawal et al., 2025, [*GEPA*](https://arxiv.org/abs/2507.19457), [official code](https://github.com/GEPA-ai/GEPA).
- Wang et al., 2025, [*Agent Workflow Memory*](https://proceedings.mlr.press/v267/wang25bx.html).
- Xu et al., 2025, [*A-MEM*](https://arxiv.org/abs/2502.12110), [authors’ evaluation code](https://github.com/WujiangXu/AgenticMemory).

Weng’s post is the requested map of the lineage, but every material
method/result claim above links to its paper, benchmark, or author-maintained
repository rather than relying on the survey.
