# Decision models (VC-478)

A **decision model** is the second model kind Volli runs, beside the chat model.
It is a classifier: it reads a JSON **state** and answers named, typed
**questions** — `choice` (one option key of several), `score` (a level on a
scale, lowest first) or `bool` (yes or no) — with probabilities and a
confidence. It writes no text, which is why it answers in milliseconds for a
fraction of a chat turn's cost. pi-ai 0.99 provides the models; this document
is how Volli uses them.

## What a person configures

**Settings → Models → Decision model**, with a per-project override in
**Configure → Sessions** (the chat model's own scoping, VC-112):

| Choice | What it is | What leaves the Mac |
| --- | --- | --- |
| **None** (default) | No decision model. Every caller falls back; agents get no `classify` tool. | Nothing. |
| **Local** | A chat model served by llama.cpp's `llama-server`, turned into a classifier by pi's `llama-cpp-classify` (next-token log-probabilities over single-token labels). Base URL plus an optional model id (router mode needs it; a single-model server ignores it). | Nothing. The URL must be loopback (`localhost`, `127.0.0.0/8`, `[::1]`); a LAN address is refused, because "local" promises the state stays on this Mac. |
| **Cloud** | A classifier from Pi's catalog — TypeSafe's Jev on `typesafe`, `openrouter`, `cloudflare-workers-ai`, `vercel-ai-gateway` or `opencode`, plus whatever else the catalog lists. | Whatever each enabled purpose sends (below). Requires an explicit opt-in, recorded with the setting. |

Storage: the app-wide setting is `app_state["volli:decision-model"]`; a
project's override is `projects.decision_model` (migration 053, `NULL` =
inherit, `{ "kind": "none" }` = this project turned it off). Every read goes
back through `parseDecisionModelSetting`, so a row another build wrote — a
cloud setting without its opt-in, a non-loopback local URL, a server kind
this build does not know — reads as no decision model rather than as a call
nobody agreed to. That holds for a project row too: an unreadable project row
turns decision models off for that project, never falls through to an
app-wide cloud model. A project override can pick None, the app-wide local
server (or the default one), or a cloud model; its own server URL is not
configurable in this version.

### Credentials

Cloud classifiers authenticate exactly like chat providers: through Pi's own
`auth.json` (`packages/agent-runtime/src/pi/models.ts`), entered by a person in
**Settings → Models → Accounts**. Model Access now lists providers that serve
only decision models (`typesafe`), because there is finally something on the
page to pick them for; VC-469 hid them when there was not. A provider with no
credential shows **Needs setup** in the Decision model section, whose one
action presses that provider's own sign-in. No setting, IPC channel, tool,
verb or Session record has a field a key could occupy, and the tests pin it
(`decision-model.test.ts`, `classify-tool.test.ts`, `desktop.test.ts`).

### The cloud opt-in

A cloud setting carries `optIn: { acceptedAt, purposes }`. A purpose the
opt-in does not name is unavailable, so a purpose added by a later build is
never covered by an opt-in given before it existed. The dialog at the moment
of choice, and one line under a saved cloud model, read out
`decisionCloudDisclosure()`: the model, and each purpose's `sends` clause.
Main stamps `acceptedAt` with its own clock on every cloud write.

## The host decision service

One port, `DecisionPort.decide(call)` (`@volli/shared`'s `decision-model.ts`),
implemented by `createDecisionService` in `@volli/agent-runtime` and composed
over the profile's settings and Pi's model collection in
`apps/desktop/src/main/decision/desktop.ts`.

```ts
const value = await decisions.port.decide({
  purpose: "agent.classify",       // closed enum: every caller is named
  sessionId,                       // bills the usage; selects the project's setting
  state, questions,                // checked against DECISION_LIMITS
  use: (answered) => ...,          // the decision
  fallback: (miss) => ...,         // REQUIRED: deterministic, never waits
  signal,
});
```

**The fallback is the contract.** A call cannot be written without one, and
the port answers with it for every way a decision does not happen: `unset`,
`not-opted-in`, `needs-setup`, `unaudited`, `invalid-request`, `timeout`,
`aborted`, `provider-error`, `malformed-answer`. `decide` never rejects for a
decision that was not made. A `use` that throws (an answer the caller cannot
act on) also falls back.

**Bounds** (`DECISION_LIMITS`, checked before anything is sent): state ≤ 32 KiB
of JSON and ≤ 32 levels deep, 1–16 questions with identifier names
(`__proto__`, `constructor` and `prototype` refused), choices of 2–32 options,
scores of 2–10 levels, instructions ≤ 2,000 and criteria ≤ 500 characters.
**Concurrency:** 4 calls in flight per purpose, so a purpose with a deadline
of seconds never queues behind another's slow calls; the rest queue in
arrival order. **Timeout:** per purpose (`agent.classify`: 30 s), covering
reading the setting, queueing and asking — a caller is promised an answer or
its fallback within its purpose's time, even from a model that ignores its
abort signal. Nothing local waits on the model catalog; a cloud call waits for
its restore, and uses Pi's built-in catalog if the restore failed.

**Answers** are held to the questions asked, all or nothing, and normalised so
every answer can be thresholded the same way: `confidence` everywhere
(TypeSafe's `(n·peak − 1)/(n − 1)`), `value` on a bool, `level` and `label` on
a score.

**Usage** is billed into the Session as a `usage.recorded` event with cause
`decision` and `{ purpose }` in the provenance, so `volli cost` and every usage
surface count it, and `volli cost --group-by cause` shows it on its own line.
An answer that lands after its caller gave up is still billed — the provider
charged for it. Cloud usage is Pi's catalog estimate; a local call is one
request that cost $0 with unknown tokens. A call with no Session is not
metered by the service — its caller attributes it once there is a Session.
With one purpose, cause `decision` is that purpose; when a second ships,
`purpose` should join the usage index (`session_usage`) so `volli cost` can
group by it — today it is in each fact's provenance only.

**Audit.** A purpose marked `audit: true` must leave a durable, attributed
fact per decision, through `recordDecision`: the answer the caller acted on,
or the miss it fell back on (an answer whose `use` threw is recorded as that
miss). Misses before any model was chosen — unset, not opted in — have no
target and leave no fact; VC-28 may record those itself. With no recorder
wired, an audited purpose is refused as `unaudited`. `agent.classify` is not
audited: routine agent calls get usage records, not per-call ledger facts.

### Adding a purpose (VC-28, VC-432)

1. Add the name to `DECISION_PURPOSES` and its row to
   `DECISION_PURPOSE_POLICY`: a label, what it `sends` (read out in the
   opt-in), a `timeoutMs`, and `audit`.
   - `authority.judge` (VC-28): audited, a timeout of a few seconds, and a
     fallback of "ask the person" — never allow.
   - `model.select` (VC-432): not audited, a short timeout, and a fallback of
     the configured default.
2. For an audited purpose, wire `recordDecision` in `desktop.ts` to a durable
   Session fact.
3. Call `port.decide({ purpose, … })` with a fallback. Existing cloud opt-ins
   do not cover the new purpose; Settings asks again.

## The `classify` tool

A capability tool (`NON_CODING_TOOL_IDS`, appended after `browser_find`), bound
to a per-Session `RuntimeClassifyPort`. Its presence is decided **once, at
Session birth**: `resolveClassify(projectId)` answers `offersClassifyTool` for
the project's setting (configured, and for cloud opted into for
`agent.classify`), and the answer is frozen into the Session's `tool-surface`
record. Sign-in is deliberately not part of the rule: a Session born while a
cloud provider still needs its key keeps the tool, its calls answer "needs
setup" until a person signs in, and then they work.
A setting changed later reaches only new Sessions; a Session frozen without
the tool replays without it, and one frozen with it but launched without a
decision service refuses to attach rather than shrinking its surface. Turning
the model off does take effect at once for calls: the tool stays, and each
call answers that no model is configured.

- **Input:** `state` (a JSON object) and `questions` (name → question). Nothing
  else; the host rebuilds both from their own fields.
- **Output:** Pi 0.99's native `structuredContent` (`{ answers, model,
  elapsedMs }`) with a declared `outputSchema`, plus one text line per answer.
  A miss is an `isError` result whose structured content is `{ miss }` and
  whose text tells the model to decide for itself.
- **Batches:** outside Code Mode, several `classify` calls in one reply run one
  after another — Pi's parallel dispatch is opt-in per Session and today only
  for marked MCP reads (VC-454). Bulk decisions belong in a Code Mode loop.
- **Code Mode (VC-471):** the tool is on the default `both` route, so a script
  can loop over items. VC-471's result shaping currently hands scripts a
  capability tool's *text*; it should hand them `structuredContent` for a tool
  that declares an `outputSchema`, as it already does for MCP tools.

## Ollama

Investigated as a local backend. Ollama 0.12.11+ (this machine has 0.32.1)
returns `logprobs` with up to 20 `top_logprobs` on `/api/chat`, which is the
raw material a classifier needs. pi's `llama-cpp-classify` cannot drive it as
is: it needs llama-server's `/tokenize` (to find each label's token id),
`/apply-template` (the model's own chat template) and `/completion` with
`n_probs` up to 32,768. An Ollama adapter is feasible on pi's exported pieces
(`renderQuestion`, `labelProbabilities`, `answerFromProbabilities`): render the
question, call `/api/chat` with `think: false`, `num_predict: 1`,
`top_logprobs: 20`, and match labels by token text. Its limits: labels outside
the top 20 must be bounded rather than read (fine for yes/no and small
choices, lossy for wide ones), and token text matching is less exact than ids.
Not shipped here: it could not be validated without downloading a model,
which was not approved for this ticket. llama-server can load the GGUF an
Ollama install already downloaded, so one model download serves both.

## Benchmark

`packages/agent-runtime/bench/decision/`: the same decisions made by a chat
model per decision, by a chat model over the whole list (triage), and by the
decision service per decision (what a Code Mode loop does), on three tasks —
browser page-state checks, labelling 200 support messages, and an arithmetic
control a classifier is the wrong tool for. `decision.bench.test.ts` proves
the harness against the network-free fixture; `decision.live.test.ts` is the
real run (`PI_LIVE_BENCH=1`). Results are in the PR and under
`bench/decision/results/`.
