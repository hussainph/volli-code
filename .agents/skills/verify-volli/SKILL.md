---
name: verify-volli
description: Prove a Volli desktop change in the LIVE app — launch an isolated, keychain-free dev build with volli-drive, drive the real user path (snapshot → one action → fresh snapshot), assert host side effects (SQL / volli CLI), and keep screenshots + transcript as evidence. Use after building or reviewing any user-facing desktop change, when asked to "drive it", "verify in the app", "check it live", or before attaching "drove it in the live app" evidence to a PR. Feature recipes live in features/.
---

# verify-volli — drive the live Volli app with `volli-drive`

`volli-drive` launches **your checkout's built app** as an isolated instance and drives it with the same verbs and ref model as Volli's Browser Tab tools. It is the **one sanctioned exception** to "no local Electron runs" (VC-703) because of what it guarantees:

- **Keychain-free, fail-closed.** It sets `VOLLI_HARNESS=1`; main then traps every `safeStorage` method (a call throws, is recorded, and ends the run with exit 86), seals secrets with per-instance key files, and Chromium runs with `--use-mock-keychain --password-store=basic`. `launch` refuses a bundle without the guard and stops the instance unless the *live* process proves every trap is in place.
- **Isolated.** Its own `--user-data-dir`, DB, `HOME`, Pi agent dir, worktree home, git config, socket — all under `/tmp/vd-<id>-*`. The outer Session's `VOLLI_*` addressing, provider keys, `SSH_AUTH_SOCK` and `GH_TOKEN` are stripped; `gh` is shadowed by a refusing shim.
- **Quiet.** Accessory app (no Dock, never key/focused), synthetic CDP input only — never your pointer or keyboard.
- **Bounded.** At most 3 live instances per machine (registry lock in `/tmp/volli-drive-<uid>`), idle auto-stop after 20 min, `stop` kills only the exact pids it started.
- **Fake agent by default.** A loopback fake model (`azure-openai-responses/gpt-4.1-mini`) is pinned as the default: it replies `fake-agent: <what you typed>`; `[slow:5000]` keeps a turn running 5 s; `[plan]` replies with a markdown plan. `--model env` uses real provider keys from your environment instead. **The fake provider is a dev-only server:** volli-drive starts it on loopback for its own instance and hands only that instance its Azure-shaped env. Nothing in the product registers or offers it. Never point a real config (your own app, a shell profile, a real Azure setting) at it.

Never run the app any other way (`pnpm dev`, `pnpm start`, a smoke) to "check something quickly", never point it at your real profile, and never run `security` or any keychain experiment.

## 1. Launch

```sh
alias volli-drive='node apps/desktop/e2e/volli-drive/cli.mjs'
volli-drive doctor                      # preflight, no id: is the bundle about to launch guarded?
volli-drive launch                      # --fixture basic|empty  --model fake|env  (dev build only)
volli-drive launch --fake-script replies.json  # scripted tool-enabled fake turns; refinements still echo
```

`launch` builds first if the bundle is missing or predates the guard (`--no-build` refuses instead), then prints the instance id (`vd-xxxxxx`), the evidence dir, timings, memory and the guard status. 10–16 s to ready on an M-series Mac. Fixture `basic`: project **Drive Project** (prefix `DRV`), tickets DRV-1 (Todo), DRV-2 (Backlog), DRV-3 (Doing), DRV-4 (Needs Review), fake model pinned for `global` and `ticket` purposes.

`--fake-script` takes a JSON array of the fake provider's replies (`{text?, toolCalls?}`), consumed only by tool-enabled agent requests. Tool-free auto-title requests do not consume the sequence. Use it to exercise real Browser tool calls or questions through the loopback provider, not to inject renderer state. It requires `--model fake` and cannot be combined with remote acceptance.

After changing desktop code, `pnpm run build` (≈15 s) and launch a fresh instance; a running instance never picks up new code.

### Real deployments (unpackaged only)

For a real WorkOS/backend check, use a named, gitignored public-value profile as
specified in [cloud-deploy §9](../../../docs/runbooks/cloud-deploy.md#a-dev-check-against-a-real-deployment):
`.scratch/deployments/<name>.json`, with `name`, `convexUrl`, `siteUrl`,
`workosClientId` and `storageOrigin`. Names are `dev`, `staging`, `prod`; the
profile name must match. Unknown fields/secrets and partial inputs are refused.
Alternatively pass **all four** `--convex-url`, `--site-url`, `--workos-client-id`,
`--storage-origin` flags; they replace the file, never merge with it or ambient env.

```sh
volli-drive launch --deployment staging --fixture empty
# Production only with intentional approval: --deployment prod --confirm-prod
```

Verify the operator's target inventory first: URLs cannot self-identify as prod.
Never relabel prod as staging. There is no fallback to prod, no GitHub-variable
write, no packaged-build support, and no combination with `--cloud`/remote acceptance.
This is the checkout's built **unpackaged app**, with the same scratch profile,
keychain traps and containment as every drive. After sign-in it can write **real data**;
prefer non-prod, a dedicated test account and Workspace. The model is still fake by default.

Drive Settings → Account → sign-in, then `volli-drive sign-in-url <id>` prints
only the recorded WorkOS authorization URL. Open it yourself in a browser (private
window recommended); the driver neither follows it nor supplies credentials.
When the app offers a cloud restart, `volli-drive restart <id>` restarts on the
same isolated profile and re-proves the guard. Run `doctor` again. Preview access
and backend authorization remain enforced. Fixture sign-in/power/setup commands
are not available to this mode. Always `stop` afterwards; scratch sign-in keys are
removed. Evidence can include real account/Workspace data and authorization URLs:
keep it local and redact before sharing.

## 2. Doctor

```sh
volli-drive doctor vd-xxxxxx            # exit 2 on any problem; --json for everything
```

`OK` means: Electron is up; the build is your commit; the guard record's pid is the live main pid; all 8 `safeStorage` methods are traps; `shell.openExternal`/`openPath`/`showItemInFolder`/`trashItem` are recorders (requests land in `harness/external-requests.jsonl`, nothing opens); the guard record carries home containment (the app refused to boot unless every home-derived path — `HOME`, the agent-tools home, worktrees, Pi, DB, XDG, userData — is in scratch); both Chromium switches are on; zero violations; the socket is ours. Run it first whenever anything looks off. **If doctor ever reports a keychain violation or an inactive guard: stop, keep the evidence, report it — do not relaunch to "see if it happens again".**

## 3. Drive — snapshot → one action → fresh snapshot → verify

```sh
volli-drive snapshot vd-xxxxxx [--find "text"]       # aria tree, [ref=f2e75] refs, "generation: N"
volli-drive find vd-xxxxxx "New ticket"              # fresh snapshot, only matching nodes + ancestors
volli-drive act vd-xxxxxx --gen N --ref f2e75 --kind click [--find "dialog"]
volli-drive act vd-xxxxxx --gen N --ref f2e242 --kind type --text "Title"
volli-drive act vd-xxxxxx --gen N [--ref …] --kind press --key Enter|Escape|Space|ArrowRight|Meta+Enter
volli-drive act vd-xxxxxx --gen N --kind scroll --ref … --direction up
volli-drive wait vd-xxxxxx --text "fake-agent: hello" [--gone] [--timeout 30000]
volli-drive restore-restart vd-xxxxxx --gen N --ref f2e75 # real Restart and restore click, supervised local relaunch
volli-drive screenshot vd-xxxxxx --name after-move   # prints the PNG path
```

- Every `act`/`wait`/`find` returns a **new generation**; pass the latest one. A stale generation or a ref the snapshot never showed is refused — re-snapshot, never guess.
- Captures wait up to 10 s for non-empty aria content; `wait` uses its existing `--timeout` budget, including empty captures. An empty tree never means "found 0" or "gone": persistent emptiness fails with `empty snapshot` (a capture timing out before any tree returns is `snapshot readiness timeout`). Rejected raw trees survive as `snapshots/empty-<capture>-<attempt>-<window>.txt`; `snapshot-empty` / `snapshot-ready` transcript entries retain capture timing and counts. A non-empty boot error or missing control still fails the journey normally.
- Refs look like `f2e75` (frame-prefixed). Prefer `find "<visible text or aria name>"` over printing the whole tree; `--find` on `act`/`wait`/`snapshot` filters the fresh tree the same way.
- No drag kind and no right-click: use the product's keyboard paths (board cards: focus → `Space` → arrows → `Space`).
- Elements behind a modal lose their refs (they are inert) — that is the app, not the tool.

## 4. Evidence — prove side effects, not just pixels

```sh
volli-drive state vd-xxxxxx sql "SELECT ticket_number, status FROM tickets"   # read-only, one SELECT/WITH
volli-drive state vd-xxxxxx cli board --project DRV --json                    # the real volli CLI, unauthenticated (reads)
volli-drive state vd-xxxxxx cli session answer <short-id>
volli-drive console vd-xxxxxx --tail 50              # renderer console + page errors
volli-drive logs vd-xxxxxx [--grep s] [--trace <id>] [--follow --for 10000]   # main stdout/stderr
volli-drive metrics vd-xxxxxx                        # memory per Electron process
```

Proof standards:
- Drive the **real user path** through the UI. Fixture seeding is setup, not proof; never call `window.api` or internal setters to make the thing under test happen.
- Capture the action **and** the resulting state: a screenshot of the end state plus a `state sql`/`state cli` read of the host-side effect (row, event, CLI view).
- Mocks only at production boundaries that already isolate the outside world (the model provider's HTTP API → loopback fake; `gh` → refusing shim). Say which ones a proof relied on.
- A feature listed in `features/` with several entry points is covered only when the entry point your change touched is driven.

Everything lands in `.scratch/volli-drive/<id>/`: `screenshots/`, `snapshots/gen-NNNN-*.txt`, `transcript.jsonl` (every command with timings), `logs/{main.log,console.jsonl,supervisor.log}`, `harness/harness-guard.json`, `ready.json`, `manifest.json`. For a PR, attach the screenshots and quote the transcript lines + state reads under "Drove it in the live app".

## 5. Cleanup

```sh
volli-drive stop vd-xxxxxx          # graceful close → TERM → KILL of the exact Electron pid; removes /tmp scratch
volli-drive list                    # nothing of yours should remain live
```

`stop` never kills by name or path: it signals only the recorded supervisor and Electron, each while its pid still has the start time recorded at launch, plus the group of a recorded leader that is **still running**, their descendants, and every instance process the supervisor recorded by identity as it appeared. Once a recorded group leader is gone nothing is claimed by its group number (it can be reused); a recorded pid now held by another process is left alone (and reported). Evidence survives (`logs`, `console` still work on a stopped id). Stop every instance you launched, including after a failed attempt.

## Feature map

| # | Feature | File |
|---|---------|------|
| 01 | Board: create a ticket and move it | [features/01-board-create-and-move-ticket.md](features/01-board-create-and-move-ticket.md) |
| 02 | Start a Session and send a message (fake agent) | [features/02-session-start-and-send.md](features/02-session-start-and-send.md) |
| 03 | Queue a follow-up while a turn runs (VC-675) | [features/03-queue-follow-up.md](features/03-queue-follow-up.md) |
| 04 | Reopen a long Session: bounded history, plan card, `/copy`, scroll (VC-315) | [features/04-reopen-long-session.md](features/04-reopen-long-session.md) |
| 05 | Settings: toggle the `cloud` flag | [features/05-settings-cloud-flag.md](features/05-settings-cloud-flag.md) |
| 06 | Browser: tab groups, open into a pane, reveal, close and Undo | [features/06-browser-groups.md](features/06-browser-groups.md) |
| 07 | Cloud teammates: attribution, privacy, read-only viewing and Share | [features/07-cloud-teammates.md](features/07-cloud-teammates.md) |
| 08 | Local backup → change → restore → restart | [features/08-backup-restore.md](features/08-backup-restore.md) |

01 and 02 were driven end to end on the live build (VC-703); 03–05 are mapped from code and carry `UNVERIFIED:` marks — confirm them live and remove the marks as you go. When the app changes under a mapped feature, update its file in the same PR.

## Limits (today)

- Terminal Sessions: the instance's `$SHELL` is a fake login shell (PATH probe), so terminal/harness CLIs are not meaningfully drivable yet; use `apps/desktop/e2e/lib/fake-harness.mjs` smokes for those.
- Remote hosts: use `apps/desktop/e2e/volli-drive/remote-acceptance-smoke.mjs` and its loopback fixture. Do not connect the harness to a real remote host.
- Volli Cloud loopback fixture: `launch --cloud --cloud-subject <s>` runs an instance against the loopback fixture backend in its environment (`node convex/fixture/with-backend.ts --deploy -- …`). It needs a build made with `VOLLI_CLOUD_LOOPBACK=1`, and it refuses any other backend. Instances with the same subject are one person on two Macs. For two-account sharing, pass distinct `--cloud-subject` and `--cloud-email` values to each instance (and grant preview to each fixture email); the default dev email otherwise belongs to both accounts. Over the drive socket such an instance also answers:
  - `cloud-sign-in-browser`: follows the dev sign-in URL that the app's recorded `openExternal` asked for;
  - `restart`: a supervised restart on the same scratch tree, in place of `app.relaunch()`;
  - `runner-power suspend|resume`: SIMULATED sleep through main's dual-locked seam;
  - `cloud-checkout-folder`: the native folder picker answers with a scratch repo;
  - `cloud-state`: reads the launch marker and the runner record.
  A cloud launch stays resident on an ordinary quit, so `stop` and `restart` quit through the Tray's Quit Volli. The two-Mac journey is `apps/desktop/e2e/volli-drive/cloud-wake-acceptance-smoke.mjs` (CI: `ci-extended.yml`, `Smoke (cloud wake acceptance)`). Never point this fixture journey at a real deployment; use the separate `--deployment` mode above for real WorkOS sign-in.
- Packed apps are refused (`--build packed`/`--app` → "not yet safe; dev builds only"; the app itself also refuses harness mode when packaged) until VC-705 gives them a validated gate. Launch is the built `dist-electron/` on the dev Electron binary, rebuilt when the harness sources are newer. No HMR renderer yet.
- Fixture repos are scratch-created with a local bare `origin`; never point an instance at a real repo or remote.
- `logs --trace` is a literal match until VC-699's structured logs land (it already reads `logs/structured/*.jsonl` when present).
