# Code Mode for Pi Sessions: design, prototype and benchmark (VC-471, phase 1)

**Status:** phase 1. Prototype on this branch, off by default, developer opt-in
only (`VOLLI_DEV_CODE_MODE`, unpackaged builds). Phase 2 (shipping it) waits on
the owner's decision on the numbers below.

**Inputs:** VC-245's note ([`docs/research/pi-parallel-tool-execution-vc-245.md`
at `fa3f96cd`](https://github.com/hussainph/volli-code/blob/fa3f96cdacf9f83ce6f256cffdcd73d174feb031/docs/research/pi-parallel-tool-execution-vc-245.md),
pruned from `docs/` by VC-460), VC-454's bounded MCP reads, VC-469's Pi 0.99
structured results, and `@earendil-works/pi-codemode` 0.99.2.

> **Recommendation: change before shipping; do not turn it on by default yet.**
> The mechanism works and is safe: every VC-245 §3 rule is enforced on the host
> side and tested, and no trial lost correctness where the model chose Code Mode
> on its own (`both` routing, all four models). On the shape it was built for it pays off — Haiku 4.5's `bash`/`read`
> loop-and-filter task took **64% fewer input tokens, 97% fewer tool-result
> tokens, 4 model calls instead of 6, and 29% less cost**. But under the safe
> routing (`both`: every tool still declared) **two of four models never wrote a
> program at all** (GPT-5.5, GLM-5.3 Flash: 0 of 24 trials), and the description
> costs **every request ~2,000–2,500 input tokens** (+62% to +86% on the
> single-call control). Code-only routing makes every model use it but breaks
> smaller ones (Haiku 4.5 16/20 correct against 20/20 direct; GLM-5.3 Flash's
> Browser task 1/3) for reasons Volli can fix. Ship phase 2 only with the five
> changes in [Recommendation](#recommendation), per model, off by default.

---

## 1. What the prototype is

One more tool, `codemode`, whose argument is a short JavaScript program. The
program calls the Session's own tools as `await tools.<name>(args)`, and only
what it prints or returns reaches the model.

| piece | where |
| --- | --- |
| Routes, limits, the frozen record and its codec | `packages/shared/src/code-mode.ts`, `session-event-codec.ts`, `session-ledger.ts` (`tool-surface.codeMode`) |
| The `codemode` binding in the surface | `packages/shared/src/agent-runtime.ts` (`sessionToolBindings`), `authority.ts` (`NON_CODING_TOOL_IDS`) |
| The tool: check, schedule, dispatch, shape, replay, taint | `packages/agent-runtime/src/codemode/` |
| Declared tool array from the routes | `packages/agent-runtime/src/pi/tools.ts` (`createSessionTools`) |
| One gate, one activity path | `packages/agent-runtime/src/pi/runtime.ts` (`sessionGate`, `observeToolActivity`) |
| Developer opt-in, stamping at birth, rebind on attach | `apps/desktop/src/main/codemode/dev-config.ts`, `index.ts`, `session-runtime/pi-adapter.ts` |
| Benchmark | `packages/agent-runtime/bench/codemode/` |

The sandbox is Pi's `@earendil-works/pi-codemode`: a fresh worker thread and a
fresh QuickJS VM (WebAssembly) per run, whose only way out is the tool methods
handed to it. Everything Volli adds runs on the host side of that boundary.

**How to try it:** `VOLLI_DEV_CODE_MODE=1 pnpm dev`. Every Session created while
it is set is born with `codemode`; unset it and relaunch, and new Sessions are
born without it. Sessions that already have it keep it (see Routes). A JSON value
sets MCP server routes and limits: `{"mcp": {"<serverId>": "deferred"}, "limits": {"maxNestedCalls": 100}}`.

---

## 2. Product shape (VC-245 §2)

### The `bash` position (owner decision, recorded)

**Programs may call `bash`, and `read`.** Settled by the owner before the build,
and the arithmetic is why: VC-245's audit (rerun below) puts 70% of the loop
volume a program could absorb on `bash` and 25% on `read`. A Code Mode without
them is worth about 5% of the measured gain.

The condition is that a nested `bash` call passes **exactly the same authority
path as a direct one**, and in the prototype it does, by construction rather
than by copy:

- Pi's own `runToolCall` prepares and schema-validates the arguments, as it does
  for a model-issued call.
- The judgement is the Session's own `beforeToolCall` — **the same function
  instance** the `Agent` holds (`sessionGate` in `runtime.ts`). So the rule pack,
  the path and command normalization, the denial ledger, the escalation
  counters, the `ask` port and the observability record are one Session's, not
  two. The auto-mode classifier (VC-28) is not built yet; when it is, it lives in
  that gate and nested calls get it for free.
- The tool reached is the Session's own `AgentTool`, bound to the same execution
  environment (and so the same sandbox profile, VC-266's when it lands), the same
  ports, the same host handlers, and the same Session identity — which is closed
  over, never stated in a call.
- One hole the parity tests found and the prototype closes: the `codemode` call
  itself is "a call that ran", and would reset the consecutive-refusal counter
  between two refused calls. The gate now lets an allowed `codemode` call pass
  without touching the counter (`runtime.ts`), and a test proves two direct
  refusals plus one nested refusal trip the threshold on the third.

**When a check needs a person mid-program, the program pauses.** The nested
call's promise stays pending while the gate parks on the `ask` port; the VM has
no timers or I/O, so the program simply waits. Its running-time clock stops
while any call is judged and while any Volli verb runs (a verb's only wait is a
person answering a budget question). Every other call queues behind the
judgement lock, so **no second judgement and no second question can start**. A
call that runs alone (anything but a read) holds that lock from its judgement to
its end, which also keeps a verb's own budget question from overlapping a
judgement's. The answer resolves the pause: `allow` runs the call, `refuse`
rejects it in the program with the rule's words, `stop` ends the turn and with it
the run and every nested call in flight.

### Routes

Pi's MCP `exposure` vocabulary, renamed where Pi's word means something else in
Volli. Pi's `direct` is Volli's `both`, because Volli needs a word for a tool a
program may *not* call.

| route | declared to the model | callable from a program | in the `codemode` description |
| --- | --- | --- | --- |
| `direct` | yes | no | no |
| `both` | yes | yes | first sentence + TypeScript |
| `code` | no | yes | full description + TypeScript |
| `deferred` | no | yes | counted only; found with `searchTools()` |
| `hidden` | no | no | no |

**Defaults** (`defaultToolRoute` in `@volli/shared`):

| tool | route | why |
| --- | --- | --- |
| `read`, `edit`, `write`, `bash` (`execute`) | `both` | the 95%; writes run alone, in issue order |
| `web_fetch`, `web_search`, Browser reads and `browser_navigate`/`browser_act` | `both` | untrusted output is enveloped (§3) |
| `session.start`, `session.delegate`, `watch`, `mcp.list` | `both` | the multi-Session shape |
| `ask_user` | `direct` | a loop that asks interrupts a person N times; the model should ask once |
| `todo_write` | `direct` | its readers fold the list out of the model's own calls |
| `shell_start` / `shell_output` / `shell_kill` | `direct` | a background process outlives the program that started it |
| `browser_screenshot` | `direct` | its whole result is an image, and no image enters a program (below) |
| `browser_acquire` / `browser_release` | `direct` | a turn-level promise to a person; writes take holds implicitly |
| every other verb (`session.stop`/`send`, `automation.run`, MCP mutations) | `direct` | each one should be seen, called, on its own |
| MCP tools | the host's per-server route, `both` when it chose none | `deferred` for a large server |

**Recorded in the frozen surface.** The `tool-surface` Session input gains
`codeMode: { routes, limits }`, written by main at Session birth beside the
names it routes, and `codemode` joins the names (appended last in the capability
vocabulary, for the Cache Prefix reason every name before it was). The codec
refuses a record that routes a different surface, names `codemode` without
routes, or carries routes without `codemode`, so damage fails loudly rather than
binding a different provider tool array. A reattach reads the record and rebinds
it — the Pi adapter refuses a surface that names `codemode` without its record —
so **a restart gives the same routes**, and the declared array is the routes'
answer (`direct`/`both` tools plus `codemode` at its frozen position). A
`code`, `deferred` or `hidden` tool is not in the `Agent`'s array at all, so a
direct call to it is "Tool not found": the route is structural.

**A route change applies only to new Sessions.** The opt-in, the server routes
and the limits are read when a Session is born and frozen there. Unsetting the
variable is the kill switch for new Sessions only: removing `codemode` from a
Session that has it would change its provider tool array, which the
frozen-surface rule forbids. A subagent is bounded by its parent's record: no
`codemode` in the parent, none in the child. A legacy backfill is never born
into Code Mode.

### Script interface

Generated from the same frozen tool array the `Agent` declares, so there is no
second list:

- **Methods:** one per code-callable tool, `tools.<identifier>(args)` and
  `tools["<wire name>"](args)`, from each `AgentTool`'s own name.
- **Declarations:** TypeScript from each tool's own `parameters` (built-ins'
  TypeBox schemas, the Verb Registry's field schemas, MCP `inputSchema`) and an
  output type per kind, rendered by pi-codemode's `renderDeclarations`.
- **Result shapes** (`codemode/shape.ts`) — so a program never parses display
  text:

  | tool | resolves to |
  | --- | --- |
  | `bash` | `{ output, exitCode, truncated, fullOutputPath? }` for every exit code |
  | MCP tools | `{ text, structuredContent?, isError, omittedImages }`, typed by the frozen `outputSchema` (VC-469) |
  | Volli verbs | `{ text, details? }` |
  | everything else | its text |

  A refused or failed call rejects with the words a direct call would have shown
  the model. A non-zero `bash` exit and an MCP `isError` are answers, not
  failures, and resolve (as in Pi's own codemode).

- **One measured gap: verbs.** The benchmark found that a verb's `{ text }` is
  not enough. `session.start` returns prose and no `details`, so a program that
  needs the new Session's handle has to parse a sentence — and Haiku's programs
  did, wrongly, in 3 of 5 code-only trials (`"S\nS\nS\nS"`). Typed verb outputs
  are a phase 2 prerequisite (Recommendation, change 3).

### Large tool sets

Three mechanisms, all built except the last:

1. **A declaration budget.** TypeScript for listed tools is rendered in surface
   order until `declarationBudgetTokens` (default 3,000, Pi's) is spent. Every
   namespace (`volli`, `mcp:<serverId>`) is still named with its count, and the
   description says whether the list is complete.
2. **Discovery in the program.** `await searchTools(query, { limit, namespace })`
   ranks every callable tool by BM25 over names and descriptions, and
   `await describeTool(name)` returns one tool's full description and declaration.
   Neither is a tool call. A `deferred` tool is only ever counted in the
   description.
3. **`tool_search` for models without Code Mode — designed, not built.** Pi's
   `tool_search` declares the matches for the next call. In Volli that changes
   the provider tool array mid-Session, and both Anthropic and OpenAI put tools at
   the head of the cached prefix, so each load re-writes the whole cache once (a
   cache write at 1.25–2× instead of a read at 0.1×). That is acceptable when
   loads are rare and the server is large, and it must be recorded in the
   Session's history like Pi records it, so a restart rebinds the loaded set.
   Phase 2 builds it only if a measured large-server Session needs it without
   Code Mode; with Code Mode, `deferred` costs nothing.

**Measured prompt cost** (`bench/codemode/prompt-cost.bench.test.ts`, offline,
o200k tokens of each declared tool's name, description and schema; a Ticket
Session's built-in tools plus N synthetic GitHub-shaped MCP tools; Volli caps a
Session at 128 MCP tools):

| MCP tools | no Code Mode | `both` | MCP `code` | MCP `deferred` | `only` (all `code`) |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | 1,599 (7 tools) | 2,737 (8) | — | — | 2,247 (3) |
| 10 | 2,787 (17) | 4,827 (18) | 3,800 (8) | 2,771 (8) | 3,310 (3) |
| 50 | 8,322 (57) | 11,756 (58) | 5,031 (8) | 2,771 (8) | 4,052 (3) |
| 120 | 17,297 (127) | 20,731 (128) | 5,031 (8) | 2,771 (8) | 4,052 (3) |

- **Code Mode's own cost is ~1,100 tokens** of declarations on a small surface
  (o200k); the live runs measured **~2,500 input tokens per request** with
  Anthropic's serialization and tokenizer (4,011 → 6,536 on the single call).
- **Routing a large server away from the declarations holds the prefix flat**:
  120 MCP tools cost 17.3K tokens declared directly, 5.0K routed `code` (capped
  by the budget), 2.8K routed `deferred`.

### Simple calls, waits for a person, screenshots, side effects

- **Simple calls stay direct.** The description says to call a tool directly for
  one call, and every model did: none of the 14 `both`-routed single-call trials
  used `codemode`.
- **Calls that wait for a person:** `ask_user` is direct-only. Approvals inside a
  program pause it, one prompt at a time (above).
- **Screenshots:** direct-only, because of the image rule (§3).
- **Side effects:** allowed (`bash`, `write`, `edit`, `session.start`, …), each
  through the same gate, each run alone and in issue order, each with a stable id
  the host's own idempotency keys off (§3).

### Adopt, not build: pi-codemode

| question | answer |
| --- | --- |
| version fit | 0.99.2, the same release line as the pinned `pi-agent-core`/`pi-ai` 0.99.2; pinned exactly, like them |
| licence | MIT; its one dependency `quickjs-wasi` 3.6.2 is MIT (QuickJS compiled to WebAssembly). Both are in the regenerated `THIRD-PARTY-NOTICES`, with `acorn` (MIT) |
| update cost | low: a standalone package with no Pi dependency, used through four functions (`CodemodeSandbox`, `loadQuickJSWasm`, `renderDeclarations`/`renderToolSample`, `parseCodemodeSource`) |
| Pi extension APIs | none. The coding agent's codemode *extension* (exposure, `tool_search`, the session store) is not used; Volli's layer is its own, over the frozen surface |
| Pi Fabric | not used |
| why not a Volli sandbox | the hard part — an isolated VM with interrupts, memory limits and a single host bridge — is exactly what the package is, and it is Pi's own |

### Fallback for models and providers that do badly

- **`both` is the fallback built in.** Every tool stays declared, so a model that
  never writes a program loses nothing but the description's tokens — and no
  `both`-routed trial of any of the four models failed.
- **Per-model mode** (phase 2): off, `both` or `only` per model, from a host-owned
  list frozen at birth like the routes. The benchmark is the first entry in it:
  two of four models never chose Code Mode under `both`, and only the two larger
  ones were safe under `only`.
- **Teaching in the answers:** a program that reaches for Node (`require`,
  `process`, `fetch`, …) gets an error that says what to do instead, and the
  description carries one worked loop when `bash` and `read` are callable — both
  added after Haiku's first program was `require("fs")`.
- **Not `only` by default.** Code-only routing failed small models in ways `both`
  cannot: Haiku concluded the Browser tools did not exist (1 of 5) and parsed a
  verb's prose (3 of 5); GLM-5.3 Flash fixated on the one Browser tool left
  declared (2 of 3). See the benchmark.
- **The kill switch** is per new Session (above); phase 2's setting is per
  project and global.

---

## 3. Safety and lifecycle (VC-245 §3): each rule, where it holds, how it is tested

Tests are in `packages/agent-runtime/src/codemode/*.test.ts` (unit, over
stand-in tools), `runtime-codemode.test.ts` (the real Session path: real
`createPiAgentRuntime`, real gate, real `bash`/`read`/`write` against a temporary
worktree, only the provider scripted), `packages/shared/src/code-mode.test.ts`
and the codec suite, and `apps/desktop/src/main/codemode/dev-config.test.ts`.

| rule | mechanism | proved by |
| --- | --- | --- |
| Fresh sandbox, no Node, env, files, network, subprocess; only named tools | pi-codemode: a new worker and QuickJS VM per run; the VM's only imports are a WASI clock/random shim and one host-call bridge | *offers a program nothing but its tools* (`process`, `require`, `fetch`, timers, `WebAssembly`, `Buffer`, `import()`); *starts each run in a fresh VM* |
| Hard limits: time, memory, output, nested calls, concurrency | frozen `limits`; an active-time `RunClock` (pauses on judgement), the VM heap limit, a middle cut with the whole saved, a call counter, `ExecutionSlots` | *spins past its running time*; *memory limit*; *cuts long output … saves it whole*; *nested-call limit*; *overlaps reads, runs everything else alone* (peak = limit) |
| Whole program parsed and checked before any call; invalid code has no side effects | `checkScript`: acorn parses it as one async function body (so it cannot close the sandbox's wrapper), every `tools.<name>` must be code-callable, `codemode` is refused by name, the options line may only lower limits | *parses and checks the whole program before any call runs* (late syntax error, unknown tool, self-call, wrapper break-out: the file the first line would write never exists) |
| Settings and eligibility from app-owned state | routes and limits frozen by main at birth in the Session ledger; the runtime reads only `spec.tools.codeMode`; nothing reads the worktree | codec round-trip and refusal tests; *options line … never raise it*; `dev-config.test.ts` (packaged builds ignore the variable) |
| Only the frozen surface; never `codemode` | the sandbox is handed exactly the code-callable tools of the surface; `codemode` is not among them | *declares direct and both tools … rebinds the same array*; *does not offer a direct-only or hidden tool*; self-call refusal |
| Same input checks, identity, authority, role limits, budgets, refusals, host handler | Pi's `runToolCall` + the Session's own gate instance + the Session's own `AgentTool` | *judges a nested bash call exactly as it judges the same call made directly* (same rule, same words, one escalation counter); *hands a nested verb call the outer call's derived id and nothing about who is calling* |
| Stable nested ids; replay never repeats a completed effect | id `<outer>:<n>` in issue order; `Date`/`Math.random` pinned per outer call; a per-attachment journal answers completed positions and stops a diverged replay; verbs derive their durable operation id from the id they are handed (`<session>:<outer>:<n>`) | *answers completed calls from the journal and never repeats their effect*; *stops a replay that diverges*; *runs again a call that never finished*; *keeps the effect of a call that finished after its signal fired*; *pins Date and Math.random* |
| Cancellation reaches nested calls | the turn's signal and the attachment's abort the run; the sandbox aborts each pending call's signal; queued calls leave the queue without running | real `sleep 30` killed on interrupt, the queued `write` never happens; unit cases for in-flight, queued and pre-cancelled calls |
| Stable result order; explicit partial failure | `Promise.all`/`allSettled` order in the VM; per-call status in the result header and in `details.nestedCalls` | *overlaps reads … returns results in the order asked*; *makes a partial failure explicit* |
| Approvals never several at once | one judgement lock, FIFO; non-read calls hold it through their run; the clock pauses | *pauses the program on an approval, one prompt at a time* (three approvals, peak one, the first longer than the whole budget); *never lets a judgement's question overlap a verb's own budget question* |
| Within VC-454's per-server MCP bound | nested MCP calls go through the same `RuntimeMcpPort`, which main binds through the process-wide `McpServerBudget`; only host-marked reads overlap | *keeps a program's overlapping MCP reads inside the per-server bound*: six marked reads issued at once, concurrency limit six, a bound of two — the server sees two |
| Visible in activity, logs and cost records | nested events go through the runtime's own `observeToolActivity` (same mapping, same ordered delivery, same recovery marker), under their own ids; the gate records observability per nested call; the result's `details.nestedCalls` is Pi's bounded `NestedToolCalls` | the real-path loop test asserts 14 activity rows and 8 gate decisions; *bounds the nested call record it keeps* |
| Web, Browser and MCP content stays marked untrusted | taint per run: any call to those tools envelopes the whole output in markers whose id is minted after the program finished | *keeps web content marked untrusted in whatever the program returns* (a forged end marker in the page stays inside) |
| Images designed before screenshots are code-callable | phase 1's design: no image enters a program (placeholders naming the type) and none leaves one (`image()` output dropped and counted); `browser_screenshot` is `direct` | *lets no image into a program or out of one* |

**Two honest limits of the replay guarantee.** The journal lives as long as the
attachment. Pi's `Agent` never runs a tool call id twice, and a relaunch does not
re-run an unfinished tool call, so the journal guards a replay path Volli does not
take today. The durable half is the one that matters now: a nested
`session.start` reaches the door with `<outer>:<n>`, which the door turns into its
operation id, so a re-issued start is one start across a relaunch. And
`Promise.race` over calls whose results arrive in a different order on a replay
can issue a different call at a position the journal holds; that is the
divergence the journal stops, with nothing run.

**What Pi 0.99 records that Volli does not yet.** Pi's `ToolResultMessage`
carries `nestedCalls`; Volli's plain `Agent` loop does not copy it from a result,
so the bounded record rides the codemode result's `details` (persisted and on the
activity row) instead. `parentToolCallId` is the coding agent's extension field;
Volli's nested ids name their parent instead (`<outer>:<n>`).

---

## 4. Benchmark: direct calls vs Code Mode

**Method** (`bench/codemode/codemode.live.test.ts`, `tasks.ts`, `report.ts`).
Every trial is a real Session on `createPiAgentRuntime`: Volli's composed system
prompt, the Agent Tool Surface, real `bash`/`read` against a real fixture
worktree, stand-in Browser and verb hosts that answer as the real ones do, and the
runtime's own usage observations. No Authority Snapshot (the product default,
`observe`, installs no gate; the gate's parity is the unit suite's job). Three
arms, interleaved per trial so provider drift lands on all three:

- **direct** — no Code Mode.
- **codemode** — Code Mode with every tool `both`: the model chooses.
- **codemode-only** — Pi's `codemode.mode: only`: every code-callable tool routed
  `code`.

Tasks: (a) **loop-filter** — 16 `package.json` files; name the packages that
depend on `left-pad` *and* have more than ten runtime dependencies, with the
range each pins (one `grep` finds eight candidates; deciding takes reading each);
(b) **browser-tabs** — four pages in four tabs, which show a Sign in button
(~3 KB snapshots, 400 ms page loads); (c) **session-fanout** — start Sessions on
four tickets and watch them (since VC-457 a Session is awaited by watching it);
(d) **single-call** — read one version (the control). Correctness is graded
against a key the fixture computes; tokens are input + cache read + cache write;
"tool-result tok" is what entered the model's context from tool results. Medians.

### claude-haiku-4-5 (5 trials per cell)

| task | arm | correct | input tok | tool-result tok | model calls | nested calls | elapsed | cost | used codemode |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| loop-filter | direct | 5/5 | 42,699 | 7,920 | 6 | 0 | 15.1 s | $0.0299 | 0/5 |
| loop-filter | codemode | 5/5 | **15,335** | **269** | 4 | 17 | 11.4 s | $0.0211 | 5/5 |
| loop-filter | codemode-only | 5/5 | **9,656** | **157** | 3 | 17 | 8.0 s | $0.0137 | 5/5 |
| browser-tabs | direct | 5/5 | 13,143 | 5,302 | 2 | 0 | 7.5 s | $0.0172 | 0/5 |
| browser-tabs | codemode | 5/5 | 16,792 | 5,298 | 2 | 0 | 5.8 s | $0.0105 | 0/5 |
| browser-tabs | codemode-only | 4/5 | 18,658 | 998 | 4 | 9 | 12.2 s | $0.0148 | 4/5 |
| session-fanout | direct | 5/5 | 9,534 | 251 | 3 | 0 | 4.6 s | $0.0113 | 0/5 |
| session-fanout | codemode | 5/5 | 13,605 | 251 | 3 | 0 | 6.2 s | $0.0068 | 0/5 |
| session-fanout | codemode-only | 2/5 | 6,753 | 32 | 2 | 5 | 5.1 s | $0.0083 | 5/5 |
| single-call | direct | 5/5 | 4,011 | 26 | 2 | 0 | 1.8 s | $0.0043 | 0/5 |
| single-call | codemode | 5/5 | 6,536 | 26 | 2 | 0 | 2.0 s | $0.0069 | 0/5 |
| single-call | codemode-only | 5/5 | 5,517 | 25 | 2 | 1 | 2.7 s | $0.0061 | 5/5 |

### claude-sonnet-4-6 (3 trials per cell)

| task | arm | correct | input tok | tool-result tok | model calls | nested calls | elapsed | cost | used codemode |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| loop-filter | direct | 3/3 | 6,712 | 160 | 3 | 0 | 7.5 s | $0.0092 | 0/3 |
| loop-filter | codemode | 3/3 | 6,871 | 82 | 2 | 17 | 6.2 s | $0.0086 | 3/3 |
| loop-filter | codemode-only | 3/3 | 5,817 | 82 | 2 | 17 | 4.7 s | $0.0080 | 3/3 |
| browser-tabs | direct | 3/3 | 13,103 | 5,300 | 2 | 0 | 5.4 s | $0.0293 | 0/3 |
| browser-tabs | codemode | 3/3 | 16,969 | 5,533 | 2 | 4 | 6.4 s | $0.0319 | 3/3 |
| browser-tabs | codemode-only | 3/3 | 14,148 | 5,722 | 3 | 9 | 11.8 s | $0.0292 | 3/3 |
| session-fanout | direct | 3/3 | 9,470 | 251 | 3 | 0 | 7.8 s | $0.0081 | 0/3 |
| session-fanout | codemode | 3/3 | 13,517 | 251 | 3 | 0 | 8.2 s | $0.0093 | 0/3 |
| session-fanout | codemode-only | 3/3 | 10,574 | 285 | 3 | 5 | 7.7 s | $0.0089 | 3/3 |
| single-call | direct | 3/3 | 4,013 | 26 | 2 | 0 | 2.3 s | $0.0021 | 0/3 |
| single-call | codemode | 3/3 | 6,517 | 26 | 2 | 0 | 2.5 s | $0.0029 | 0/3 |
| single-call | codemode-only | 3/3 | 5,495 | 22 | 2 | 1 | 2.9 s | $0.0035 | 3/3 |

### gpt-5.5 via OpenAI Codex (3 trials per cell)

| task | arm | correct | input tok | tool-result tok | model calls | nested calls | elapsed | cost | used codemode |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| loop-filter | direct | 3/3 | 4,029 | 178 | 3 | 0 | 9.9 s | $0.0267 | 0/3 |
| loop-filter | codemode | 3/3 | 4,554 | 66 | 2 | 0 | 13.1 s | $0.0216 | 0/3 |
| loop-filter | codemode-only | 3/3 | 4,072 | 84 | 2 | 17 | 5.8 s | $0.0208 | 3/3 |
| browser-tabs | direct | 3/3 | 12,960 | 5,288 | 3 | 0 | 12.9 s | $0.0500 | 0/3 |
| browser-tabs | codemode | 3/3 | 17,343 | 5,300 | 3 | 0 | 10.5 s | $0.0696 | 0/3 |
| browser-tabs | codemode-only | 3/3 | **5,958** | **209** | 2 | 4 | 11.5 s | **$0.0226** | 3/3 |
| session-fanout | direct | 3/3 | 6,060 | 251 | 3 | 0 | 16.4 s | $0.0217 | 0/3 |
| session-fanout | codemode | 3/3 | 9,393 | 251 | 3 | 0 | 12.0 s | $0.0292 | 0/3 |
| session-fanout | codemode-only | 3/3 | 8,374 | 430 | 3 | 5 | 12.3 s | $0.0301 | 3/3 |
| single-call | direct | 3/3 | 2,332 | 26 | 2 | 0 | 5.3 s | $0.0126 | 0/3 |
| single-call | codemode | 3/3 | 4,338 | 26 | 2 | 0 | 5.6 s | $0.0088 | 0/3 |
| single-call | codemode-only | 3/3 | 3,798 | 25 | 2 | 1 | 4.5 s | $0.0135 | 3/3 |

Cost is Pi's list-price estimate; the Codex subscription bills differently.

### glm-5.3-flash via Z.ai (3 trials per cell)

| task | arm | correct | input tok | tool-result tok | model calls | nested calls | elapsed | cost | used codemode |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| loop-filter | direct | 3/3 | 4,876 | 190 | 3 | 0 | 22.6 s | $0.0004 | 0/3 |
| loop-filter | codemode | 3/3 | 8,202 | 168 | 3 | 0 | 30.4 s | $0.0008 | 0/3 |
| loop-filter | codemode-only | 3/3 | 4,462 | 78 | 2 | 9 | 20.4 s | $0.0003 | 3/3 |
| browser-tabs | direct | 3/3 | 10,828 | 5,290 | 2 | 0 | 18.5 s | $0.0010 | 0/3 |
| browser-tabs | codemode | 3/3 | 14,176 | 5,300 | 2 | 0 | 14.4 s | $0.0019 | 0/3 |
| browser-tabs | codemode-only | **1/3** | 20,664 | 1,910 | 6 | 0 | 37.4 s | $0.0012 | 1/3 |
| session-fanout | direct | 3/3 | 7,167 | 251 | 3 | 0 | 21.2 s | $0.0006 | 0/3 |
| session-fanout | codemode | 3/3 | 10,887 | 251 | 3 | 0 | 19.7 s | $0.0005 | 0/3 |
| session-fanout | codemode-only | 3/3 | 5,816 | 431 | 2 | 5 | 13.2 s | $0.0004 | 3/3 |
| single-call | direct | 3/3 | 2,907 | 11 | 2 | 0 | 11.3 s | $0.0001 | 0/3 |
| single-call | codemode | 3/3 | 5,171 | 11 | 2 | 0 | 11.7 s | $0.0002 | 0/3 |
| single-call | codemode-only | 3/3 | 4,218 | 25 | 2 | 1 | 12.0 s | $0.0003 | 3/3 |

### Summary across models

**Did the model choose Code Mode when every tool stayed declared (`both`)?**

| model | loop-filter | browser-tabs | session-fanout | single-call |
|---|---:|---:|---:|---:|
| claude-haiku-4-5 | 5/5 | 0/5 | 0/5 | 0/5 |
| claude-sonnet-4-6 | 3/3 | 3/3 | 0/3 | 0/3 |
| gpt-5.5 | 0/3 | 0/3 | 0/3 | 0/3 |
| glm-5.3-flash | 0/3 | 0/3 | 0/3 | 0/3 |

**Correct answers, all four tasks:**

| model | direct | `both` | `only` |
|---|---:|---:|---:|
| claude-haiku-4-5 | 20/20 | 20/20 | 16/20 |
| claude-sonnet-4-6 | 12/12 | 12/12 | 12/12 |
| gpt-5.5 | 12/12 | 12/12 | 12/12 |
| glm-5.3-flash | 12/12 | 12/12 | 10/12 |

**What the description costs, from the single-call control** (median input
tokens, direct → `both` → `only`): Haiku 4,011 → 6,536 → 5,517; Sonnet 4,013 →
6,517 → 5,495; GPT-5.5 2,332 → 4,338 → 3,798; GLM 2,907 → 5,171 → 4,218.

**Spend:** about $2.80 in total, $2.50 of it in the saved trials
(`node --experimental-strip-types packages/agent-runtime/bench/codemode/report.ts`
prints the latest per model and task).

### What the numbers say

1. **The loop shape wins where a model fans out, with no loss of correctness.**
   Haiku read the manifests one by one; a program absorbed it. Input tokens fell
   64% (`both`) and 77% (`only`), tool-result tokens 97–98%, model calls 6 → 4 →
   3, elapsed 15.1 → 11.4 → 8.0 s, cost $0.030 → $0.021 → $0.014, 5/5 correct in
   every arm. Under `only`, GPT-5.5's Browser task fell from 12,960 to 5,958
   input tokens and from 5,288 to 209 tool-result tokens, at 45% of the cost.
2. **A model that already writes the pipeline gains little.** Sonnet 4.6,
   GPT-5.5 and GLM-5.3 Flash solved loop-filter directly in two or three shell
   commands with under 200 tokens of results. `bash` *is* a programming
   environment, and a capable model uses it as one; Code Mode then saves a model
   call and little else.
3. **Under `both`, whether it is used depends on the model, not the task.** Haiku
   used it for the loop and nothing else; Sonnet for the loop and the Browser;
   GPT-5.5 and GLM never. Where Sonnet used it on the Browser task its programs
   returned the snapshots whole, so nothing was saved.
4. **It costs every request ~2,000–2,500 input tokens under `both`** — +62% to
   +86% on the single-call control. After the first request of a Session that is
   a cache read at ~0.1×, but it is paid on every request of every turn,
   including the 84% of replies that issue one call. `only` costs ~25% less than
   `both` because the routed tools are no longer declared directly.
5. **`only` routing fails small models in three traceable ways**, none of them in
   the sandbox: Haiku decided the Browser tools did not exist (1/5); Haiku parsed
   `session.start`'s prose for the new Session's handle instead of a field (3/5 —
   the real verb returns no structured result); GLM-5.3 Flash saw `browser_screenshot`
   as the only declared Browser tool — it stays `direct` — and called it 64 times
   against invented tab ids in one trial (2/3).
6. **No `both`-routed trial failed, on any model.** Every wrong answer in this
   benchmark came from code-only routing.

### Transcript audit, rerun

`node --experimental-strip-types packages/agent-runtime/bench/parallel-tools/transcript-audit.ts`,
read-only and aggregate-only, on this machine's Volli profile: **2,051 Sessions,
2,083 turns, 86,431 tool calls, $4,742 of recorded spend** (VC-245 had 671
Sessions). **Still one developer.** Sessions from other developers are not
available on this machine; the second Volli profile here (`Volli Code-dev`, 7
Sessions) is the same developer's. VC-245's caveat stands unanswered.

| quantity | VC-245 (671 Sessions) | rerun (2,051 Sessions) |
| --- | ---: | ---: |
| replies carrying 2+ calls | 16.9% | 16.0% |
| tool calls that could overlap | 23.6% | 22.4% |
| parallel mode's saving, share of all tool time | 1.2% | 1.2% |
| tool-result share of modelled context | 92.6% | 92.6% |
| tool-result volume from fan-out replies | 58.5% | 56.2% |
| homogeneous fan-out: `bash` / `read` | 69.3% / 26.3% | 70.0% / 25.4% |
| capture band (both structural signals) | 52.6–59.9% of fan-out | 53.4–60.6% of fan-out |
| program returns 10%: share of all billed context saved, after the band | 23.7–27.0%¹ | 17.6–19.9% |

¹ VC-245's band was computed against a modelled context within 11% of billed;
this run's modelled context is 0.80× billed (5.45B billed), and the audit applies
the band to billed context, so the share is lower on the same structure. The
shape of the opportunity — tool results dominate context, `bash` and `read`
dominate the fan-outs — is unchanged at three times the sample.

**Spend for this benchmark:** see the total at the end of
`node --experimental-strip-types packages/agent-runtime/bench/codemode/report.ts`.

---

## Recommendation

**Change before shipping, then ship per model, off by default.** The audit says
the opportunity is real (16% of replies, 56% of tool-result volume, 95% of it
`bash`/`read` loops), and the prototype captures it safely when a model writes a
program. What the numbers do not support is turning it on for everyone: under
`both`, half the models never use it and every request pays for its description;
under `only`, small models fail. Phase 2 should ship these changes, and its
default should follow a measurement on real Sessions rather than these four
tasks:

1. **Pay for the description only where it earns it.** Shrink it — the worked
   example and the rules are ~1,000 of its tokens, and a `both` tool needs a
   signature, not a sentence — and measure again. With per-model enablement (2),
   a model that never writes programs never pays.
2. **Per-model mode, from host-owned data frozen at birth:** off, `both` or
   `only`, like the routes. On this evidence: Haiku 4.5 `both`; Sonnet 4.6 and
   GPT-5.5 `only` is safe (24/24) but only pays on Browser-shaped work; GLM-5.3
   Flash off.
3. **Typed results for code-callable verbs.** Give `session.start`,
   `session.delegate` and `watch` an output schema in the Verb Registry and
   return it as `structuredContent`, as MCP tools do since VC-469, so a program
   reads `sessionId` instead of a sentence.
4. **Route a capability as a whole.** A Browser surface split so that only
   `browser_screenshot` is declared misled a small model badly. Routes should be
   chosen per capability group (all Browser tools, all shell tools), never leaving
   one stray member declared.
5. **Package it.** Ship pi-codemode's worker and `quickjs.wasm` in the app
   (`neverBundle` + `electron-builder.yml`, like jsdom); phase 1 resolves them
   from the workspace in unpackaged builds only.

**Then measure on real work before any default.** Extend `transcript-audit.ts`
to count `codemode` calls, their nested calls and their result tokens, run the
developer opt-in on real Sessions for a week, and set the default from that.
Then phase 2 as the ticket defines it: the per-project and global setting, MCP
per-server and per-tool routes in Settings → Configure → MCP Servers (with
`deferred` for large servers), and `docs/`. Not recommended: `only` as a
default, and `tool_search` before a measured need.

**`classify` (VC-478).** It had not merged when this ran, so it is not in the
surface or the benchmark. When it lands it should be `both` — bulk
classification in a loop is the shape that won here — and its result is already
structured.

## Known gaps

- The benchmark tasks are mine, built to exercise each shape; the audit says
  which shapes matter, not that these four are representative of them.
- Elapsed time includes provider latency and varies run to run; read it as a
  direction. Token and call counts are stable across trials.
- `tool_search` is designed, not built.
- Packaged builds cannot run a sandbox in phase 1 (by design: they never offer
  Code Mode).
- Nested calls do not stream partial output into activity; a long nested `bash`
  shows as started until it ends.
