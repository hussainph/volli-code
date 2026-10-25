# volli-gateway

The Volli model gateway: a Cloudflare Worker that relays model calls for
**backend-held API connections** and meters their usage per member. It is the
data plane. The backend (`convex/`) is the control plane: it owns connections,
sealed keys, policy, grants and the usage ledger. The Worker has no database of
its own. It knows only what a signed grant tells it.

What goes through it: API keys a person uploaded, project and workspace keys,
and OpenAI- or Anthropic-compatible gateways (OpenRouter, LiteLLM, a team's own
endpoint). **Subscriptions never go through it**, and neither do keys kept on a
person's own machine. Those stay in the runner's local credential store and call
the provider directly.

No `electron` import, ever: `scripts/check-host-electron-imports.mjs` gates this
directory.

## How a call flows

```
runner ── POST /v1/c/<connection>/v1/messages ──▶ gateway ── POST <route.up>/v1/messages ──▶ provider
          x-api-key: <grant>                                 x-api-key: <real key>
          x-volli-call-id: <uuid>
                                                   ◀── SSE, byte for byte, usage tapped ──
                                                   ── usage record ──▶ Queue ──▶ backend ingest
```

1. The runner points the provider SDK's base URL at
   `https://<gateway>/v1/c/<connectionId>` and passes the **grant** as the API
   key. The SDK appends its own path (`/v1/messages`, `/responses`,
   `/chat/completions`), which is relayed unchanged.
2. The grant is an ES256 JWT from the Volli issuer (`aud = volli-gateway`, 10
   minutes, one per Session). It names the routes the Session may use. Each route
   carries the provider key **sealed to the gateway** (`sk`). The Worker verifies
   the grant offline against the issuer's JWKS. The backend is not on the request
   path.
3. The Worker strips every place a grant can travel (`authorization`,
   `x-api-key`, `x-goog-api-key`), hop-by-hop and edge headers, and `x-volli-*`.
   It opens the sealed key and sends it in the provider's own header.
4. The response streams back unchanged. A copy of each chunk feeds the usage
   meter, which reads the provider's own usage report. When the runner
   disconnects, the upstream read is cancelled, so the provider stops
   generating.
5. One usage record per relayed call goes onto the `USAGE_QUEUE` queue. Its
   consumer posts batches to the backend's ingest endpoint, which is idempotent
   on `callId`. Records hold metadata only: ids, model, token counts, status and
   timing. **No body or key is ever logged or stored**, and invocation logs are
   off because request headers carry grants.

The wire vocabulary (grant claims, `volli_*` error codes with their recovery
classes, the usage record) lives in `@volli/shared/cloud` (`gateway.ts`), so the
backend, the runner and this Worker read the same definitions.

## API families

| `route.api`          | Providers                                | Key header              | Usage read from                                         |
| -------------------- | ---------------------------------------- | ----------------------- | ------------------------------------------------------- |
| `anthropic-messages` | Anthropic, Anthropic-compatible gateways | `x-api-key`             | `message_start` + `message_delta` (or the JSON `usage`) |
| `openai-responses`   | OpenAI Responses                         | `authorization: Bearer` | `response.completed` / `incomplete` / `failed`          |
| `openai-completions` | OpenAI-compatible endpoints, OpenRouter  | `authorization: Bearer` | the final usage chunk (OpenRouter's `cost` included)    |

The gateway makes one change to a request body. A Chat Completions stream that
does not ask for usage gets `stream_options.include_usage: true`.

## Errors

Every refusal happens **before** anything is forwarded, so the provider never
saw the call and nothing was billed. Each one carries `x-volli-error: <code>`
and a body that fits both SDK families' error envelopes:
`{"type":"error","error":{"type":code,"code":code,"message":…}}`. The codes,
their statuses and their recovery classes (`transient`, `refresh-grant`,
`auth`, `config`, `quota`) are `GATEWAY_ERRORS` in `@volli/shared/cloud`. The
gateway never falls back to another connection, because another connection is
another payer. Provider errors (429, 5xx, 400) pass through unchanged, except
for two cases. An upstream 401 or 403 becomes `volli_upstream_auth`, because the
connection's key was rejected. A redirect becomes `volli_upstream_redirect`,
because the gateway never follows one.

## Configuration

| Name                     | Kind   | Purpose                                                                                                        |
| ------------------------ | ------ | -------------------------------------------------------------------------------------------------------------- |
| `GATEWAY_ISSUER`         | var    | The issuer's `iss` (the backend's site URL).                                                                   |
| `GATEWAY_JWKS_URL`       | var    | The issuer's JWKS URL. Cached for 10 minutes, and refetched on an unknown `kid` at most every 30 s.            |
| `GATEWAY_JWKS`           | var    | Inline JWKS JSON for local development. Takes precedence over the URL.                                         |
| `GATEWAY_SEALING_KEYS`   | secret | JSON of `kid` → X25519 private JWK: the current key, plus the previous one during a rotation.                  |
| `GATEWAY_MAX_BODY_BYTES` | var    | Largest request body relayed. Default 32 MiB.                                                                  |
| `USAGE_INGEST_URL`       | var    | The backend's usage ingest endpoint. When it is unset, the consumer is a local stub that logs counts and acks. |
| `USAGE_INGEST_TOKEN`     | secret | Bearer token for the ingest endpoint.                                                                          |
| `USAGE_QUEUE`            | queue  | Producer for usage records. The same Worker consumes it (`max_retries` 10, then a dead-letter queue).          |
| `REVOCATIONS`            | KV     | Kill switch. If `grant:<jti>`, `conn:<id>` or `conn:<id>:kv:<n>` is present, the call is refused.              |

### Sealed keys

`sk` is `v1.<kid>.<enc>.<ciphertext>`. It is HPKE (RFC 9180) base mode with
DHKEM(X25519, HKDF-SHA256), HKDF-SHA256 and AES-256-GCM, sealed to the gateway's
public key `kid`. The AAD is `conn:<connectionId>\nkv:<keyVersion>`. A key moved
to another connection, or an old version replayed as a new one, does not open.
`src/hpke.ts` is pinned by the RFC's own test vector. The client a person pastes
a key into does the sealing, so the backend stores only ciphertext. The runner
carries the ciphertext inside the grant and cannot open it.

## Running it locally

No Cloudflare account and no login are needed.

```sh
pnpm --filter @volli/gateway dev                 # wrangler dev --local on :8787

VOLLI_DEV_PROVIDER_KEY=sk-ant-… pnpm --filter @volli/gateway dev:grant -- \
  --provider anthropic --api anthropic-messages --upstream https://api.anthropic.com
```

The first `dev:grant` writes `.dev.vars` (the local issuer JWKS and sealing
keyring) and `.dev-issuer.json` (the local issuer's private key). Both are
gitignored throwaway keys. Restart `wrangler dev` after that first run. The
command prints the grant, the base URL and an example `curl`. The usage
consumer is the stub, so each relayed call logs
`usage stub: 1 record(s) acknowledged`.

## Tests

`pnpm --filter @volli/gateway test` runs two layers:

- **Unit tests** (`src/*.test.ts`) run the Worker's modules under plain Node:
  grant verification, the sealed-key format and the HPKE vector, SSE parsing,
  each family's usage meter, the metered body (including cancellation), header
  and upstream rules, every `volli_*` code, and the consumer. Coverage is held at
  100%.
- **The contract test** (`test/worker.test.ts`) bundles the Worker with
  `wrangler deploy --dry-run`, exactly as it would deploy, and runs that bundle
  in workerd through Miniflare. It uses the real queue and KV bindings, with a
  fake provider and backend behind Miniflare's outbound service. It covers one
  call per API family end to end through the queue to the ingest endpoint, the
  typed refusals, and the KV kill switch. Miniflare's entry proxy does not pass
  a client disconnect on to the Worker, so cancellation is covered by the unit
  tests. Confirm it on a real deployment as well.

CI runs both in `Test (packages)` (Linux), and typechecks the package in
`Check + Build`.

## Part 2: what the backend and runner still owe it

The Worker is complete on its own side. These items wire it into the product:

- [ ] **Backend: connections.** A `modelConnections` table (scope
      personal/project/workspace, kind, label, upstream base URL, `api`, extra
      headers, sealed key + `kid`, key version, status). The https/public-host
      check runs when a connection is saved (mirror `parseUpstreamBase`). No
      query may ever return key material: clients see
      `{label, kind, last4?, createdBy, rotatedAt, status}`.
- [ ] **Backend: the issuer.** Add the Volli ES256 issuer and its JWKS route
      (shared with runner tokens), then point `GATEWAY_ISSUER` /
      `GATEWAY_JWKS_URL` at it.
- [ ] **Backend: `resolveRoutes(sessionId)`** (personal > project > workspace,
      admin policy over all) and **`POST /gateway/grant`** (runner token in;
      checks runner ownership, membership, connection status; mints claims as
      `parseGatewayGrantClaims` reads them, 10-minute lifetime).
- [ ] **Backend: usage ingest.** An HTTP action at `USAGE_INGEST_URL` that takes
      `{records: GatewayUsageRecord[]}`, checks `USAGE_INGEST_TOKEN`, writes
      idempotently on `callId` (validators built from `GATEWAY_APIS` and
      `GATEWAY_USAGE_STATUSES`), prices records from the model catalog
      (`costBasis: "gateway-metered"`) and rolls up `usageDaily`.
- [ ] **Backend: the kill switch.** Writes `grant:` / `conn:` entries to the
      `REVOCATIONS` KV namespace when a member is removed, a connection is
      disabled or a key leaks.
- [ ] **Client: sealing.** Seal pasted keys to the gateway's published public key
      with the `src/sealed-key.ts` format. Move `hpke.ts` + `sealed-key.ts` into
      a shared package when the client takes it up (they are WebCrypto-only).
- [ ] **Runner: the route table and `GrantSource`.** Cache the grant and refresh
      it at about ⅔ of its lifetime. On `refresh-grant` codes, refresh and retry
      the call once.
- [ ] **Runner: the Pi stream wrapper.** For relay routes, one per-Session
      wrapper sets `model.baseUrl` to `<gateway>/v1/c/<connectionId>`,
      `options.apiKey` to the current grant, and `x-volli-call-id` to the id
      already on the runner's `usage.recorded` fact. Non-Session model calls
      (compaction, titling, decision models, the usage-limit probe) take the same
      routes through one facade. The model picker lists Pi's local availability
      together with the connection projection.
- [ ] **Runner: error mapping.** Map `GATEWAY_ERRORS[code].recovery` onto the
      runtime's classes. Add an `isGatewayErrorCode` guard to
      `@volli/shared/cloud` when the runner first needs one.
- [ ] **Deploy.** Create the Cloudflare account, the queue, the dead-letter queue
      and the KV namespace (add its `id` to `wrangler.json`). Set the secrets and
      a route (`gateway.<domain>`). Measure relay latency and confirm
      disconnect cancellation there.
- [ ] **Later.** Google (`x-goog-api-key`, `usageMetadata`), Bedrock (SigV4
      re-signing or STS), per-member rate limits via the rate-limit binding,
      budgets (`402 volli_budget_exceeded`), DPoP-bound grants, and direct mode.
