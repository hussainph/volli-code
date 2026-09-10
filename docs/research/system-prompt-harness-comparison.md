# System prompt comparison: Volli, Codex, Oh My Pi, and OpenCode

Snapshot date: 2026-09-09

## Scope and method

This compares model-visible harness instructions, not embeddings and not benchmark performance.

Primary counts use JavaScript string length and `ceil(chars / 4)` for one consistent rough token estimate. Provider tokenization remains the count of record. Unless noted, counts exclude:

- provider request wrappers;
- native tool JSON schemas and descriptions;
- the user's task;
- repository instruction files such as `AGENTS.md`;
- MCP server instructions; and
- dynamically discovered skill bodies.

That exclusion matters. A harness can keep tool descriptions in the API's `tools` field, put them in the system prompt, or do either depending on provider. Mixing those paths produces a misleading comparison.

Upstream snapshots:

- Volli `0.2.0-canary.7` at `90fa4cfe9917050d6e65352c54d4b4957b7c7dc1`, plus the VC-332 prompt/index changes measured below
- [OpenAI Codex `c77c34ed`](https://github.com/openai/codex/tree/c77c34ed33877a6e5b3759703d01d3b223274cbf)
- [Oh My Pi `34e938c3`](https://github.com/can1357/oh-my-pi/tree/34e938c3b37ab3b60375a6cef9c137166cb5fb70), package `18.1.15`
- [OpenCode `830d5eb5`](https://github.com/anomalyco/opencode/tree/830d5eb5354874105cc31599635a80c1662609e8), package `1.18.30`

## Size

| Harness/configuration | Characters | Words | Rough tokens | What is counted |
|---|---:|---:|---:|---|
| Volli core Board prompt | 2,344 | 369 | 586 | Five stable layers, including the 195-token Execution contract; no prompt resources |
| Volli in this checkout | 4,771 | 738 | 1,193 | Core plus RESOURCE framing and the current three-skill index |
| OpenCode model variants | 7,362–15,372 | 1,171–2,235 | 1,841–3,843 | Codex, Anthropic, GPT, and Gemini base prompt files |
| Oh My Pi, native tools | 9,053–11,240 | 1,196–1,495 | 2,264–2,810 | Rendered default template with four-core to feature-rich common tool sets |
| Codex current sampled GPT templates | 12,896–21,544 | 2,089–3,511 | 3,224–5,386 | GPT-5.4, GPT-5.6 Sol, GPT-6 Astra, and GPT-5.2 model templates |

Volli's full measured startup package in this checkout is 5,790 characters, or about 1,449 tokens. That adds the message-side Runtime Brief and SESSION TOOLS reminder, but still excludes native tool definitions, user text, and provider overhead. The 2,048-character skills-index text ceiling bounds the same package at about 1,478 estimated tokens even when the index is full.

The current Volli system prompt is about 65% of OpenCode's shortest sampled prompt, 42% of OMP's feature-rich native-tool render, and 37% of the shortest sampled current Codex GPT template. The resource-free Volli core is 11–32% of the competing base prompts.

### VC-332 before/after measurement

Both sides use the `volli prompt baseline --json` composition and its `ceil(chars / 4)` estimate for the same fresh Board Session inputs. The skill supply is unchanged and remains below the new ceiling.

| Section/rollup | Before chars | Before ~tokens | After chars | After ~tokens |
|---|---:|---:|---:|---:|
| `execution` | 0 | 0 | 778 | 195 |
| `resource:skills index` | 2,003 | 501 | 2,003 | 501 |
| System prompt | 3,991 | 998 | 4,771 | 1,193 |
| Full Volli-composed startup | 5,010 | 1,254 | 5,790 | 1,449 |

OMP's often-cited “~40k token prompt” is not its base prose. Its non-native-tool path can inline the full tool catalog, and skills, rules, workspace context, and tool schemas add on top. [OMP issue #7194](https://github.com/can1357/oh-my-pi/issues/7194) measured 35,974 tokens from one 226-skill catalog alone. With native tool calling and no project additions, the representative render here is roughly 2.3k–2.8k tokens.

## Design comparison

These grades describe observable prompt architecture, not task success rates.

| Dimension | Volli | Codex | Oh My Pi | OpenCode |
|---|---|---|---|---|
| Instruction economy | A+ | C | B- | B |
| Prefix stability and auditability | A+ | B | C+ | B- |
| Authority and injection boundaries | A | B | B+ | C+ |
| Coding workflow and completion doctrine | B+ | A- | A | B+ |
| Tool-routing guidance | B+ | B+ | A+ | A- |
| Scoped repository-instruction discovery | B | A | A | A |
| Model-family tuning | C | A | B | A- |
| Prompt maintainability and drift control | A | B | C+ | C+ |

### Where Volli leads

1. **Deterministic ownership.** `composeSystemPrompt` is a pure function of Role, coding tool bundle, and supplied resources. Session id, path, date, live policy, and measured environment facts cannot enter it.
2. **Explicit trust semantics.** Repository files, Ticket prose, tool output, and RESOURCE bodies are clearly material rather than new authority. The competitors load project instructions effectively, but do not draw this boundary as consistently.
3. **Cache-aware placement.** Volatile Runtime Brief and environment facts are message-side. The stable prompt and frozen tool surface can remain byte-stable across turns and reattachments.
4. **Measurability.** `volli prompt baseline --json` exposes section-level character/token estimates and cache classes. Prompt cost is a product-visible contract rather than an invisible side effect.
5. **Bounded progressive disclosure.** The skills index is sorted by a locale-independent ASCII-ordinal Skill-name order and capped at 2,048 characters of resource text (about 512 estimated tokens before its delimiter). It shortens descriptions, then withholds the ordinal tail, and says when either happened without changing Auto/Manual/Off or permitted `/skill` invocation.
6. **Compact execution contract.** One 778-character, roughly 195-token layer distinguishes reporting from implementation, requires convention inspection and change preservation, routes toward specialized/parallel tools, and defines verification and completion evidence.

Primary sources: [`packages/agent-runtime/src/prompt.ts`](../../packages/agent-runtime/src/prompt.ts), [`packages/agent-runtime/src/prompt-baseline.ts`](../../packages/agent-runtime/src/prompt-baseline.ts), [`packages/shared/src/skill.ts`](../../packages/shared/src/skill.ts), [`packages/shared/src/agent-tool-surface.ts`](../../packages/shared/src/agent-tool-surface.ts).

### Where Volli still trails

1. **Fine-grained tool routing.** Volli now prefers available specialized tools and parallel independent reads, but leaves exact search/file/AST/LSP/browser routing to native tool descriptions and model judgment. OMP names more substitutions explicitly.
2. **Repository convention discovery.** Volli now requires inspecting applicable instructions before editing, but unlike Codex, OMP, and OpenCode it does not discover scoped instruction files automatically. The ordinary read remains visible and deterministic, at the cost of model judgment.
3. **Model adaptation.** Volli uses one model-independent doctrine. Codex maintains per-model templates and OpenCode selects one of ten model-family prompts. This creates drift for them, but lets them tune around model-specific behavior.
4. **Hard-boundary alignment.** Volli truthfully says commands run on the user's machine, but workspace write limits and credential avoidance are prompt norms while default authority posture remains `observe`. Codex's sandbox and approval text describes a stronger enforced boundary.

## Competitor takeaways

### Codex

Codex spends heavily on interaction quality: commentary cadence, final-answer rendering, dirty-worktree handling, autonomy, destructive actions, skills, and task-type distinctions. Its strongest ideas for Volli are the change-versus-explain distinction, preservation of concurrent user work, and explicit completion criteria. Its weakest pattern is volume: current templates devote thousands of tokens to personality, formatting, and examples, and server/model template variation makes exact prompt provenance harder.

Primary sources: [`models.json`](https://github.com/openai/codex/blob/c77c34ed33877a6e5b3759703d01d3b223274cbf/codex-rs/models-manager/models.json), [`default.md`](https://github.com/openai/codex/blob/c77c34ed33877a6e5b3759703d01d3b223274cbf/codex-rs/protocol/src/prompts/base_instructions/default.md).

### Oh My Pi

OMP has the strongest operational playbook and the tightest prompt-to-tool routing. Its template conditionals adapt to the actual tools and features present. The cost is a dense wall of RFC-style imperatives and many dynamic terms in the first system block. Native tool calling keeps a normal render reasonable; inline descriptors and uncapped catalogs can become enormous.

Primary sources: [`system-prompt.md`](https://github.com/can1357/oh-my-pi/blob/34e938c3b37ab3b60375a6cef9c137166cb5fb70/packages/coding-agent/src/prompts/system/system-prompt.md), [`system-prompt.ts`](https://github.com/can1357/oh-my-pi/blob/34e938c3b37ab3b60375a6cef9c137166cb5fb70/packages/coding-agent/src/system-prompt.ts), [`project-prompt.md`](https://github.com/can1357/oh-my-pi/blob/34e938c3b37ab3b60375a6cef9c137166cb5fb70/packages/coding-agent/src/prompts/system/project-prompt.md).

### OpenCode

OpenCode is between Volli and the larger harnesses on size and includes good convention loading, specialized-tool preference, parallel-call guidance, objective tone, and model-family prompts. Its main architectural weakness is divergence: model selection is substring-based, and prompt variants disagree on workflow and style. [Issue #13605](https://github.com/anomalyco/opencode/issues/13605) documents the same concern.

Primary sources: [`system.ts`](https://github.com/anomalyco/opencode/blob/830d5eb5354874105cc31599635a80c1662609e8/packages/opencode/src/session/system.ts), [`gpt.txt`](https://github.com/anomalyco/opencode/blob/830d5eb5354874105cc31599635a80c1662609e8/packages/opencode/src/session/prompt/gpt.txt), [`anthropic.txt`](https://github.com/anomalyco/opencode/blob/830d5eb5354874105cc31599635a80c1662609e8/packages/opencode/src/session/prompt/anthropic.txt).

## Shipped response

VC-332 implements the recommendation without importing native tool descriptions or introducing model-specific prompt forks:

- one product-literal **Execution** section at 778 characters / roughly 195 estimated tokens, inside the proposed 150–250-token budget;
- a deterministic 2,048-character total budget for skills-index resource text, with stable ASCII-ordinal name ordering, 160-character overflow descriptions, ordinal-tail omission, and an in-budget disclosure notice; and
- focused snapshot, cache-stability, policy, `/skill`, ceiling, and runtime coverage.

The remaining model-specific question stays evidence-gated: add a small overlay only if evaluation shows that one model family needs it, rather than forking the whole prompt preemptively.

## Bottom line

Volli retains the smallest core, clearest ownership, strongest reproducibility, and most deliberate cache boundary of the four. Its compact execution contract now buys the highest-leverage workflow guarantees without the larger harnesses' personality and formatting tax, while the aggregate skills ceiling removes the only unbounded startup section. Codex and OMP remain more prescriptive about individual tool routes and repository-instruction discovery.
