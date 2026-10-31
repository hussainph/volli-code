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

| Leg        | Claim                                                                                                                                                                                                                                                                                                                                                                                                           | Needs merged       |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `harness`  | A seeded person with a project; the deployment's GitHub App on the fake GitHub, the person's GitHub connected and the App installed through the backend's own routes; a fresh Ubuntu 24.04 box under systemd reaches the backend, the local release and the fake GitHub (a token clones and pushes, none is refused); the box redeems an install token over `POST /runner/link` and Settings → Runners lists it | —                  |
| `install`  | `curl … \| sh -s -- --token … --server …` → "is online"                                                                                                                                                                                                                                                                                                                                                         | BYO-1, 2, 7, 9, 10 |
| `session`  | `sessionStarts.startOn` as the person → the agent commits and `git push`es → the fake GitHub has the commit                                                                                                                                                                                                                                                                                                     | BYO-3, 8           |
| `update`   | v+1 published and set in `releaseChannels` → online at v+1                                                                                                                                                                                                                                                                                                                                                      | BYO-5, 12          |
| `rollback` | a broken v+2 → rolled back to v+1, `update_failed` reported                                                                                                                                                                                                                                                                                                                                                     | BYO-5, 12          |

Each leg reports one of `PASS`, `FAIL`, `PENDING` (work it needs has not
merged, or the leg is not wired yet; the summary names the files and tickets)
or `BLOCKED` (a leg it builds on did not pass). A failure is always red.
`--require-all` also makes `PENDING` and `BLOCKED` red; the lane turns it on
once every leg is wired, so it never reads green on a claim it did not test.

The harness's own unit tests are `node:test` files, run by the job's
"Harness self-tests" step: `node --test scripts/fake-github/*.test.mjs
apps/runner/e2e/lib/*.test.mjs`. They are not Vitest files, so
`apps/runner`'s Vitest config includes only `src/**/*.test.ts`; `ci.yml`'s Check + Build runs them too.

## Doubles and setup

None of these is the behaviour under test:

- **The person**: a test-issuer token (`convex/fixture/jwt.ts`), preview access
  granted with the fixture's admin key, the agreement accepted the way sign-in
  accepts it, a project through `projects.create` (`lib/backend.mjs`).
- **The fake GitHub** (`scripts/fake-github/server.mjs`): one loopback origin
  laid out like GitHub Enterprise Server (`GITHUB_WEB_URL` = the origin,
  `GITHUB_API_URL` = `<origin>/api/v3`). OAuth with PKCE and rotating refresh
  tokens, the REST endpoints the backend calls with App JWTs verified against
  the key it hands the deployment, and git smart HTTP (`git http-backend`) that
  needs `x-access-token:<token>` with a token whose user or installation reaches
  the repository.
- **The release** (`lib/release-server.mjs`): GitHub's download layout
  (`/<owner>/<repo>/releases/download/<tag>/<asset>`, `releases/latest`) and the
  public Releases API shape, for `install.sh --release-base` and manifest URLs.
- **The box** (`box/Dockerfile`, `lib/box.mjs`): stock `ubuntu:24.04` (pinned by
  digest) with systemd as PID 1 and only what a rented VPS ships with (curl, CA
  roots, git). No Node, no Volli. Privileged, its own cgroup namespace, on the
  host network so it reaches the loopback servers at the driver's URLs.
- **The browser**: the driver follows the fake GitHub's redirect and posts the
  backend's confirm form, as a person's browser would.

## Evidence

`$VOLLI_BYO_EVIDENCE` (CI: the `byo-runner-acceptance-attempt-N` artifact)
holds `evidence.json` (each leg, every box command's exit and output tail,
the fake GitHub's and the release's request logs, the box journal on failure)
and `summary.md`, which is also the job summary. Tokens, credentials, keys and
JWT-shaped strings are redacted; the request logs never record a credential,
only its kind.
