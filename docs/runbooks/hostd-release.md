# Hostd release manifest

Hostd and desktop pin the root `package.json` version. Root and desktop versions
must match, including the canary suffix (`X.Y.Z-canary.N`); the release tag is
`v<version>`.

## Workflow and safe dry-run

`.github/workflows/release.yml` builds four hostd targets, each on a native
runner of its own architecture:

| Target         | Job            | Runner             |
| -------------- | -------------- | ------------------ |
| `linux-x64`    | `hostd`        | `ubuntu-24.04`     |
| `linux-arm64`  | `hostd`        | `ubuntu-24.04-arm` |
| `darwin-arm64` | `hostd-darwin` | `macos-15`         |
| `darwin-x64`   | `hostd-darwin` | `macos-15-intel`   |

The Linux builds reuse the multi-arch, digest-pinned bookworm host image and
CI's existing packager/native/boot probes. The macOS builds have no image: they
run on the runner itself under nodejs.org's Node at exactly `.nvmrc`, with
pnpm enabled through that Node's corepack at `package.json`'s
`packageManager`, then the same host-only install, hostd integration test,
`apps/hostd/scripts/package.mjs` and `apps/hostd/scripts/ci-boot-artifact.sh`
(given the artifact directory as its argument) as the image runs. The archive
layout is unchanged from [Install the artifact](hostd-box.md#2-install-the-artifact).

Dispatch defaults to `dry_run=true`. To prove a branch without touching tags,
releases or desktop signing credentials:

```sh
gh workflow run release.yml --ref <branch> -f dry_run=true
```

The dry-run builds all four tarballs, verifies their checksums, generates the
pin, and builds the desktop with it. It uploads `hostd-linux-x64`,
`hostd-linux-arm64`, `hostd-darwin-arm64`, `hostd-darwin-x64`,
`hostd-release-assets` and `desktop-hostd-manifest` workflow artifacts.
`hostd-assets` runs only when both the Linux and the macOS builds succeed.
`prepare` (bump/tag/push), the macOS release job, and provenance signing are
skipped. No local Docker, signing or keychain commands are needed.

**A real button release requires `dry_run=false`**: uncheck `dry_run` in the
Actions form. Only the owner may invoke the publishing path or push a release
tag. The exact CLI equivalent for a patch release is:

```sh
gh workflow run release.yml --ref main -f bump=patch -f dry_run=false
```

The button's `prepare` job writes the resolved version into both root and
desktop `package.json` files in the same commit before tagging. Stable tags
still create drafts; canaries still publish as
prereleases. The single desktop publisher uploads the complete Mac + hostd
asset set, so rerun cleanup does not delete hostd assets. **VC-698 must land
before any release or canary containing migration 061.**

A `hostd-assets` failure (including provenance signing) deliberately blocks the
desktop release: the signed desktop pin requires matching assets on that same
release. After a failure, use **“Re-run all jobs”**, not “re-run failed jobs”
(actions/download-artifact#486 reports cross-attempt artifact-download 404s).
Button-mode `prepare` is not idempotent and can bump again on a full rerun;
the owner must account for that when choosing the retry/version. The artifact
retention period is 14 days. Hostd inputs are downloaded and checked before
pre-creating the release, so those failures cannot leave an empty live canary.

No hostd tarball carries the desktop's Apple Developer ID signature or a
notarization ticket, the darwin ones included. Linux tarballs cannot use it,
and the darwin tarballs do not need it: the desktop uploads them to the host
over SSH, so they never get a quarantine attribute and Gatekeeper never
assesses them. Their integrity root is the same as Linux's: the pin inside the
signed desktop app, and build provenance the publishing path signs via GitHub
OIDC/Sigstore for all four tarballs, `SHA256SUMS` and the manifest, shipped as
`hostd-provenance.sigstore.json`. This adds no private signing key. To verify
a downloaded asset's provenance:

```sh
gh attestation verify volli-hostd-<version>-<platform>-<arch>.tar.gz --repo hussainph/volli-code
```

The release job refuses to publish unless the downloaded hostd set is exactly
11 non-empty files (four tarballs, four sidecars, `SHA256SUMS`, the manifest
and the provenance bundle) and `SHA256SUMS` verifies.

The desktop's expected digest is inside its existing signed app payload;
clients must verify against that pin, not trust a newly downloaded checksum.

## Aggregate and validate release inputs

Collect the actual builds into one flat folder with exactly these inputs:

- `volli-hostd-<version>-linux-x64.tar.gz` and its `.tar.gz.sha256` sidecar
- `volli-hostd-<version>-linux-arm64.tar.gz` and its `.tar.gz.sha256` sidecar
- `volli-hostd-<version>-darwin-arm64.tar.gz` and its `.tar.gz.sha256` sidecar
- `volli-hostd-<version>-darwin-x64.tar.gz` and its `.tar.gz.sha256` sidecar

Each sidecar contains `<64 lowercase SHA256 hex digits>  <tarball basename>`
and a newline, as emitted by `apps/hostd/scripts/package.mjs`.

```sh
node scripts/hostd-release-manifest.mjs --assets <folder>
```

The command streams every tarball through SHA256 and compares the results to
the sidecars. Missing inputs, unexpected filenames, nonregular files, version
drift, malformed sidecars and checksum mismatches fail the command. Only after
all four targets pass does it write `SHA256SUMS` (standard `sha256sum -c` format)
and `hostd-release-manifest.json` into that folder. Existing generated outputs
are allowed so validation can be repeated. Publish the four tarballs, their
sidecars, `SHA256SUMS` and the manifest as assets of the matching GitHub release.

The generated manifest contract is:

```json
{
  "schemaVersion": 1,
  "version": "<root version>",
  "releaseTag": "v<root version>",
  "assets": [
    {
      "platform": "linux",
      "arch": "x64",
      "name": "volli-hostd-<root version>-linux-x64.tar.gz",
      "sha256": "<recomputed lowercase SHA256 hex>",
      "size": 123
    }
  ]
}
```

The example shows one entry for readability; release manifests require exactly
one entry for each of `linux` `x64`, `linux` `arm64`, `darwin` `arm64` and
`darwin` `x64`, written in that order. `size` is the optional positive byte
count.

## Desktop packaging and consumer contract

Every release desktop build **must** set `VOLLI_HOSTD_MANIFEST` to the generated
JSON's path. The desktop build runs `scripts/copy-hostd-manifest.mjs` after pack
and CLI copying. It validates schema, exact root/desktop version and release
tag, all four target filenames, and SHA256 syntax before writing
`apps/desktop/dist-electron/hostd-release-manifest.json`. Invalid supplied inputs
fail the build; they never fall back to local metadata. Hash/content validation
belongs to the generation step above: desktop copying does not need tarballs.

Without that environment variable, a local build writes the same schema/version/
tag with `assets: []` and
`unavailableReason: "Local build: VOLLI_HOSTD_MANIFEST is not set."`. It overwrites
stale metadata and contains no invented hashes. An empty local manifest is not
a valid release input. Manifest copying checks root/desktop version parity for
`build` (including ordinary CI builds) and reports both files/versions on drift.
`pnpm dev` runs the separate dev/pack-watch task, not the manifest copier; the
package/desktop CI test lanes likewise do not invoke it. No version guard is
added to those dev/test paths.

Existing electron-builder packaging includes `dist-electron/**`. The runtime
consumer reads the file at:

```ts
path.join(app.getAppPath(), "dist-electron", "hostd-release-manifest.json")
```

Consumers must treat empty assets as unavailable, not discover another version
or fabricate a download. This contract provides the pin and expected digest;
fetching, installation and runtime digest verification are not implemented here.

## Focused verification

```sh
node --test scripts/release-workflow.test.mjs scripts/hostd-release-manifest.test.mjs \
  apps/desktop/scripts/copy-hostd-manifest.test.mjs
```

Tests use temporary fixture tarballs and manifests, including canary versions;
no publishing, signing, Docker or credentials are involved.
