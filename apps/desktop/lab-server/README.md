# Live decision lab server

`vite.config.ts` installs this plugin only for `serve --mode lab`. Normal dev,
production builds, and Electron do not install it. Runtime loading uses Vite SSR
only after a validated request; importing the config does not restore Pi catalogs
or open a credential store. The real path is `piOwnedModelAccess` →
`piDecisionClassifier` → `createDecisionService`, with an ephemeral cloud setting
for `agent.classify`, not product settings or the Session ledger.

## Scratch

Run `pnpm lab`, then open `/lab/#billing-auto-select`. The two supplied ladders
and 14 eval prompts are included as fixtures. Billing defaults are simulated;
edit the candidate JSON to describe the scenario being tested. Each candidate
has `selection`, `tiers`, `billingSource` (`subscription`, `api-key`, `gateway`,
`local`), `fiveHour`, and `weekly`. A window is `{leftPercent, resetsAt}` with an
ISO reset timestamp; a null window/field means unknown, not unused allowance.
Pace comes from shared `paceOf` at the comparison press. The first candidate is
the fallback default. Candidates sharing an account should use the same windows.

Run comparison makes two explicit live calls. The baseline uses the unchanged
shared request/reader; only the other arm receives billing state and editable
instructions. An unsuccessful or low-confidence decision falls back. Costs are
qualified by their returned basis; unknown usage never reads as a free call.

Label a saved run with its right candidate, then Export JSON to keep the frozen
inputs, exact requests, answers and usage. The last 100 runs live only in this
browser's localStorage; this is not product storage. There is no automatic
prompt-set runner or real-usage probe.

## HTTP contract

Only an explicit action in the scratch should send:

```text
POST /__lab/auto-select
Origin: <exact lab server origin>
X-Volli-Lab: 1
Content-Type: application/json
```

Body: `{classifier?: {providerId: string, modelId: string}, request: DecisionRequest}`.
The default classifier is `typesafe/jev-latest`. No URLs, keys, credentials, or
other top-level fields are accepted. `DecisionRequest` has the shared decision
bounds; the HTTP body also has a 384 KiB limit and a 10-second read deadline.
There are at most four in-flight requests. Both the real TCP peer and the exact
Host/Origin must be loopback; forwarded headers are not trusted. CLI requests
must also supply the exact Origin and lab header.

HTTP 200: `{result: DecisionAnswered, usage: SessionUsage[], elapsedMs: number}`.
`result.elapsedMs` measures the decision service; top-level `elapsedMs` includes
catalog preparation. Usage is in memory only; it is not recorded to a ledger.
Timeout/withdrawn calls can still be billed after the response, so a returned
empty usage array does not establish that an abandoned call was free.

Failures: `{error: {code: string, message: string}}`; attempted decisions also
include `usage` and `elapsedMs`. Decision misses return 503 (timeout: 504),
invalid input returns 400, excessive size 413, wrong content type 415, concurrent
admission refusal 429, and origin/connection/header refusals 403. Missing models
and sign-ins name the chosen classifier. Provider response bodies, thrown errors,
and credentials are never forwarded.

Tests exercise real HTTP refusals, lazy SSR loading, the real classifier/service
with model access replaced, and a production build of the actual app/cursor
entrypoints. The build test checks both emitted bytes and bundled module ids for
lab/endpoint/runtime leaks:

```sh
pnpm -C apps/desktop exec vp test run lab-server/auto-select-plugin.test.ts lab-server/decision-runtime.test.ts --project main --maxWorkers="$VOLLI_CONCURRENCY_HINT"
pnpm -C apps/desktop exec tsc --noEmit -p lab-server/tsconfig.json
```
