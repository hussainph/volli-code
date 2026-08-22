# Security Policy

## Report a vulnerability

Report suspected vulnerabilities through [GitHub private vulnerability reporting](https://github.com/hussainph/volli-code/security/advisories/new). Do not open a public issue for a security report.

Include the affected commit, the expected impact, reproduction steps, and any known workaround. The report and follow-up discussion remain private while the issue is investigated.

## Supported versions

Volli Code is in early alpha. Only the **most recent published release** and the latest commit on `main` receive security fixes. Older alpha builds are not patched — fixes ship forward in the next build.

The app updates itself from [GitHub Releases](https://github.com/hussainph/volli-code/releases) and installs an available update when you quit, so staying current is the supported path. If you have pinned yourself to an older build, update before reporting an issue.

## What alpha users should expect

This is a prerelease project maintained without a formal SLA. Concretely:

- There is no committed response or fix deadline. Reports are triaged as soon as reasonably possible.
- There are no backported patches and no security advisories for superseded alpha builds.
- Volli runs code and tooling on your machine at your direction. Treat any project you point it at, and any model provider you connect, as part of your trust boundary.

Being honest about the above is deliberate: do not rely on this project for a threat model it does not yet support.
