# Security Policy

## Report a vulnerability

Report suspected vulnerabilities through [GitHub private vulnerability reporting](https://github.com/hussainph/volli-code/security/advisories/new). Do not open a public issue for a security report.

Include the affected commit, the expected impact, reproduction steps, and any known workaround. The report and follow-up discussion remain private while the issue is investigated.

## Supported versions

Volli is in early alpha. Only the **most recent published release** and the latest commit on `main` receive security fixes. Older alpha builds are not patched — fixes ship forward in the next build.

The app updates itself from [GitHub Releases](https://github.com/hussainph/volli-code/releases) and installs an available update when you quit, so staying current is the supported path. If you have pinned yourself to an older build, update before reporting an issue.

## What alpha users should expect

This is a prerelease project maintained without a formal SLA. Concretely:

- There is no committed response or fix deadline. Reports are triaged as soon as reasonably possible.
- There are no backported patches and no security advisories for superseded alpha builds.
- Volli runs code and tooling on your machine at your direction. Treat any project you point it at, and any model provider you connect, as part of your trust boundary.

Being honest about the above is deliberate: do not rely on this project for a threat model it does not yet support.

## Cloud threat model

Volli Cloud is being rebuilt around a cloud backend and Runners (see `docs/BOUNDARIES.md`, "Workspace authority and offline"). This section has two parts: the outline the new design is held to, which is **not shipped yet**, and the trust boundaries of the experimental host path that ships today behind the flag.

### Volli Cloud design outline (not shipped)

What each party can reach, and what it never holds:

- **The backend** is the single authority for Workspaces, Members, projects, the board, the Session ledger and config. Bulk history (packed transcripts, agent logs, blobs) sits in object storage under keys the backend authorizes. Team secrets and model keys are stored encrypted per Workspace, and every delete and policy change is audited. A self-service hard delete purges the data, including from backups, after a fixed window.
- **Model credentials.** API keys and Workspace model keys live in the backend's Model gateway; Runners receive short-lived, scoped Runner tokens, never the raw key. **Subscriptions never leave your machine**: Mac and Linux runners use them locally from the sealed store, and Volli Cloud runners use API keys only. Migrating from local mode re-enters API keys by default; uploading them to the team secrets manager is an explicit opt-in.
- **Runners** connect outbound and authenticate with Runner tokens. A compromised runner can act within its tokens: write facts for the Sessions it runs and read the secrets injected into them. It holds no board authority, and a Mac runner runs only its owner's work. Secrets are injected into the runner environment, never into transcripts, and are redacted before anything is uploaded.
- **Volli Cloud runners** are disposable, isolated environments built from the project's Environment recipe. Their snapshots expire on their own schedule.
- **Clients** (desktop, web, phone, CLI) hold no durable authority. A compromised client acts as its signed-in person, within that person's Member role.
- **Members** see every project in their Workspace. Ticket work is shared by default and ad-hoc chats are private; an admin can make everything shared. An agent acts on behalf of the person who started its Session: their model connection, their git identity and their name on board changes.
- **Git** stays the person's. Volli never commits or pushes on its own; agents push only when asked or per the project's ship behaviour, using the person's GitHub App user-to-server token on the runner.
- **Terminals and browser screencasts** are streamed runner-to-client over an authorized relay for one Session; they are never stored in the backend.

### Experimental host path (superseded)

Before enabling **Volli Cloud (unstable)** in Settings → Experimental today, understand what you are trusting:

- **A compromised box** can put untrusted content in your views; remote content does not itself run code on your Mac ([view sanitizer](apps/desktop/src/renderer/src/components/ticket/markdown.tsx#L98-L102)). Sign-in URLs open on their own only over HTTPS on the provider's exact authorization domains in this Mac's [versioned catalog](packages/shared/src/sign-in-catalog.ts); other HTTP(S) pages require a click on an in-app link naming the domain ([sign-in runner](apps/desktop/src/main/host-sign-ins/sign-in-runner.ts), [link surface](apps/desktop/src/renderer/src/components/hosts/sign-ins/host-sign-in-rows.tsx)). This checks the initial URL, not subsequent browser redirects.
- **A compromised renderer** (the app's UI process) acts as you on every enrolled box: it can run code as the box user through agents (`sessions.create` / `sessions.attach`; [device policy](packages/shared/src/catalog-actor.ts#L37-L41), [Session handlers](packages/host-core/src/handlers/host-handlers.ts#L567-L580)), capture the sudo password you enter ([password field](apps/desktop/src/renderer/src/components/hosts/add-host-sheet.tsx#L445-L490)), and request “Send from this Mac”. Copying a stored provider API key now requires your approval in a window-parented native dialog owned by main; the renderer's confirmation alone cannot authorize it, and Cancel sends nothing ([key transfer](apps/desktop/src/main/host-sign-ins/send-from-this-mac.ts)).
- **An agent on the box** can read the box's stored credentials—sealing is not a sandbox ([file-key adapter](packages/host-core/src/secrets/file-key.ts#L11-L23)); on system installs it cannot write root's `/etc/volli-hostd-devices` ([device store](apps/hostd/src/enrolled-devices.ts#L198-L209)), while on user installs it shares your account and can enroll devices ([enrollment](apps/hostd/src/enroll.ts#L19-L28)).

- **A paired Mac** can register and clone projects on the box over the host protocol as the host service account, as the SSH path already could on system installs. A host-scoped device connection has no Workspace authority; Workspace operations require a separate Workspace-scoped connection. Conversely, `host.workspaces` is never granted on a Workspace connection, and its operations refuse Workspace actors before parsing. Project creation survives client disconnection, but not host shutdown. HTTPS Git uses only the host's supplied stored-token helper, with prompts and ambient Git configuration disabled. SSH intentionally retains the person's own `SSH_AUTH_SOCK` and uses `StrictHostKeyChecking=accept-new`, matching the SSH project-creation path. Process concurrency, output, execution time and retained outcomes are bounded ([execution policies](docs/host-scoped-connection.md#execution-policies)).
