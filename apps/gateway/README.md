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
3. Only the route family's model endpoints are relayed (table below). Files,
   batches, stored completions and other account endpoints the key could reach
   are refused, because none of them is metered or the runner's to use. The
   Worker strips every place a grant can travel (`authorization`, `x-api-key`,
   `x-goog-api-key`), hop-by-hop and edge headers, `x-volli-*`, and
   `openai-organization` / `openai-project`, since the connection chooses
   which org a key bills, not the runner. It opens the sealed key and sends it
   in the provider's own header.
4. The response streams back unchanged. A copy of each chunk feeds the usage
   meter, which reads the provider's own usage report. When the runner
   disconnects, the upstream read is cancelled, so the provider stops
   generating.
5. One usage record per relayed call goes onto the `USAGE_QUEUE` queue. Its
   consumer posts batches to the backend's ingest endpoint, which is idempotent
   on the gateway-minted `recordId`. The runner's `callId` only joins the record
   with the Session's own usage fact, so reusing a call id cannot make usage
   disappear. Records hold metadata only: ids, model, token counts, status and
   timing. **No body or key is ever logged or stored**, and invocation logs are
   off because request headers carry grants.

The wire vocabulary (grant claims, `volli_*` error codes with their recovery
classes, the usage record) lives in `@volli/shared/cloud` (`gateway.ts`), so the
backend, the runner and this Worker read the same definitions.

## API families

| `route.api`          | Providers                                | Relayed endpoints                                                       | Key header              | Usage read from                                         |
| -------------------- | ---------------------------------------- | ----------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------- |
| `anthropic-messages` | Anthropic, Anthropic-compatible gateways | `POST /v1/messages`, `POST /v1/messages/count_tokens`, `GET /v1/models` | `x-api-key`             | `message_start` + `message_delta` (or the JSON `usage`) |
| `openai-responses`   | OpenAI Responses                         | `POST /responses`, `GET /models`                                        | `authorization: Bearer` | `response.completed` / `incomplete` / `failed`          |
| `openai-completions` | OpenAI-compatible endpoints, OpenRouter  | `POST /chat/completions`, `GET /models`                                 | `authorization: Bearer` | the final usage chunk (OpenRouter's `cost` included)    |

Endpoint paths are relative to the route's upstream base (`https://api.anthropic.com`,
`https://api.openai.com/v1`, `https://openrouter.ai/api/v1`).

The gateway makes one change to a request body. A Chat Completions stream that
does not ask for usage gets `stream_options.include_usage: true`. Chat bodies
are parsed whatever their declared content type, so mislabelling one does not
skip the edit.

## Errors

The gateway's own refusals all happen **before** anything is forwarded, so the
provider never saw the call and nothing was billed. Each one carries
`x-volli-error: <code>`, `x-should-retry` (true only for the `transient`
class, so the SDK leaves grant refreshes to the runner and the rest to a
person) and a body that fits both SDK families' error envelopes:
`{"type":"error","error":{"type":code,"code":code,"message":…}}`. The codes,
their statuses and their recovery classes (`transient`, `refresh-grant`,
`auth`, `config`, `quota`) are `GATEWAY_ERRORS` in `@volli/shared/cloud`. The
gateway never falls back to another connection, because another connection is
another payer.

Provider answers pass through unchanged (429, 5xx, 400 and 403 included), with
two exceptions that translate what the provider said. An upstream 401 becomes
`volli_upstream_auth`, because the connection's key was rejected. A redirect
becomes `volli_upstream_redirect`, because the gateway never follows one.

## Configuration

| Name                     | Kind   | Purpose                                                                                                                                                                                                |
| ------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GATEWAY_ISSUER`         | var    | The issuer's `iss` (the backend's site URL).                                                                                                                                                           |
| `GATEWAY_JWKS_URL`       | var    | The issuer's JWKS URL. Cached for 10 minutes and refreshed in the background; refetched on an unknown `kid` at most every 30 s.                                                                        |
| `GATEWAY_JWKS`           | var    | Inline JWKS JSON for local development. Setting it beside the URL is a misconfiguration that refuses every call.                                                                                       |
| `GATEWAY_SEALING_KEYS`   | secret | JSON of `kid` → X25519 private JWK: the current key, plus the previous one during a rotation.                                                                                                          |
| `GATEWAY_MAX_BODY_BYTES` | var    | Largest request body relayed. Default 32 MiB.                                                                                                                                                          |
| `USAGE_INGEST_URL`       | var    | The backend's usage ingest endpoint. When it is unset, the consumer is a local stub that logs counts and acks.                                                                                         |
| `USAGE_INGEST_TOKEN`     | secret | Bearer token for the ingest endpoint. Required with the URL: usage is never posted unauthenticated.                                                                                                    |
| `USAGE_QUEUE`            | queue  | Producer for usage records. The same Worker consumes it (`max_retries` 10, then a dead-letter queue).                                                                                                  |
| `REVOCATIONS`            | KV     | Kill switch. `grant:<jti>` or `conn:<id>` revokes (`volli_grant_revoked`). `conn:<id>:kv:<n>` retires a rotated key version (`volli_grant_stale`, so the runner fetches a grant with the current one). |

### Sealed keys

`sk` is `v1.<kid>.<enc>.<ciphertext>`. It is HPKE (RFC 9180) base mode with
DHKEM(X25519, HKDF-SHA256), HKDF-SHA256 and AES-256-GCM, sealed to the gateway's
public key `kid`. The AAD is `conn:<connectionId>\nkv:<keyVersion>`. A key moved
to another connection, or an old version replayed as a new one, does not open
(`volli_connection_key_unreadable`: the key must be entered again).
`src/hpke.ts` is pinned by the RFC's own test vector. The client a person pastes
a key into does the sealing, so the backend stores only ciphertext. The runner
carries the ciphertext inside the grant and cannot open it.

## Running it locally

No Cloudflare account and no login are needed.

```sh
pnpm --filter @volli/gateway dev                 # wrangler dev --local on :8787

VOLLI_DEV_PROVIDER_KEY=sk-ant-… pnpm --filter @volli/gateway dev:grant \
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
  in workerd through Miniflare. It uses the real queue and KV bindings and
  covers one call per API family through the queue to a fixture ingest endpoint.
  One provider holds its stream until the runner reads the first event, proving
  nothing is buffered. It also covers the endpoint allowlist, typed refusals and
  KV kill switch. Miniflare's entry proxy does not pass
  a client disconnect on to the Worker, so cancellation is covered by the unit
  tests. Confirm it on a real deployment as well.

CI runs both in `Test (packages)` (Linux), and typechecks the package in
`Check + Build`.

## Product integration boundary

The Worker runs independently; it is not yet wired end to end into desktop
Sessions. The backend already declares `modelConnections` in its schema and
has the runner-token issuer. Neither is evidence that gateway grant issuance,
usage ingestion or runner routing is connected. The following are integration
contracts, not a release plan or a claim of shipped product behavior.

- **Connections and grants.** Connection resolution respects
  `personal > project > Workspace` precedence and admin policy. Saving an upstream
  applies the same HTTPS/public-host admission as `parseUpstreamBase`. Clients
  receive sanitized connection metadata, never key material. A gateway grant
  requires a runner token, runner ownership, membership and an enabled connection;
  it must match `parseGatewayGrantClaims`, including its ten-minute lifetime and
  issuer/JWKS.
- **Key sealing and revocation.** Client sealing uses `src/sealed-key.ts` and
  `src/hpke.ts` (WebCrypto). The runner carries ciphertext, not the provider key.
  Member removal, connection disablement or compromise revokes the appropriate
  `grant:` / `conn:` entries in KV; rotation retires `conn:<id>:kv:<n>`.
- **Usage ingest.** `USAGE_INGEST_URL` accepts authenticated batches of
  `GatewayUsageRecord`, idempotent on `recordId`. Validation uses
  `GATEWAY_APIS` and `GATEWAY_USAGE_STATUSES`; rejecting an individual record
  must not prevent acceptance of valid records when the consumer retries a batch.
  Catalog pricing and rollups belong to the backend, not the Worker.
- **Runner routing.** A per-Session route points Pi at
  `<gateway>/v1/c/<connectionId>`, supplies the grant as `options.apiKey` and
  joins `x-volli-call-id` to the Session's `usage.recorded` fact. The same
  routing boundary covers compaction, titling, decisions and usage probes; the
  picker combines local availability with sanitized connection metadata.
  Grants refresh before expiry (about two-thirds of their lifetime). A
  `refresh-grant` refusal permits one refresh and retry; other recoveries follow
  `GATEWAY_ERRORS`. No silent fallback to another connection is allowed.
- **Deployment.** The queue, dead-letter queue, KV binding, sealing keyring,
  issuer/JWKS, authenticated ingest and public route are required configuration.
  Without an ingest URL the consumer is a local stub, not durable usage storage.
  Real-deployment disconnect cancellation needs separate verification; Miniflare
  does not prove it.
