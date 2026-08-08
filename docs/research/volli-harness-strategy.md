# Volli harness strategy: portability, ownership, and Claude dependency

> **Decision status — superseded 2026-08-08.** This remains the external evidence
> record, but its asymmetric-hybrid recommendation was reconsidered after the
> solo-developer maintenance cost and product-authority tradeoff were grilled.
> The accepted direction is the singular Pi-backed Agent Runtime in
> [`docs/plans/pi-native-ticket-session.md`](../plans/pi-native-ticket-session.md).

**Decision memo — 2026-08-08**
**Scope:** product strategy, not an implementation plan. This memo evaluates a durable Volli Session/product layer against five possible agent-harness strategies.

## Executive conclusion

**Recommendation: pursue the asymmetric hybrid (alternative 5), but as a staged, reversible strategy rather than a promise of symmetric multi-harness parity.** Maintain a provider-neutral Volli Session and SDLC product layer; certify the currently valuable structured producers (Claude Agent SDK only if Anthropic approves the intended authentication flow, and OpenCode); retain terminal `liveBestEffort` compatibility; and treat Pi as a deliberately funded candidate harness/evals programme rather than the launch-critical default.

This is not a conclusion that "more adapters are always better." A meta-harness creates real value only when it owns the cross-harness work that users cannot cheaply recreate: durable local history, worktree/ticket control, recovery, review and hand-off loops, capability-honest UX, and a coherent long-term-codebase operating model. If it merely normalizes chat, it becomes integration tax plus a weaker duplicate of provider harnesses.

The evidence does **not** support betting the product today on a Pi-only harness, nor on Claude subscription access as a contractual entitlement. Pi is technically credible and permissively licensed, but ownership converts Volli into a direct harness competitor and transfers tool policy, context management, prompt/regression, security and eval responsibility to Volli. Conversely, Anthropic's current SDK documentation says third parties need prior approval to offer Claude.ai login or plan limits, while its Help Center says a proposed entitlement change is paused. Those statements make a subscription-backed Claude integration commercially attractive but contingent, even where technically possible. [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) [Anthropic Help Center, 2026-06-16](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)

**Confidence:** medium in the recommended sequence; high that a Claude subscription is a concentration risk; medium that a durable SDLC control plane is a differentiated wedge; low on relative market share or model superiority because no reliable public denominator establishes either. This memo deliberately does not call any harness the market leader as a fact.

### Decision in one sentence

Make Volli's durable Session and software-development workflow the product; use the best available harnesses as explicit, capability-honest execution profiles; earn the right to own the loop only when a Pi-based prototype demonstrates user and task advantages that clear its continuing cost.

## Method, evidence quality, and boundaries

This is a source-backed decision analysis as of **2026-08-08**. Claims are labelled as follows:

- **Fact** — directly observable in first-party documentation, a public source repository, or the current Volli architecture.
- **Inference** — a conclusion drawn from facts; alternatives are stated where material.
- **Assumption** — an input used for comparison that requires validation.
- **Forecast** — a conditional 12–24 month view, not a claim about present market share.

Primary sources are used for product capability, licensing, policy, release activity and pricing. GitHub stars, forks and releases are only weak adoption signals: they measure public repository attention, not paid users, retention or enterprise penetration. No market-share figure is asserted. The analysis also assumes the project direction recorded in `CONTEXT.md`: a Session is locally durable before an executor attaches; adapters are replaceable producers; profiles are explicit; and absent capabilities are not simulated.

## The alternatives

| # | Strategy | What Volli owns | Principal promise | Main strategic exposure |
| --- | --- | --- | --- | --- |
| 1 | **Symmetric multi-harness** | Session control plane, adapters and compatibility UX | “Bring a supported harness; Volli organizes the work.” | Per-harness integration, behavioural drift, parity expectations |
| 2 | **Pi-only owned harness** | Product plus agent loop, tool policy, context/prompt behaviour and model integrations | “A better SDLC-native coding agent.” | Directly competes with every harness; must prove UX and task advantage |
| 3 | **Pi primary + Claude fallback** | Pi loop plus a Claude bridge and two behavioural contracts | “Owned experience without losing Claude.” | Highest product surface and confusing precedence/fallback semantics |
| 4 | **Claude Agent SDK primary/only loop, gateway-routed models** | Volli UX around Claude's loop and gateway configuration | “Claude Code capabilities with broader inference.” | Claude protocol/terms/auth dependency; model-shape mismatch and gateway maintenance |
| 5 | **Asymmetric hybrid** | Portable Session/SDLC semantics; selected native producers; Pi option | “One durable development workspace; profiles differ honestly.” | Requires disciplined support tiers and delayed gratification on a single canonical loop |

### Important distinction: harness, model, and entitlement

A model is inference; a harness is the agent loop, tool policy, context strategy, permission model, session handling and UI; an entitlement is the commercial right to use one through a particular authentication path. They are separable only to a limited degree. A Claude-compatible endpoint can keep the Claude Code request shape while changing inference and billing; it does not make another model behave like Claude Code, nor preserve a Claude subscription when a gateway credential replaces it. Anthropic documents both the gateway constraint and the billing distinction. [Other LLM gateways](https://code.claude.com/docs/en/llm-gateway)

## Current market and policy facts

### Anthropic / Claude Agent SDK

- **Fact:** Anthropic describes the Agent SDK as the Claude Code agent loop, tools and context management exposed as a Python/TypeScript library. Its documented capabilities include built-in file/shell/web tools, hooks, subagents, MCP, permissions, sessions/forks, skills, plugins, checkpoints, cost tracking and OpenTelemetry. This is a rich route to a custom UX without first rebuilding a loop. [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)
- **Fact:** The same page says that, unless previously approved, Anthropic does not allow third-party developers to offer Claude.ai login or rate limits in their products, and refers developers to API-key authentication. Its usage is governed by Anthropic Commercial Terms. [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)
- **Fact:** Anthropic's 16 June Help Center notice says the previously announced change is paused and, *for now*, Agent SDK, `claude -p`, and third-party app usage still draw from subscription limits. The preserved, non-operative plan would instead have provided a monthly SDK credit, then API-priced usage. Anthropic explicitly says it will communicate an update before it takes effect. [Use the Claude Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
- **Inference:** These statements are not a stable product entitlement. They may be consistent if “third-party app usage” means approved/otherwise permitted integrations, but the public pages do not establish that Volli is approved. Do not market subscription-backed Claude access, design a business model around it, or collect the user's Claude credential until Anthropic supplies written approval and an integration contract.
- **Founder/user motivation risk:** Losing affordable access to a preferred Claude model/harness is not a minor feature regression. It can remove the founder's highest-frequency dogfooding path and reduce enthusiasm for multi-agent workflows. Treat this as both an adoption-risk signal and a motivation/velocity risk—not as proof that the commercial policy will remain favourable.

### Claude-compatible gateways and Kimi

- **Fact:** Anthropic supports routing Claude Code through a gateway that preserves the specified API format and headers, but does not support routing Claude Code to non-Claude models. It warns that Claude Code adds capabilities release by release and an unmaintained gateway can break those capabilities. [Other LLM gateways](https://code.claude.com/docs/en/llm-gateway)
- **Fact:** With a gateway credential or `apiKeyHelper`, the gateway credential replaces a saved Claude.ai login for that session; traffic is per-token billed to the account behind the gateway. Merely setting `ANTHROPIC_BASE_URL` does not itself replace a saved subscription login, but a pass-through gateway must forward the OAuth capability header. [Other LLM gateways](https://code.claude.com/docs/en/llm-gateway)
- **Fact:** Kimi documents a Claude Code integration that installs a Kimi API key as `ANTHROPIC_AUTH_TOKEN`, maps main, fast, Fable and subagent model variables, and sets the compaction window. Its own guide says incomplete mapping can fail background/subagent work and that WebFetch is unsupported by that endpoint. [Kimi: Use Kimi in Claude Code](https://platform.kimi.ai/docs/guide/claude-code-kimi)
- **Inference:** Alternative 4 is not “bring any subscription to Claude Code.” It is a Claude-shaped, API-billed multi-model deployment with a protocol translation and QA burden. It is useful for controlled experimentation or an enterprise gateway, but it compounds provider dependence: Anthropic controls the loop/protocol, the gateway controls request compatibility and billing, and the alternate provider controls model/tool fidelity.

### Pi

- **Fact:** Pi is an MIT-licensed public project containing a coding-agent CLI, agent core and unified multi-provider API. Its project documentation states that it does **not** include a built-in permission system for filesystem, process, network or credential restriction; its recommended stronger boundary is an external sandbox/container. [Pi repository](https://github.com/earendil-works/pi)
- **Fact:** Pi offers an SDK, JSON and RPC modes, extensibility through lifecycle handlers, tools, commands and provider registration, as well as persisted extension state. Its extensions can replace built-in tools and use remote operations. [Pi SDK documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md) [Pi RPC documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md) [Pi extensions documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
- **Fact:** Pi documents subscription/provider OAuth for several providers, including Claude Pro/Max. Yet its provider documentation says Claude third-party usage is billed as per-token extra usage rather than Claude plan limits. [Pi providers documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md)
- **Inference:** Pi is a strong foundation for a proprietary UX because it has an embeddable and modifiable OSS substrate, but it does not remove model-provider terms or make secure execution free. It transfers responsibility from harness vendor to Volli: permission semantics, safe defaults, sandbox integration, extension supply chain, streaming/recovery correctness and agent-quality regressions.
- **Contradiction requiring validation:** Pi's statement about extra-usage billing conflicts with Anthropic's current Help Center notice that third-party Agent SDK usage still draws from subscription limits. The sources may concern different OAuth flows or be temporally inconsistent. Neither supports a customer promise until exercised against the exact intended flow with written provider confirmation.

### OpenCode and interoperability

- **Fact:** OpenCode is MIT-licensed, has a public repository, a desktop product, a documented provider model, and current releases. Its public repository reports high public attention and frequent releases, but that does not establish user share. [OpenCode repository](https://github.com/anomalyco/opencode) [OpenCode releases](https://github.com/anomalyco/opencode/releases)
- **Fact:** OpenCode says it supports 75+ providers via AI SDK and Models.dev, includes local models, and exposes provider/model configuration. Its provider docs also say Anthropic explicitly prohibits plugins that use Claude Pro/Max models in OpenCode and that formerly bundled plugins were removed in 1.3.0. [OpenCode providers](https://opencode.ai/docs/providers) [OpenCode models](https://dev.opencode.ai/docs/models/)
- **Fact:** ACP is a JSON-RPC agent/client interoperability protocol with a registry and official SDKs; its scope is a client talking to an agent. MCP standardizes a host/client/server edge for external tools and context. A2A standardizes collaboration between independent agents. None supplies Volli's local durable Session ledger, ticket/worktree semantics, user recovery or portable presentation contract. [ACP organization](https://github.com/agentclientprotocol) [ACP architecture](https://agentclientprotocol.com/get-started/architecture) [MCP architecture](https://modelcontextprotocol.io/specification/2025-06-18/architecture) [A2A specification](https://a2a-protocol.org/v1.0.0/)
- **Inference:** Standards can reduce transport implementation and make an adapter portfolio more reversible; they do not eliminate semantic mismatch. Volli should adopt ACP/MCP/A2A at their proper boundaries, not mistake them for a product-domain model.

### Competitive pressure and economics

- **Fact:** Cursor prices agent use at model-inference API rates and separately bills background agents at API pricing. This demonstrates that an incumbent IDE agent is already making model economics and asynchronous workflows part of its product surface. [Cursor pricing](https://docs.cursor.com/account/pricing)
- **Fact:** Devin combines a managed agent workspace, IDE and shell with subscription/credit plans; it offers individual plans from $20/month and a $200/month Max plan, while its enterprise architecture retains the “brain” in Cognition's cloud and does not support customer-supplied third-party LLM keys. [Devin plans](https://docs.devin.ai/admin/billing/self-serve) [Devin deployment](https://docs.devin.ai/enterprise/deployment/overview)
- **Fact:** HumanLayer positions itself as an opinionated orchestration product that exposes agent/subagent reasoning, tools and code changes, with an open-source RPI framework but not yet a fully open-source product. [HumanLayer](https://www.humanlayer.dev/)
- **Fact:** GitHub supports third-party coding agents alongside its cloud agent in public preview, illustrating that the coordination/review surface is becoming a platform battleground rather than a single-harness feature. [GitHub third-party coding agents](https://docs.github.com/en/copilot/concepts/agents/about-third-party-coding-agents)
- **Inference:** Competition is converging on the same visible layers: agent loop, model routing, cloud/background execution, review, workspaces and orchestration. OSS alone is distribution and trust leverage, not a moat. A durable local-first workflow and high-quality recovery/review coordination can be a wedge, but only if it changes a repeated user job more than switching cost does.

## What each alternative sells

| Alternative | Defensible ICP / wedge | Value created | What it must not claim |
| --- | --- | --- | --- |
| 1. Multi-harness | Developers already using several local agents, worktrees and terminal sessions | Continuity through model/harness churn; one local work ledger | Equal capability or identical semantics |
| 2. Pi-only | Developers dissatisfied with harness UX who will adopt an opinionated local SDLC | Faster invention across loop, tools and UX; independent model choice | Better task performance without comparative evals |
| 3. Pi + Claude fallback | Claude-heavy power users wanting a native Volli experience | Personal continuity plus option to own more of the experience | Seamless fallback or interchangeable transcripts/permissions |
| 4. Claude SDK + gateways | Claude Code enthusiasts / enterprises with a gateway | Rich Claude loop immediately; custom UX around it | Provider independence, subscription portability, stable non-Claude compatibility |
| 5. Asymmetric hybrid | Multi-agent long-term-project users who need operational control more than another chat | Honest support tiers; preserve Claude/OpenCode paths while building product value | Symmetric parity or permanent free Claude access |

### Direct answer: meta-harness versus a very good harness

**A meta-harness gains optionality and user continuity.** It can meet a user where their subscription, model preference, shell skills and existing session artifacts already live. It lowers switching friction, makes provider changes less destructive and offers a neutral place to coordinate agent work. It may also use existing harness quality instead of spending years replicating it.

**An owned harness gains control.** It can make every turn, tool, prompt, permission, model choice and recovery loop serve Volli's SDLC. It avoids lowest-common-denominator presentation and can compound learning from evals. The cost is that Volli becomes accountable when it is worse than Claude Code, Cursor, Codex, OpenCode or the next upstream release.

**The durable product layer is the synthesis.** A Session that owns local ordered history, explicit commands/receipts, worktrees, review state and recovery creates value independent of which loop produced a turn. That is the part worth making canonical. The agent loop should become canonical only if evidence shows it improves the same recurring job, not merely because control feels strategically cleaner.

## Build-vs-buy / total-cost-of-ownership analysis

### Assumptions

1. Volli already has a durable Session/adapter seam and a structured OpenCode path; it is not starting from a blank chat application.
2. “Certified” means conformance traces, auth/recovery tests, supported upgrade policy, capability truthfulness and user-facing error recovery—not only a process that launches.
3. A Pi-owned loop includes safe tool policy and sandbox integration even if Pi itself does not provide it; omitting it would understate TCO and risk.
4. Relative units compare engineering/support burden, not dollars, team size or calendar estimates.

| Strategy | Initial product TCO | Continuing TCO | Quality/evals burden | Entitlement resilience | Reversibility |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1. Symmetric multi-harness | 1.0x | 0.5x per certified harness | Medium: conformance and regressions | Medium | High at product layer; medium per adapter |
| 2. Pi-only | 1.7–2.5x | 0.8–1.2x | Very high: loop, prompt, safety, task evals | High for harness; low/medium per provider | Medium; switching back requires bridges |
| 3. Pi + Claude fallback | 2.2–3.0x | 1.2–1.7x | Very high: two native contracts plus comparability | Medium | Medium/high, but complex |
| 4. Claude SDK + gateway | 0.7–1.1x initially | 0.6–1.0x | High: upstream/gateway compatibility, not loop design | Low | Low/medium |
| 5. Asymmetric hybrid | 1.0–1.4x initially | 0.6–1.0x | Medium now; high only if Pi is promoted | Medium/high | Highest |

**Inference:** Alternative 4 looks cheapest only before measuring policy and protocol drift. Alternatives 2 and 3 look strategically clean only if the team accepts an ongoing evals and safety programme as core product work. Alternative 5 costs discipline: it avoids immediate loop ownership, accepts differing profiles, and makes a later decision based on evidence rather than architecture preference.

## Market-pressure analysis (Porter's Five Forces, adapted)

| Force | Pressure | Consequence for Volli | Strategic response |
| --- | --- | --- |
| Supplier power | Very high: model providers control models, price, auth, rate limits and some harness access | Subscription assumptions can become kill switches; API costs flow through | Separate provider, harness and entitlement; retain API fallback; never hide billing source |
| Buyer power / switching | High: users can use a terminal, IDE, OSS harness or cloud agent immediately | A prettier chat alone has weak retention | Win a repeated project-level job: ticket-to-worktree-to-review-to-recovery across time |
| Rivalry | Very high: IDEs, agent vendors, OSS and platforms all bundle nearby features | Feature checklists converge rapidly | Compete on durable coordination semantics and local trust, not generic tool calling |
| New entrants | High: models and OSS loops reduce time to a demo | UI/harness novelty is easy to imitate | Accumulate workflow evidence, integrations, recovery quality and local history portability |
| Substitutes | Very high: direct Claude Code/Codex/OpenCode, Cursor, Devin, terminal multiplexers, GitHub workflows | Meta-harness has to justify extra surface area | Be additive and unobtrusive; preserve existing user workflows and enable exit |

## Dependency, concentration and kill-switch analysis

The central failure mode is not an adapter bug; it is a single policy, protocol or billing change removing a valued workflow. The appropriate measure is **time to useful fallback**, not merely whether an abstraction exists.

| Dependency | Potential kill switch | Severity | Design response |
| --- | --- | --- | --- |
| Anthropic subscription / SDK policy | No third-party subscription auth, credit-only API use, or revoked approval | Critical for Claude-first users | Obtain written approval; make API key/extra usage explicit; preserve a terminal Claude profile; do not promise plan usage |
| Claude Code protocol | New feature/header/tool semantics break a proxy or adapter | High | Version-pin and contract-test; gateway only as an opt-in configuration; no silent degradation |
| Pi upstream | Breaking API, maintainer direction or security posture changes | Medium/high | Pin version, wrap a thin boundary, keep forkability/licence record, retain adapter host |
| OpenCode upstream/provider matrix | Rapid releases and provider changes create behavioural variance | Medium | Certified version range; capability probe; terminal best-effort below it |
| Model provider | Model retirement, price/rate change, tool-call quality changes | High | Model qualification per profile, explicit fallback choices, historical task corpus |
| Local execution | Untrusted tools/extensions reach user credentials/files | Critical | Sandbox boundary, policy evidence, signed/inspected extensions, clear approval states |

## 12–24 month scenarios and sensitivity

| Future condition | Observable leading indicator | Strategy that gains | Recommendation change |
| --- | --- | --- | --- |
| Claude permits and documents third-party subscription login for approved SDK products, with stable limits | Written partner terms, documented auth flow, successful cohort telemetry | 5 and possibly 4 | Keep Claude certified/flagship; still do not make domain semantics Claude-shaped |
| Claude disallows/reprices third-party subscription use | Help Center/terms change, OAuth refusal, users need API credit | 1, 2 or 5 | Expedite OpenCode/Pi path; continue Claude via explicit API profile only |
| Pi + Volli extensions materially outperform providers on long-running project work | Pre-registered evals and dogfood show sustained uplift | 2 or 5 | Promote Pi from candidate to certified flagship; do not remove bridges first |
| Pi does not outperform but users value its UX / portability | User retention and workflow-time evidence, task parity | 5 | Retain Pi as an optional native profile; sell workflow, not task supremacy |
| Providers converge on robust ACP/native interfaces | Multiple agents pass real conformance traces | 1 or 5 | Adapter cost falls; widen certified profile portfolio cautiously |
| IDE/cloud agents own project coordination and local workflows remain niche | Interviews show users never leave their IDE/cloud agent | 4 or a focused 5 | Narrow ICP; integrate as companion rather than replacement workspace |
| Enterprise needs central policy/audit more than local-first control | Deals require SSO, gateway, VPC and audit | 1/4/5 | Invest in gateway/admin path only after evidence; do not force it into individual-product UX |

### Sensitivity variables

The recommendation flips toward Pi-only only if all three are true:

1. **User value:** target users repeatedly choose Volli's loop for a measurable project-work benefit, not just novelty.
2. **Quality:** it reaches task parity on representative tasks and exceeds provider harnesses on at least one owned dimension (e.g., recovery, review-loop completion, safe intervention or multi-session project continuity).
3. **Economics/energy:** the team can sustainably fund evals, safety and upstream maintenance without starving the SDLC product layer.

It flips toward Claude SDK-first only if Anthropic grants durable approval for the exact subscription/auth flow **and** this creates a demonstrable acquisition/conversion advantage that outweighs the loss of provider optionality. Neither condition is currently public fact.

## Risk register

Likelihood and impact are qualitative, assessed for the next 12 months.

| Risk | L | I | Early warning | Mitigation / trigger |
| --- | --- | --- | --- | --- |
| Claude subscription entitlement changes | High | Critical | Policy/help/CLI auth changes | Written approval; a kill-switch experiment; API/terminal contingency; no marketing promise |
| Claude Agent SDK terms conflict with desired product UX | Medium/high | Critical | Partner declines approval or constrains OAuth | Treat API key as baseline; do not ship consumer Claude login without approval |
| Gateway breaks on new Claude Code functionality | High | High | Header/beta/model mismatch, tool failures | Version-contract tests and explicit “experimental gateway” label; no gateway as core runtime |
| Pi-owned loop trails provider harnesses | Medium/high | High | Lower task completion or more human rescue | Time-box eval programme; do not migrate default until threshold cleared |
| Pi safety gap / extension compromise | Medium | Critical | Tool/credential incidents, permissive extension surface | Sandbox before broad availability; explicit tool grants; supply-chain review |
| Adapter parity pressure creates brittle lowest-common-denominator UX | High | High | Feature requests framed as “why missing on X?” | Publish support tiers/capability matrix; progressive disclosure; never emulate absent support |
| Evals optimize benchmark, not project outcome | Medium | High | Benchmark gain but dogfood/user value flat | Include longitudinal codebase tasks, recovery and intervention metrics; preregister gates |
| OSS forkability is mistaken for distribution/moat | High | Medium | Stars/downloads without retained workflows | Measure activation/retention and workflow replacement; focus on durable user assets |
| Founder avoids product work to preserve personal Claude access | Medium | High | Architecture decisions repeatedly defer market evidence | Separate personal power-user path from product promise; make a testable decision record |

## Disconfirming evidence and steelman cases

### Why Pi-only could be right

It is the only option that lets Volli truly compose loop mechanics with tickets, worktrees, review, recovery, policies and UX rather than translating them after the fact. Pi's permissive licence, SDK/RPC and extension surface make it technically plausible. If the target job is long-running project coordination—not simply “ask an agent to edit a file”—a native harness could create a product that no upstream generic coding agent is incentivized to build. A focused OSS community can also build extensions and model integrations faster than a small company can negotiate every provider.

**What would falsify the hybrid recommendation:** a Pi prototype that achieves equal or better task completion with lower user rescue, visibly superior project-recovery UX and lower feature-cycle time across repeated dogfood tasks. In that world, continued adapter investment becomes the opportunity cost.

### Why Claude SDK-first could be right

Anthropic supplies a fully featured loop rather than merely an inference API, and the SDK is explicitly positioned for products with a custom UX. It may be the shortest route to a polished experience for the user who already values Claude Code. The SDK's own capabilities reduce the need to reproduce tools, hooks, permissions, subagents and context management. [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)

**What would falsify the hybrid recommendation:** documented partner approval for subscription authentication plus a product test showing that Claude-first activation/retention is substantially higher than provider-neutral onboarding, while expected policy risk is contractually bounded.

### Why symmetric multi-harness could be right

It turns ecosystem fragmentation into a wedge, protects users from supplier changes and lets Volli concentrate on the local work operating system. ACP's growing ecosystem makes the direction more credible. A tight semantic core with optional facts can avoid the false choice between parity and provider-specific screens. [ACP architecture](https://agentclientprotocol.com/get-started/architecture)

**What would falsify the hybrid recommendation:** certified support repeatedly consumes more engineering than users value, while users overwhelmingly choose one profile and derive no retention benefit from portability.

## Recommended reversible sequence

### Stage 0 — protect the option value now

1. Keep the Session, command/receipt, capability and presentation layers harness-neutral. Do not choose a provider-shaped data model.
2. Define public support tiers: **certified native**, **candidate native**, and explicit terminal **`liveBestEffort`**. “Supported” must mean a stated tier/version—not a promise of equal features.
3. Freeze the commercial claim: no assertion that Claude subscription limits work in Volli. Treat any OAuth work as a private compatibility probe until written approval.

**Gate 0:** a policy dossier contains date-stamped Anthropic written guidance for the intended third-party login use, plus a tested account/billing observation. If absent, Claude SDK integration must use API-key/extra-usage semantics or remain an internal experiment.

### Stage 1 — prove the meta-product wedge (4–8 representative users, not a market survey)

Instrument/observe the end-to-end job: ticket scope → worktree → agent turns → interruption/permission → review → recovery → merge/handoff. Compare direct harness use with Volli around the same harness.

Minimum outcome measures:

- time from task acceptance to review-ready change;
- number and duration of human corrective interventions;
- recovery success after restart/disconnect/permission block;
- agent-work auditability and ability to resume/hand off;
- user preference after repeated use, not first-impression novelty;
- cost and billing clarity by profile.

**Gate 1:** advance the adapter portfolio only if users can name a repeated operational pain that Volli removes and choose it over direct use for that job. If not, narrow the ICP before adding harnesses.

### Stage 2 — Pi candidate programme, separate from launch-critical work

Embed Pi through SDK or RPC for one contained Session profile. Build the smallest Volli extension set that expresses the product thesis (ticket/worktree awareness, durable event bridge, explicit approvals and review/recovery hooks). Do not recreate every Claude feature.

Create a preregistered evaluation suite with three complements:

1. **Task capability:** representative repo changes, tests, debugging, review and multi-file work; compare completion, correctness and cost under controlled model/version conditions.
2. **Longitudinal SDLC UX:** multi-session tasks with interruptions, changed requirements, recovery, review comments and hand-off. Measure completion and human rescue—not model eloquence.
3. **Safety/operability:** permission accuracy, unintended command/file scope, credential boundaries, extension failure handling, transcript durability and resume correctness.

**Gate 2 — promotion to certified native:** Pi must reach task parity with the selected benchmark harness on the representative corpus, have no unacceptable safety/recovery regression, and show a predefined practical advantage (for example lower intervention rate or faster implementation of a differentiated Volli feature). A single benchmark win is not sufficient.

### Stage 3 — portfolio decision

- If Pi clears Gate 2, make it a certified Volli-native profile and market its specific demonstrated advantage. Keep Claude/OpenCode bridges while usage warrants them.
- If Pi does not clear Gate 2 but has user-value evidence, retain it as an advanced/candidate profile and continue improving the product layer.
- If Claude loses permissible subscription access, do not scramble into a Pi-only launch. Offer a clear Claude API/terminal path, elevate OpenCode/provider-neutral access, and use the Pi programme as the longer-term option.

## Concrete evidence still required

1. **Anthropic commercial approval:** an answer to whether Volli may offer Claude.ai login, how usage is metered, and what happens after policy changes.
2. **Exact auth matrix:** real tests of Claude Code, Agent SDK, Pi and OpenCode across subscription, API key and gateway credential paths—capturing authentication method, billing/limit behaviour, support status and feature gaps.
3. **ICP proof:** at least several independent users with the same multi-agent/project-work coordination job and an observed workaround; not only power users who enjoy trying agents.
4. **Baseline evaluation corpus:** tasks taken from real long-lived repos and ticket/review/recovery episodes, versioned and held out from prompt tuning.
5. **Safety design:** a threat model and sandbox/permission plan before Pi becomes generally usable; Pi's documentation makes this non-optional.
6. **Cost model:** API, gateway, cloud/sandbox and support costs under realistic turn/tool distributions, separately from subscription pricing.

## Source ledger

### Primary: vendor policy, product and pricing

- Anthropic: [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview), [subscription/SDK policy notice](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan), [other LLM gateways](https://code.claude.com/docs/en/llm-gateway).
- Kimi: [Claude Code integration guide](https://platform.kimi.ai/docs/guide/claude-code-kimi).
- Pi: [repository and licence](https://github.com/earendil-works/pi), [providers](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md), [SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md), [RPC](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md), [extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md).
- OpenCode: [repository](https://github.com/anomalyco/opencode), [releases](https://github.com/anomalyco/opencode/releases), [providers](https://opencode.ai/docs/providers), [models](https://dev.opencode.ai/docs/models/).
- Cursor: [pricing](https://docs.cursor.com/account/pricing). Devin: [self-serve plans](https://docs.devin.ai/admin/billing/self-serve), [deployment](https://docs.devin.ai/enterprise/deployment/overview). HumanLayer: [product materials](https://www.humanlayer.dev/). GitHub: [third-party coding agents](https://docs.github.com/en/copilot/concepts/agents/about-third-party-coding-agents).

### Primary: interoperability standards

- [Agent Client Protocol](https://github.com/agentclientprotocol), [ACP architecture](https://agentclientprotocol.com/get-started/architecture), [Model Context Protocol architecture](https://modelcontextprotocol.io/specification/2025-06-18/architecture), [A2A specification](https://a2a-protocol.org/v1.0.0/).

### Internal project evidence

- `CONTEXT.md` and the current Session adapter contracts were reviewed for the project’s durable-Session, explicit-profile and capability-honesty constraints. They are not external market evidence.
