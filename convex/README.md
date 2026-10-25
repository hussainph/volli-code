# `@volli/convex`

The Volli Cloud backend: the Convex schema and server functions, plus a pinned
local backend that tests and codegen run against. The schema holds the whole
cloud data model (validators and indexes); product functions arrive area by
area, each in its own module. No cloud deployment exists yet.

Rules that apply here (see `AGENTS.md`, **Volli Cloud**):

- The agent loop never runs in a Convex function or action.
- Ids, the event format and the object-storage key layout stay independent of
  Convex `_id`s.
- Every public function requires an identity. A local backend reflects any
  CORS origin, so an unauthenticated public function can be called by any page
  that can reach it. The `/runner/*` HTTP routes are the deliberate exception:
  a box calls them before it has an identity, and each proves itself with a
  one-time secret (install token, poll secret, refresh credential), takes JSON
  only, and sends no CORS headers.
- No Electron imports. `scripts/check-host-electron-imports.mjs` enforces this.

## Layout

| Path                                               | What it holds                                                                                                                                                                                                                                      |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `functions/`                                       | The Convex functions directory (`convex.json` → `"functions"`). `schema.ts`, `auth.config.ts`, function modules.                                                                                                                                   |
| `functions/schema.ts`                              | Every table, its validators and indexes. Conventions and the recorded deviations: `SCHEMA-NOTES.md`.                                                                                                                                               |
| `functions/lib/validators.ts`                      | Validator building blocks (`uuid`, `nullable`, `literals`, the `actor` union), built from the shared vocabulary in `@volli/shared/cloud`.                                                                                                          |
| `functions/lib/auth.ts`                            | Identity and membership checks: `requireIdentity`, `ensureViewer`, `requireViewer`, `requireMember`, `requireManage`, `requireProject`, `requireSessionScope`, `requireSessionVisible`, `requireSessionActor`.                                     |
| `functions/accounts.ts`                            | `ensureViewer` (the first call after sign-in; creates the person's own Workspace through `lib/firstSignIn.ts`), `viewer`, and account deletion: `requestDeletion` / `cancelDeletion`.                                                              |
| `functions/workspaces.ts`                          | The switcher (`listMine`), `get`, `create`, `rename`, and the admin policy (`policy`, `setPolicy`: `shareAll`, `whoCanInvite`).                                                                                                                    |
| `functions/members.ts`                             | The roster, `setRole`, `suspend` / `unsuspend`, `remove`, `leave`. The rules are `decideMemberChange` in `@volli/shared/cloud`.                                                                                                                    |
| `functions/invites.ts`                             | Email and single-use link invites: `create`, `revoke`, `list`, `listMine`, `preview`, `accept` (by id) and `acceptLink` (by token).                                                                                                                |
| `functions/sessionVisibility.ts`                   | Who sees a Session: `get` (its visibility, reason and current audience under the `shareAll` policy) and `share`, the owner's one-way flip of a root Session to shared, which carries down to its private subagents.                                |
| `functions/lib/workspaces.ts`                      | Creating a Workspace (the personal one at sign-up too), joining, the seat count. `lib/audit.ts` writes the `auditLog` row each change leaves.                                                                                                      |
| `functions/projects.ts`                            | Projects in a Workspace: `create` (caller-minted id, fixed ticket prefix, its counter document), `rename`, `archive`, `unarchive`, `list`, `get`.                                                                                                  |
| `functions/board.ts`                               | The board: tickets (`createTicket`, `updateTicket`, `moveTickets`, `archiveTicket`, `unarchiveTicket`), comments, signals, label colours, and the roster/ticket/history reads.                                                                     |
| `functions/lib/board.ts`                           | What board writes share: the actor, the project counter (`BoardWrite`: ticket numbers and the board event `seq`), row ↔ rule-fact mapping, typed errors.                                                                                           |
| `functions/lib/boardReceipts.ts`                   | `withBoardReceipt`: every board mutation is idempotent by `commandId` for seven days; another intent under the same id is `command_conflict`.                                                                                                      |
| `functions/lib/boardEffects.ts`                    | A board write's machine side effects (Done/archive trim, interrupts, armed arrivals, worktree materialization) as `runnerJobs` rows for the runner that holds the work.                                                                            |
| `functions/activity.ts`                            | The activity feed: `project` and `workspace`, newest first, with our own page cursor (see **The activity feed**).                                                                                                                                  |
| `functions/lib/activity.ts`                        | The feed reader: the k-way merge, the cursor, visibility, folding and the tickets and people a page names.                                                                                                                                         |
| `functions/boardReceipts.ts`, `functions/crons.ts` | The scheduled sweeps (receipts hourly, packed transcript staging every 15 min, the runner offline sweep every minute, runner link/audit expiry hourly).                                                                                            |
| `functions/transcripts.ts`                         | Transcript bodies and Pi logs: `stageArtifacts`, `commitSegment`, `commitPiLogSegment`, `head` (where a runner resumes), the producer fence and `sweepPacked`.                                                                                     |
| `functions/files.ts`                               | `presignPut`: a SigV4 URL bound to one key, length and SHA-256 (signed by `presignS3Request` in `@volli/shared/cloud`).                                                                                                                            |
| `functions/lib/objectStore.ts`                     | The S3-compatible store the backend signs for (`VOLLI_S3_*` variables; unset refuses with `storage_unconfigured`).                                                                                                                                 |
| `functions/lib/visibility.ts`                      | The visibility writes and filters: `visibilityForNewSession` (every Session-creating write), `shareSession`, `visibleBoardEvents` (every read of board events that may name a Session). The decisions are the predicates in `@volli/shared/cloud`. |
| `functions/runners.ts`                             | Runners: linking (desktop, install token, device code), the rotated credential with reuse detection, heartbeat and capabilities, the offline sweep, the Settings list.                                                                             |
| `functions/runnerHttp.ts`, `functions/http.ts`     | `/runner/link`, `/runner/link/start`, `/runner/link/poll`, `/runner/token` (HTTP actions; secrets are minted here, mutations see hashes) and the deployment's HTTP router.                                                                         |
| `functions/lib/runnerAuth.ts`                      | `requireRunner`: the check every runner-called function starts with. A runner token is never a person.                                                                                                                                             |
| `functions/lib/runnerSecrets.ts`                   | Minting runner secrets and signing runner tokens (ES256), for actions only.                                                                                                                                                                        |
| `functions/runnerJobs.ts`                          | The runner inbox, as a runner calls it: `wake`, `claim`, `renew`, `complete`; lease expiry; the sweep (finished jobs, stale notices).                                                                                                              |
| `functions/lib/jobs.ts`                            | `enqueueJob` / `tryEnqueueJob` (routing rules), `patchQueuedJob`, `recordSettledCommand`, `cancelJob`; the lease rules.                                                                                                                            |
| `functions/testJobs.ts`                            | Test-only runner-inbox hooks for `test:backend` (enqueue, inspect, age a lease), guarded the same way.                                                                                                                                             |
| `functions/_generated/`                            | Output of `convex codegen`, **committed**. CI regenerates it and fails on any drift. Never edit or format it by hand.                                                                                                                              |
| `fixture/backend.json`                             | The pin: one backend release, the `convex` npm version that goes with it, and a sha256 for each platform's zip.                                                                                                                                    |
| `fixture/backend.ts`                               | Downloads and verifies the binary, then starts a backend: free loopback ports, a fresh data dir, a random instance secret, beacon off. `stop()` kills it and deletes the dir.                                                                      |
| `fixture/jwt.ts`                                   | The test issuer: a fresh ES256 key per run, and `mintTestToken(pem, subject)`.                                                                                                                                                                     |
| `fixture/with-backend.ts`                          | Runs one command against a throwaway backend, then stops it.                                                                                                                                                                                       |
| `fixture/global-setup.ts`, `fixture/testing.ts`    | Vitest wiring for `test:backend`: `connectBackend().client("user:alice")`.                                                                                                                                                                         |
| `test/*.test.ts`                                   | Unit tests: functions run in-process under [`convex-test`](https://docs.convex.dev/testing/convex-test). No backend.                                                                                                                               |
| `test/*.backend.test.ts`                           | Integration tests against the real pinned backend.                                                                                                                                                                                                 |

## The migration import

`functions/migration.ts` is the SQLite → Volli Cloud import: internal
functions the dry run (`packages/host-core/src/migration-dry-run`) calls with
the admin key, never a client. `begin` checks the import target (and creates
one only on a test deployment); `importRows` writes a batch of one stream,
idempotent by each table's key, reporting conflicts and rows already migrated
into another Workspace and never overwriting them; `readPage` and
`readSessionEvents` read back for the verifier. Each record is mapped by
`migrationDocument` from `@volli/shared/cloud`.

## Running it locally

```sh
pnpm -C convex backend:fetch     # once per pin: download, verify sha256, cache the binary
pnpm -C convex test              # unit tests (convex-test), no backend
pnpm -C convex test:backend      # one real backend for the run, functions pushed, stopped after
pnpm -C convex codegen           # regenerate functions/_generated (needs a live backend, so it uses the fixture)
pnpm -C convex typecheck
```

Pass any command through the fixture:

```sh
# `convex …` is the pinned CLI, aimed at the throwaway backend; --deploy pushes functions/ first
pnpm -C convex with-backend --deploy -- convex run health:whoami '{}' --identity '{"subject":"user:alice"}'
pnpm -C convex with-backend --deploy -- node my-probe.mjs
```

Any command gets `CONVEX_SELF_HOSTED_URL` and `CONVEX_SELF_HOSTED_ADMIN_KEY`
(what the CLI reads). A non-`convex` command also gets `VOLLI_CONVEX_URL` and
`VOLLI_CONVEX_SITE_URL`, and with `--deploy` it gets
`VOLLI_CONVEX_TEST_PRIVATE_KEY`, which `connectBackend()` reads.

The fixture cannot reach a cloud deployment, even with a deploy key in
`convex/.env.local`:

- `CONVEX_DEPLOYMENT`, `CONVEX_DEPLOY_KEY` and `CONVEX_DEPLOYMENT_TOKEN` are
  set to empty. The CLI reads env files from its working directory and never
  overwrites a variable that is already present, so leaving them unset would
  let a file fill them back in.
- The control plane is pointed at a dead loopback port.
- `deploy`, `codegen`, `run`, `env`, `data`, `import` and `export` also get
  explicit `--url` and `--admin-key`.

A unit test runs the real CLI against a stand-in control plane to prove this.

The binary is about 174 MB unpacked. It is cached outside the repository, in
`$VOLLI_CONVEX_BACKEND_CACHE`, or else `${XDG_CACHE_HOME:-~/.cache}/volli/convex-local-backend/<release>/<platform>/`.
Each run starts one backend and stops it when the run ends. Set
`VOLLI_CONVEX_KEEP_DATA=1` to keep the data dir (its `backend.log` included)
for debugging.

### Acting as a user in tests

`auth.config.ts` trusts a `customJwt` provider only when the deployment
variable `VOLLI_TEST_JWKS` is set. The fixture sets it on its own backend, to
the public half of a key it generated for that run. It sets it before the
push, because the auth config is evaluated at push time. A test then signs in
as anyone:

```ts
const backend = connectBackend();
await backend.client("user:alice").query(api.health.whoami, {});
// With the profile claims a real provider sends:
backend.client("user:alice", { claims: { email: "alice@example.com", name: "Alice" } });
```

The backend is shared by every file in a run, so each test signs in as fresh
subjects rather than expecting an empty database.

## The board

A board write is `load → decide → apply`. The decision is a pure function in
`@volli/shared/cloud` (`board-rules.ts`, `project-rules.ts`) that a client can
also run for an optimistic update; the mutation loads its facts, applies the
answer, appends the board events (one per fact, `seq` from the project's
counter, so a project's history is a gapless total order), records the
receipt and enqueues runner jobs, all in one transaction. A move names
neighbours (`afterTicketId` / `beforeTicketId`) and the key is computed
inside the transaction from the column itself, so concurrent moves into the
same gap conflict and retry instead of colliding (`board.backend.test.ts`).
The local SQLite board (signed-out mode) keeps its own commands; it was not
rewritten onto these decisions, because its dense integer positions differ.

**Public function arguments are a cross-version contract.** A shipped
desktop calls these functions directly from its window (VC-889), through the
generated references this package exports as `@volli/convex/api` (the only
import a client takes from here). Change a public function's arguments
additively only: a new optional argument, never a removed or retyped one.

**No cloud deployment may ever set `VOLLI_TEST_JWKS`.** Without it, the
deployment trusts no test issuer.

### Sign-in provider

The sign-in provider is WorkOS AuthKit; desktop main runs the browser flow
(PKCE, public client) and sends the access token here. `auth.config.ts`
trusts WorkOS's two issuers when the deployment variable `WORKOS_CLIENT_ID`
names a WorkOS environment, and nothing else otherwise.

`profileFromIdentity` (`lib/auth.ts`) reads the new user's profile from the
token's `email`, `email_verified` and `name` claims. WorkOS access tokens do
not carry them by default: each WorkOS environment needs a JWT template that
adds them, for example
`{"email": {{user.email}}, "email_verified": {{user.email_verified}}, "name": "{{user.first_name}} {{user.last_name}}"}`.

Without a WorkOS environment, an unpackaged desktop signs in against its local
dev issuer, which signs tokens as the test issuer above with the fixture's
key:

```sh
VOLLI_ACCOUNT_PROVIDER=dev pnpm -C convex with-backend --deploy -- pnpm -C .. dev
```

The dev server lets the window connect to the loopback backend; a built app
needs `VOLLI_CLOUD_LOOPBACK=1` at build time for the same (VC-889).
`with-backend` hands the app `VOLLI_CONVEX_URL` and
`VOLLI_CONVEX_TEST_PRIVATE_KEY`; Settings → Account (with `cloud` on) then
signs in through the browser and `accounts.ensureViewer` runs on the
throwaway backend.

### Runner tokens

Runners do not sign in as people. A linked runner exchanges its refresh
credential at `POST /runner/token` for a 15-minute ES256 JWT that this
deployment signs itself (issuer `https://runners.volli.app`, audience
`volli-runner`, subject `runner:<uuid>`), and `auth.config.ts` trusts it as
a second `customJwt` provider. Every deployment that serves runners sets two
variables:

- `VOLLI_RUNNER_SIGNING_KEY`: the private P-256 key as a JWK, with its `kid`;
- `VOLLI_RUNNER_JWKS`: the public JWKS as a `data:` URI. Set it before the
  push; the auth config is evaluated then.

To rotate, add the next public key to `VOLLI_RUNNER_JWKS`, push, then switch
`VOLLI_RUNNER_SIGNING_KEY`. Without a signing key, `/runner/token` answers
`issuer_unconfigured` and spends no credential. The fixture gives each run
a fresh pair; `connectBackend().siteUrl` is where `/runner/*` lives.

### Bumping the pin

Bump the backend release and the `convex` npm version together. Releases are
the dated `precompiled-*` tags at
<https://github.com/convex/convex-backend/releases>. Each asset's `digest` in
the GitHub releases API is the sha256 that goes in `backend.json`. Then
update `package.json`'s `convex` to the same version as `convexNpm`, run
`pnpm install`, `pnpm -C convex codegen`, and commit the regenerated
`_generated/`. A unit test fails when the npm pin and the installed version
disagree.

## The activity feed

The feed has no store of its own: it is the board events of a project (its
`by_project_seq` range) or of a Workspace (a k-way merge of its live
projects' ranges by `occurredAt`), newest first. Each page leaves out what
the viewer may not see (a deleted ticket's events, and those naming a
Session they cannot see) and folds one actor's consecutive work on one
ticket into one item (`ActivityFold` in `@volli/shared/cloud`). Pages follow
Convex's pagination contract with a cursor of our own (per-project `seq`
bounds), so `usePaginatedQuery` does not drive them: a client pins each
loaded page to its `continueCursor` (`endCursor`) once it asks for the next
one. A page ends only where a folded run ends, so concatenated pages are the
fold of the whole history.

## CI

`Convex (codegen + backend)` in `.github/workflows/ci.yml` runs on Linux,
beside the desktop lanes and never inside them. It restores the binary cache
(keyed on `backend.json`), regenerates the code and requires that nothing
changed, and runs both test suites. `CI gate` requires it. `Check + Build`
typechecks this package along with the rest of the workspace.

## Deployments (not yet)

There are no cloud deployments yet. Dev, staging and prod deployments, deploy
CI, the object-storage bucket (R2), backups and export are added once the
Convex and Cloudflare accounts exist. Deploy CI will push this package with
`npx convex deploy` and a per-environment deploy key. It will refuse any
target that has `VOLLI_TEST_JWKS` set. Signing uploads already works against
any S3-compatible store: a deployment points at its bucket with the
`VOLLI_S3_*` variables (`functions/lib/objectStore.ts`).
