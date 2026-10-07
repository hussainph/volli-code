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

Before enabling **Volli Cloud (unstable)** in Settings → Experimental, understand what you are trusting:

- **A compromised box** can put untrusted content in your views; remote content does not itself run code on your Mac ([view sanitizer](apps/desktop/src/renderer/src/components/ticket/markdown.tsx#L98-L102)). Sign-in URLs open on their own only on the provider's exact authorization domains in this Mac's [versioned catalog](packages/shared/src/sign-in-catalog.ts); other HTTP(S) pages require a click on an in-app link naming the domain ([sign-in runner](apps/desktop/src/main/host-sign-ins/sign-in-runner.ts), [link surface](apps/desktop/src/renderer/src/components/hosts/sign-ins/host-sign-in-rows.tsx)). This checks the initial URL, not subsequent browser redirects.
- **A compromised renderer** (the app's UI process) acts as you on every enrolled box: it can run code as the box user through agents (`sessions.create` / `sessions.attach`; [device policy](packages/shared/src/catalog-actor.ts#L37-L41), [Session handlers](packages/host-core/src/handlers/host-handlers.ts#L567-L580)), capture the sudo password you enter ([password field](apps/desktop/src/renderer/src/components/hosts/add-host-sheet.tsx#L445-L490)), and request “Send from this Mac”. Copying a stored provider API key now requires your approval in a window-parented native dialog owned by main; the renderer's confirmation alone cannot authorize it, and Cancel sends nothing ([key transfer](apps/desktop/src/main/host-sign-ins/send-from-this-mac.ts)).
- **An agent on the box** can read the box's stored credentials—sealing is not a sandbox ([file-key adapter](packages/host-core/src/secrets/file-key.ts#L11-L23)); on system installs it cannot write root's `/etc/volli-hostd-devices` ([device store](apps/hostd/src/enrolled-devices.ts#L198-L209)), while on user installs it shares your account and can enroll devices ([enrollment](apps/hostd/src/enroll.ts#L19-L28)).
