# VC-579: Remote dogfood v1 acceptance evidence

This is the tracked automation companion to the owner's provisional
`.scratch/vc579-acceptance-guide.md`. The flag-on done-proof is
[`remote-acceptance-smoke.mjs`](../../apps/desktop/e2e/volli-drive/remote-acceptance-smoke.mjs)
(VC-718), run by **Smoke (cloud acceptance)** in `ci.yml`.

## Read the result, not just the green check

Download `smoke-results-cloud-attempt-*` from the build's CI run. Keep its
`acceptance.json`, per-step screenshots, snapshots, transcript, desktop log,
hostd log and guard manifest. `acceptance.json` records the tested checkout SHA.
For a canary, check **that exact tag commit**, **CI gate**, **CodeQL**, and:

- `complete: true`;
- all eight result rows are `PASS`;
- `cleanupVerified: true` and `cleanupError: null`;
- guard manifest: `scratchRemoved: true`, `electron.close.kind: "graceful"`,
  `electron.close.exit: { code: 0, signal: null }`, empty `closeFailures`,
  zero keychain violations, no leftovers and `remoteCleanupError: null`.

VC-722's host-scoped connection (#834) is merged, including project creation on
user installs. The VC-722 expected-failure marker and early exit are removed:
step 2 must open the folder project, then steps 3–8 must really run. There are
no expected failures, including for VC-721's question capability (#837,
`c0299af39`). A genuine failure records that exact step as FAIL and the unrun
steps as BLOCKED, exits nonzero and leaves `complete: false`. Eight PASS rows
still cannot claim acceptance if disposal fails or is unverified. **All eight
must PASS with graceful disposal on the exact SHA** before a canary is claimed.

## What the smoke asserts from the person's view

| Step | Person's action and visible assertion | Exit criterion |
| --- | --- | --- |
| 1 | Add the SSH host; `<host> is ready`, `Volli host …`, startup fact; Settings → Hosts → host shows an enrolled row marked `This Mac` and its `Paired …` date; scroll the host pane so the pairing heading and row are in the screenshot | 1 |
| 2 | `New project…` → Git folder path on the user-install box → `Create and open`; opened-project confirmation, project label and selected `Host: <host>` | 1, prerequisite for 2–4, 6 |
| 3 | Create a ticket in Backlog, move to Todo, reopen it; title, `Status: Todo`, `Running on <host>` | 3 (board) |
| 4 | Paste only the fake API key; `Signed in on <host> · API key` | 2 |
| 5 | Start a real remote Session; `Stop turn`, scripted streamed reply, remote host pill | 3 (Session) |
| 6 | See the real question/options, select Proceed and send; host's answered continuation | 4 (answer) |
| 7 | Leave another remote question pending; Quit through the native menu, reopen through macOS activation; same Session row says `Waiting for you`, same question remains answerable | 4, 5 |
| 8 | Logs has `This Mac` and host sources; filtering to the host shows its real `hostd` `serving` line with its machine label | 6 |

Every action under test goes through the UI/native app lifecycle. No lab rows,
preload mutation to create a ticket/Session/answer, injected HostLink, mock relay,
or synthetic log is used. The only box-state arrange is benign Git state:
initialize/commit a folder and a bare remote over the fixture's SSH. **No
`volli project add`, operator token, project DB seed or injected link** is used.
Production UI project registration is the step under test. The bare remote is
fixture setup for future push proofs, not claimed as an agent push assertion.
The doubles are the loopback sshd target and loopback Responses model provider.
Question tool calls traverse the real runtime, interaction ledger and Session
transport.

## Real capability and honest failures

The Mac creates projects as the person through VC-722's host-scoped connection
on every install mode, without an operator token. Step 2 uses the production
`New project…` UI with the fixture's folder path; no box CLI registration is a
substitute. The old named user-install refusal is now a failure, as are
SSH/install/pair, Git arrange, arbitrary errors/timeouts and cleanup errors.

Steps 6–7 require the host's real question capability and answered continuation.
The scripted provider only calls `ask_user` when production offers that tool;
it never manufactures availability or a successful answer. A VC-721 regression
must remain a failure at the actual failing question/reopen step, not a skip.
This guide describes the required journey, not evidence that the updated smoke
has already passed. The disposable-runner CI result must establish that.

Pairing snapshots can include offscreen Settings content. The drive screenshot
is viewport-only and has no crop/resize/frame option. Before saving
`step-1-paired-device`, the runner hovers the `Forget…` footer (which scrolls it
into view) and wheels down in that pane, placing `Paired devices` and the
`This Mac` row above it in the viewport. It never clicks Forget. Review that
image alongside the saved pairing snapshot; text in a snapshot alone is not
visual framing proof.

## Deployment preconditions and limits

The job builds a matching darwin-arm64 hostd archive/checksum before the desktop
native rebuild. The app's production installer uploads, installs, starts and
pairs it. SSH uses an explicit scratch `-F` config and fresh fixture keys, never
`~/.ssh`, an agent, a real machine or a real provider sign-in.

A managed Mac host installs in the passwd home, not scratch `$HOME`. The fixture
therefore refuses anywhere except a **disposable macOS GitHub Actions runner**,
and refuses existing hostd/Pi profiles. It does not overwrite a person's install.
The runner is discarded after the job; the supervisor closes its daemon by
recorded process identity, sshd, fake provider and Electron and retains evidence.
Completion additionally validates the supervisor's stop manifest: scratch must
be removed and Electron must have a verified graceful, zero-code, unsignalled
close, not SIGTERM/SIGKILL escalation, an already-exited child or missing close
evidence. `volli-drive stop` returning zero is not sufficient. Remote cleanup
errors, missing guard fields or leftover processes keep acceptance incomplete.
No direct `security`, keychain or `launchctl` command is part of this smoke.

The host default model is a deployment precondition: v1 intentionally hides the
remote model picker. Fixture setup persists only that default and configures the
installed launchd plist's Azure endpoint and isolated git configuration. It
cleanly stops and calls production `start --user` to reload that deployment
configuration. **No API key is seeded on the host**: step 4 supplies it through
the real Sign-ins UI. This setup is not an acceptance assertion and must not be
used to seed any project, ticket, Session, interaction, answer or log. Only
benign Git box state is arranged as described above. The normal
volli-drive basic fixture provides the local project/default for a local turn.

Menu-bar residency concerns **This Mac's local work**, not remote work. Step 7
holds it with a real local slow model turn while a remote question is pending.
It never forces the menu-bar controller or injects a live-work count. This is a
window-destroy/reopen proof, not a cold desktop-process restart or lid-sleep test.

The automated smoke deliberately does **not** prove a real repository-scoped
GitHub push, real-provider OAuth, or an awake Linux host continuing through Mac
lid sleep. The owner must still run those manual VC-579 checks with disposable
credentials/repositories. Do not substitute localhost quit for lid acceptance.
Flag-off core e2e remains a separate, unchanged CI lane.

## CI-only invocation

After CI builds hostd and the dev desktop bundle:

```sh
# Only the disposable macOS runner; local invocation refuses before launch.
VOLLI_HOSTD_DEV_TARBALLS=/absolute/path/to/matching-hostd.tar.gz \
  node apps/desktop/e2e/volli-drive/remote-acceptance-smoke.mjs
```

The job is required by **CI gate** for cloud-path PRs and runs nightly on main
(07:30 UTC), as well as main pushes and manual workflow dispatch. There is no
hidden retry or `continue-on-error`: failures retain their evidence and stay red.
