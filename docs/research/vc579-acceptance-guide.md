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
- zero keychain violations and no cleanup error.

VC-710 (#828, `81f7729de`) and VC-711/712/713 are on main; no VC-710
expected-failure remains. While VC-721 is pending, **only steps 6–7 may XFAIL**
for the named missing `ask_user` capability, and an actual question is XPASS
and fails CI until that marker is removed. Every other step must pass, including
logs after the expected failures. This scaffolding-green check is not canary
acceptance: **all eight must PASS** before a canary is claimed.

## What the smoke asserts from the person's view

| Step | Person's action and visible assertion | Exit criterion |
| --- | --- | --- |
| 1 | Add the SSH host; `<host> is ready`, `Volli host …`, startup fact; Settings → Hosts → host shows an enrolled row marked `This Mac` and its `Paired …` date | 1 |
| 2 | Arrange outside the app via the box's own `volli project add`; UI `New project…` shows named user-install refusal, then SSH listing → project row → Open; project label and `Host: <host>` | 1, prerequisite for 2–4, 6 |
| 3 | Create a ticket in Backlog, move to Todo, reopen it; title, `Status: Todo`, `Running on <host>` | 3 (board) |
| 4 | Paste only the fake API key; `Signed in on <host> · API key` | 2 |
| 5 | Start a real remote Session; `Stop turn`, scripted streamed reply, remote host pill | 3 (Session) |
| 6 | See the real question/options, select Proceed and send; host's answered continuation | 4 (answer) |
| 7 | Leave another remote question pending; Quit through the native menu, reopen through macOS activation; same Session row says `Waiting for you`, same question remains answerable | 4, 5 |
| 8 | Logs has `This Mac` and host sources; filtering to the host shows its real `hostd` `serving` line with its machine label | 6 |

Every action under test goes through the UI/native app lifecycle. No lab rows,
preload mutation to create a ticket/Session/answer, injected HostLink, mock relay,
or synthetic log is used. The owner-approved project arrange step is explicit:
**Arrange, outside the app: the box's CLI**. It initializes a repo over fixture
SSH and invokes the installed production `volli project add` as the box user;
no direct project DB write or link injection. The subsequent UI still has to
read the real SSH project listing and open its row. Linux system-install
creation is covered separately by VC-710's tests and the owner's real-box
acceptance run, not claimed by this macOS fixture. The doubles are the loopback sshd target and the
loopback Responses model provider. Question tool calls traverse the real runtime,
interaction ledger and Session transport.

## Pending capability and honest refusals

VC-710 deliberately refuses **creating projects on user installs**; the smoke
asserts that named refusal, and opens the separately CLI-arranged project.
The CLI arrange is not waived: its real error still fails step 2 and blocks
its descendants if this deployment does not admit that production command.

VC-721 resolves hostd's `askUser: false` birth capability. Until it lands, the
fake provider returns a distinct visible diagnostic for each question request
only when the production request did not offer `ask_user`; it never manufactures
an undeclared tool. Only that diagnostic qualifies steps 6–7 as VC-721 XFAIL.
Transport, Session start, arbitrary timeouts and logs still fail normally.
No `complete:true` or canary claim is made until the marker is removed and
all eight steps pass on the exact head.

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
No direct `security`, keychain or `launchctl` command is part of this smoke.

The host default model is a deployment precondition: v1 intentionally hides the
remote model picker. Fixture setup persists only that default and configures the
installed launchd plist's Azure endpoint and isolated git configuration. It
cleanly stops and calls production `start --user` to reload that deployment
configuration. **No API key is seeded on the host**: step 4 supplies it through
the real Sign-ins UI. This setup is not an acceptance assertion and must not be
used to seed any ticket, Session, interaction, answer or log. The separate
owner-approved box CLI project arrangement is described above. The normal
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
