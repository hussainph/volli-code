# Runbook: a runner release

> **Status.** The release workflow builds and publishes the Linux runner's
> assets on the same GitHub release as the desktop app, and the backend polls
> GitHub Releases for the channel pointers that make runners update. There is
> no separate download origin yet: `dl.volli.app` is not live, and every URL in
> a published manifest is a GitHub release URL. Runner behavior itself is
> [`apps/runner/README.md`](../../apps/runner/README.md); the installer's
> contract is C3 in the BYO sprint plan (planning material, not in the repo).

A runner release is a tarball per architecture, a manifest that describes them,
a version-stamped installer, checksums, and a Sigstore provenance bundle — all
produced by `.github/workflows/release.yml` and published as assets of the
`v<version>` release. Runners update from that release without any further
step from a maintainer.

## What a release publishes

| Asset | What it is |
| --- | --- |
| `volli-runner-<version>-linux-x64.tar.gz` and `…-linux-arm64.tar.gz` | The self-contained release: `bin/node`, `bin/volli-runner`, `bin/volli`, the natives, `MANIFEST.json` |
| `…tar.gz.sha256` | One sidecar per tarball, from `apps/runner/scripts/package.mjs` |
| `volli-runner-manifest.json` | The asset set's contract, below |
| `volli-runner-install.sh` | `apps/runner/packaging/install.sh`, stamped with the version |
| `volli-runner-SHA256SUMS` | Covers the tarballs, the installer and the manifest — deliberately not the provenance bundle, which signs these bytes |
| `volli-runner-provenance.sigstore.json` | Build provenance, signed through GitHub OIDC |

The manifest is generated, never hand-edited, and exhaustive on read: an
unknown field is schema drift, and a newer shape arrives as a new
`schemaVersion`.

```json
{
  "schemaVersion": 1,
  "version": "<root version>",
  "releaseTag": "v<root version>",
  "minRunnerVersion": "<floor>",
  "minGlibc": "2.31",
  "targets": [
    { "platform": "linux", "arch": "x64", "url": "<absolute>", "size": 123, "sha256": "<64 hex>" },
    { "platform": "linux", "arch": "arm64", "url": "<absolute>", "size": 123, "sha256": "<64 hex>" }
  ],
  "provenance": { "bundleUrl": "<absolute>" }
}
```

- **`minRunnerVersion` is the compatibility floor**, not a download gate: the
  oldest runner the backend still accepts. A runner below it is told it needs
  an update and takes no new Sessions. It defaults to this release's own
  version — which forces every older runner up — so pass a lower
  `--min-runner-version` when a release must not move the floor. It is never
  newer than the release's own version.
- **`minGlibc` is `2.31`**, the baseline the artifacts are built and probed
  against. Changing it is a schema change, not a per-release flag: the
  installer and the backend both compare against this one value.
- **`url` is absolute**, so moving the download origin later changes data, not
  code. A mirror must regenerate the manifest with its own `--release-base`.

## Build it

The runner builds in `.devcontainer/runner-build/Dockerfile`: Debian 11
(bullseye, glibc 2.31) with Node 24 from nodejs.org, because Node has no
bullseye image. That image is what makes Ubuntu 20.04 and Debian 11 work.

Two jobs in `release.yml`:

- **`runner`** builds each architecture on a native runner, packages, and boots
  the artifact with only the artifact mounted — no source tree, no system Node.
  The boot probe unpacks it, checks its sidecar, runs the natives and Code Mode
  probes, checks `version`, and requires `status` to exit 3 on an empty data
  directory. Then it either boots `run` unlinked and stops it with SIGTERM, or
  — in a dry run only (`ALLOW_SKELETON`) — accepts an artifact whose `run` is
  still an explicit stub. **A real publish refuses either an `install` or a
  `run` that is not implemented**: a release is not a place for a skeleton.
- **`runner-assets`** merges both architectures, generates the manifest and the
  stamped installer, verifies `volli-runner-SHA256SUMS`, signs provenance over
  the tarballs, the manifest, the installer and the checksums, and uploads the
  complete set as `runner-release-assets`.

Both the desktop dry run and the publisher depend on `runner-assets`, so a
runner asset failure blocks the whole release, including the desktop build.
After a failure use **Re-run all jobs**, not "re-run failed jobs"
(actions/download-artifact#486 reports cross-attempt 404s).

### Dry run a branch

```sh
gh workflow run release.yml --ref <branch> -f dry_run=true
```

It builds all four hostd targets and both runner targets, verifies the runner
asset set, and builds the desktop against the pins. `prepare`, the macOS
release job and provenance signing are skipped, so no tag is pushed and
nothing is published. Artifacts are retained for 14 days.

To regenerate the asset set from local builds, in one flat folder holding both
tarballs and their sidecars:

```sh
node scripts/runner-release-manifest.mjs --assets <folder> \
  [--release-base <url>] [--min-runner-version <version>]
```

It writes `volli-runner-manifest.json`, the stamped
`volli-runner-install.sh` and `volli-runner-SHA256SUMS`, and fails on a missing
target, a version mismatch, a malformed sidecar or a checksum mismatch.

### Prove the installer in the supported distributions

`apps/runner/scripts/ci-install-matrix.sh <assets-dir>` needs Linux and Docker.
It serves the asset set from loopback and installs the real artifact in clean
containers — Ubuntu 20.04, 22.04 and 24.04, Debian 11 and 12, Fedora 41 — as
root (system) and as a normal user, with `curl` and with `wget`, then checks
that Alpine and Ubuntu 18.04 are refused with the right one-line reason. Run it
before a release that changes the installer, the build image or the manifest.

## Publish it

The publisher is the release button: **Actions → Release → Run workflow** with
`dry_run` unchecked, or

```sh
gh workflow run release.yml --ref main -f bump=patch -f dry_run=false
```

Before uploading, the publish job downloads `runner-release-assets`, verifies
`volli-runner-SHA256SUMS`, and refuses unless the set is exactly eight
non-empty files (two tarballs, two sidecars, `SHA256SUMS`, the manifest, the
installer and the provenance bundle). It then uploads them with the desktop and
hostd assets. Nothing else needs doing: the backend picks the release up on its
next poll.

## What makes runners update

`convex/functions/runnerReleases.ts` polls the public GitHub Releases API every
15 minutes, without a token, and writes one pointer per channel:

- **`stable`** is the newest published non-prerelease release;
- **`canary`** is the newest published prerelease, or the stable one when it is
  newer.

The poll validates each candidate's manifest before advancing a channel: a
malformed or missing manifest keeps that channel's last good pointer, and a
broken prerelease never holds back a valid stable release. Semantic version
precedence chooses the newest release; publication time only breaks
equal-version ties. Every poll re-reads the selected manifests, so replacing a
manifest asset on an existing release is noticed even when the release listing
is unchanged.

A runner's own policy then decides when to apply it: automatic updates wait for
idle, and the compatibility floor cannot be declined. **Needs an update** in
Settings → Runners is a runner below `minVersion`.

### Hold or roll back a channel

The poll never overwrites a pinned channel. Pin the last known good pointer to
stop further updates while you fix a release — this is a deployment-operator
action, run with the Convex CLI against the intended deployment:

```sh
pnpm -C convex exec convex run runnerReleases:pin \
  '{"channel":"stable","version":"<last good>","minVersion":"<its floor>",
    "manifestUrl":"<absolute manifest URL>","publishedAt":<ms>,"pinned":true}' \
  --deployment <ref>
```

Name the deployment explicitly (`--deployment prod`, `staging`, …): no release
workflow or runner holds a deployment credential, so this is the one door to
the channel pointers.

`"pinned":false` resumes the feed on its next poll.

**A pin stops updates; it does not downgrade.** The updater refuses to move a
runner to an older version, so a runner already on a bad release stays there
until a fixed release with a higher version exists. Publish the fix, confirm
the channel moved, then unpin if you pinned.

## Verify a published release

```sh
gh release download v<version> --repo hussainph/volli-code -p 'volli-runner-*' -D runner-assets
cd runner-assets && sha256sum -c volli-runner-SHA256SUMS
gh attestation verify volli-runner-<version>-linux-x64.tar.gz --repo hussainph/volli-code
```

`gh attestation verify` checks the tarball's digest in the signed statement. A
button-dispatched release's workflow identity ends in `@refs/heads/main`
instead of `@refs/tags/v<version>`; use the identity of that release's run. With
`cosign` and the bundle:

```sh
cosign verify-blob-attestation --type slsaprovenance1 \
  --bundle volli-runner-provenance.sigstore.json \
  --certificate-identity 'https://github.com/hussainph/volli-code/.github/workflows/release.yml@refs/tags/v<version>' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  volli-runner-<version>-linux-x64.tar.gz
```

A first install trusts TLS to the release origin; the checksum detects
corruption, not a malicious origin. `install.sh --verify-provenance` adds the
attestation check on the box when `gh` is installed and signed in.

## Focused verification

```sh
node --test scripts/release-workflow.test.mjs
```

It also runs `scripts/runner-install.test.mjs` and
`scripts/runner-release-manifest.test.mjs`, which cover the workflow's job
wiring, the manifest contract and the installer's refusals against fixture
assets. No publishing, signing, Docker or credentials are involved.
