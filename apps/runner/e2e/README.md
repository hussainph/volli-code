# BYO runner acceptance

The end-to-end lane for a person's own Linux box (VC-1043): install, a Session,
a push, an update and a rollback, against the pinned local backend. It runs in
`ci-extended.yml` as **BYO runner acceptance** (Linux, no macOS slot) on every
main push, nightly, on dispatch, and on a PR that changes `ci-extended.yml`.

```sh
# CI runs exactly this, from convex/ (needs Docker and a Linux host network):
node fixture/with-backend.ts --deploy -- node ../apps/runner/e2e/acceptance.mjs

# Local debugging without Docker: box commands run in a plain shell on this
# machine, labelled HOST SHELL in every output. Never what CI runs.
node fixture/with-backend.ts --deploy -- node ../apps/runner/e2e/acceptance.mjs --host-shell
```

## Legs

| Leg        | Claim                                                                                                                                                                                                                                                                                                                                                                                                                                         | Needs merged       |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `harness`  | A seeded person with a project; the deployment's GitHub App on the fake GitHub, the person's GitHub connected and the App installed through the backend's own routes; a fresh Ubuntu 24.04 box under systemd trusts the run's CA, reaches the backend and the release, and its git clones and pushes over HTTPS with a token while none is refused; the box redeems an install token over `POST /runner/link` and Settings → Runners lists it | —                  |
| `install`  | `curl … \| sh -s -- --token … --name hetzner-1 --server … --site …` as root → the last line is "hetzner-1 is online."; the runner is online at the published version, `linux`, `system`, power `{ac, alwaysOn}`; the unit is active as `volli`                                                                                                                                                                                                | BYO-1, 2, 7, 9, 10 |
| `update`   | v+1 published and set in `releaseChannels` (`runnerReleases.pin`) → online at v+1, `current` is v+1                                                                                                                                                                                                                                                                                                                                           | BYO-5, 12          |
| `rollback` | a broken v+2 → `update_failed` for v+2, online again at v+1, `current` back on v+1                                                                                                                                                                                                                                                                                                                                                            | BYO-5, 12          |
| `session`  | the picker's read names the box as the default and serving the model; `sessionStarts.startOn` as the person → the agent's `bash` call commits and `git push`es with the runner's credential and identity → the fake GitHub has the commit, pushed with the owner's user token; the reply is in the Session's history                                                                                                                          | BYO-3, 8           |

The Session leg runs last, so a start that cannot run (and stays queued for
a retry) never stands between the box and the idle moment an update waits for.

Each leg reports one of `PASS`, `FAIL`, `PENDING` (work it needs has not
merged; the summary names the files and tickets) or `BLOCKED` (a leg it
builds on did not pass). A failure is always red. `--require-all` also makes
`PENDING` and `BLOCKED` red, for the lane once every leg's work is on main.
A start that failed for good ends the Session leg with the start's own reason.

The harness's own unit tests are `node:test` files, run by the job's
"Harness self-tests" step and by `ci.yml`'s Check + Build:
`node --test scripts/fake-github/*.test.mjs apps/runner/e2e/lib/*.test.mjs`.
`apps/runner`'s Vitest config includes only `src/**/*.test.ts`.

## Doubles and setup

None of these is the behaviour under test:

- **The person**: a test-issuer token (`convex/fixture/jwt.ts`), preview access
  granted with the fixture's admin key, the agreement accepted the way sign-in
  accepts it, a project through `projects.create` (`lib/backend.mjs`).
- **The person's Mac** (Session leg): a second runner, linked with an install
  token, that reports the folder project's checkout and its `origin` through
  `projectCheckouts.report`, as a Mac does when it first opens the folder.
  That is how a folder project gets the remote a box clones.
- **The fake GitHub** (`scripts/fake-github/server.mjs`): one origin laid out
  like GitHub Enterprise Server (`GITHUB_WEB_URL` = the origin,
  `GITHUB_API_URL` = `<origin>/api/v3`), named `github.byo.test` (a runner
  refuses a loopback literal as a remote; the job maps the name to the
  loopback in `/etc/hosts`, and so does the box). The backend reaches it over
  HTTP; the same port answers HTTPS (`tls.mjs`: a CA made fresh each run,
  trusted only by the box) for git and release downloads. OAuth with PKCE and
  rotating refresh tokens, the REST endpoints the backend calls with App JWTs
  verified against the key it hands the deployment, and git smart HTTP
  (`git http-backend`) that needs `x-access-token:<token>` with a token whose
  user or installation reaches the repository.
- **The release** (`lib/release-server.mjs`): GitHub's download layout
  (`/<owner>/<repo>/releases/download/<tag>/<asset>`, `releases/latest`) and the
  public Releases API shape, mounted on the fake GitHub's origin as on
  github.com. The first release is the CI-built artifact pair
  (`byo-runner-artifact`, `$VOLLI_BYO_RUNNER_ASSETS`; no deployment baked in,
  so it links only where `--server` points it), with the manifest, stamped
  installer and checksums written by BYO-7's own release script.
- **v+1 and v+2** (`lib/restamp.mjs`): that same build **re-stamped** as
  `x.y.(z+1)-e2e.N`. Only what names the version changes (archive root and
  name, `MANIFEST.json`, the version baked into the runner bundle); v+2 also
  refuses `run`, so it stages but never comes online. The update path is under
  test, not the build.
- **Update settings** (update and rollback legs): the install's `update.json`
  says `provenance: "sha-only"` (nothing here can be Sigstore-signed; only the
  install root's owner can choose it), and a drop-in gives the runner and its
  update unit `NODE_EXTRA_CA_CERTS` for the run's CA.
- **The model** (Session leg): the fake provider
  (`apps/desktop/e2e/volli-drive/lib/fake-provider.mjs`, Azure's Responses API
  on loopback), its key stored with the real `volli-runner login --api-key`, its
  base URL given to the unit in a drop-in. Its script makes one `bash` call that
  names no token or author, then answers in text.
- **The box** (`box/Dockerfile`, `lib/box.mjs`): stock `ubuntu:24.04` (pinned by
  digest) with systemd as PID 1 and only what a rented VPS ships with (curl, CA
  roots, git). No Node, no Volli. Privileged, its own cgroup namespace, on the
  host network so it reaches the loopback servers at the driver's URLs.
- **The browser**: the driver follows the fake GitHub's redirect and posts the
  backend's confirm form, as a person's browser would.

## Evidence

`$VOLLI_BYO_EVIDENCE` (CI: the `byo-runner-acceptance-attempt-N` artifact)
holds `evidence.json` (each leg, every box command's exit and output tail,
the fake GitHub's, the release's and the fake model's request logs, the box
journal on failure)
and `summary.md`, which is also the job summary. Tokens, credentials, keys and
JWT-shaped strings are redacted; the request logs never record a credential,
only its kind.
