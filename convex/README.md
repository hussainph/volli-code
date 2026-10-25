# `@volli/convex`

The Volli Cloud backend: the Convex schema and server functions, plus a pinned
local backend that tests and codegen run against. This is the skeleton. The
schema is a placeholder until the data model lands, and no cloud deployment
exists yet.

Rules that apply here (see `AGENTS.md`, **Volli Cloud**):

- The agent loop never runs in a Convex function or action.
- Ids, the event format and the object-storage key layout stay independent of
  Convex `_id`s.
- Every public function requires an identity. A local backend reflects any
  CORS origin, so an unauthenticated public function can be called by any page
  that can reach it.
- No Electron imports. `scripts/check-host-electron-imports.mjs` enforces this.

## Layout

| Path                                            | What it holds                                                                                                                                                                 |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `functions/`                                    | The Convex functions directory (`convex.json` → `"functions"`). `schema.ts`, `auth.config.ts`, function modules.                                                              |
| `functions/_generated/`                         | Output of `convex codegen`, **committed**. CI regenerates it and fails on any drift. Never edit or format it by hand.                                                         |
| `fixture/backend.json`                          | The pin: one backend release, the `convex` npm version that goes with it, and a sha256 for each platform's zip.                                                               |
| `fixture/backend.ts`                            | Downloads and verifies the binary, then starts a backend: free loopback ports, a fresh data dir, a random instance secret, beacon off. `stop()` kills it and deletes the dir. |
| `fixture/jwt.ts`                                | The test issuer: a fresh ES256 key per run, and `mintTestToken(pem, subject)`.                                                                                                |
| `fixture/with-backend.ts`                       | Runs one command against a throwaway backend, then stops it.                                                                                                                  |
| `fixture/global-setup.ts`, `fixture/testing.ts` | Vitest wiring for `test:backend`: `connectBackend().client("user:alice")`.                                                                                                    |
| `test/*.test.ts`                                | Unit tests: functions run in-process under [`convex-test`](https://docs.convex.dev/testing/convex-test). No backend.                                                          |
| `test/*.backend.test.ts`                        | Integration tests against the real pinned backend.                                                                                                                            |

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
```

**No cloud deployment may ever set `VOLLI_TEST_JWKS`.** Without it, the
deployment trusts no test issuer.

### Bumping the pin

Bump the backend release and the `convex` npm version together. Releases are
the dated `precompiled-*` tags at
<https://github.com/convex/convex-backend/releases>. Each asset's `digest` in
the GitHub releases API is the sha256 that goes in `backend.json`. Then
update `package.json`'s `convex` to the same version as `convexNpm`, run
`pnpm install`, `pnpm -C convex codegen`, and commit the regenerated
`_generated/`. A unit test fails when the npm pin and the installed version
disagree.

## CI

`Convex (codegen + backend)` in `.github/workflows/ci.yml` runs on Linux,
beside the desktop lanes and never inside them. It restores the binary cache
(keyed on `backend.json`), regenerates the code and requires that nothing
changed, and runs both test suites. `CI gate` requires it. `Check + Build`
typechecks this package along with the rest of the workspace.

## Deployments (not yet)

There are no cloud deployments yet. Dev, staging and prod deployments, deploy
CI, object storage (R2), backups and export are added once the Convex and
Cloudflare accounts exist. Deploy CI will push this package with
`npx convex deploy` and a per-environment deploy key. It will refuse any
target that has `VOLLI_TEST_JWKS` set.
