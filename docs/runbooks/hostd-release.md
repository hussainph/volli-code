# Hostd release manifest

> **Superseded host architecture; active packaging reference.** This runbook
> maintains the hostd artifacts still built by the release workflow. It does not
> define the current cloud backend or Runner deployment; see
> [Workspace authority and offline](../BOUNDARIES.md#workspace-authority-and-offline).

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

With the default `require_green=true`, the dry-run first requires a successful
`ci.yml` run on the selected SHA and calls CI extended on that exact SHA. Only
after extended succeeds does it build all four tarballs, verify their checksums,
generate the pin, and build the desktop with it. It uploads `hostd-linux-x64`,
`hostd-linux-arm64`, `hostd-darwin-arm64`, `hostd-darwin-x64`,
`hostd-release-assets` and `desktop-hostd-manifest` workflow artifacts.
`hostd-assets` runs only when both the Linux and the macOS builds succeed.
`prepare` (bump/push), tagging, the macOS release job, and provenance signing
are skipped. No local Docker, signing or keychain commands are needed.

**A real button release requires `dry_run=false`**: uncheck `dry_run` in the
Actions form. Only an authorized maintainer may invoke the publishing path or push a release
tag. The exact CLI equivalent for a patch release is:

```sh
gh workflow run release.yml --ref main -f bump=patch -f dry_run=false
```

The button's `prepare` job writes the resolved version into both root and
desktop `package.json` files in the same commit and pushes it to main. The
existing `ci.yml` guard checks the source commit before this version-only bump;
CI extended then runs on the exact bumped SHA. `release-ready` tags that SHA
only after extended succeeds, before any artifact signing or publication. A red
extended run can leave the version commit on main, but creates no tag or release.
`require_green=false` is the explicit dispatch escape hatch for both CI checks.
Tag-triggered releases also run extended on their exact SHA before signing or
publication. **Every release
starts as a draft**, invisible to updater clients while building and uploading.
The single desktop publisher uploads the complete Mac + hostd + runner asset
set after signing, notarization and stapling. It validates the feed's version,
filenames, sizes and SHA-512 hashes against the completed DMG/ZIP, then downloads
every uploaded asset and compares its bytes with the local artifact. Only then
does it publish a canary as a prerelease. Stable releases stay drafts for manual
notes review and publication.

Upload or remote-verification failures leave the release as a draft; rerunning
reuses that draft and replaces its assets, preserving notes and `canary-peer.json`.
A published-tag rerun is verification-only: differing rebuilt assets fail rather
than replacing files clients may already be downloading. Use a new version to
ship different bytes. After publication the job also checks the unauthenticated
`releases/download/<tag>/latest-mac.yml` URL with a bounded propagation retry.
Failure of that final public check fails the job but does not unpublish the
already complete release. Stable drafts cannot be checked through a public URL
until manually published; their assets are verified through authenticated downloads.

A release containing migration 061 must retain the corresponding database
compatibility/rollback checks.

### Release deploy key and main's ruleset

`main` is meant to require a green `CI gate` on a branch that is up to date
with `main` (repository ruleset "Main Protection", id `19737203`). The button's
`chore(release): <version>` commit is made inside `prepare` and can never have
that check, and GitHub refuses the GitHub Actions integration as a bypass actor
on a user-owned repository (HTTP 422). So `prepare` pushes the bump to `main`
over SSH with a write deploy key from the `RELEASE_DEPLOY_KEY` secret, and the
ruleset lets deploy keys bypass it. The push is not forced: if `main` moved
during the run, git rejects the non-fast-forward and nothing is tagged.

The tag is still pushed with `GITHUB_TOKEN`. The ruleset targets only the
default branch, so the tag needs no bypass, and a tag pushed with
`GITHUB_TOKEN` does not start the workflow's own tag path; a deploy-key tag
push would, and would publish the release twice. The deploy-key push to `main`
does start `ci.yml` and `codeql.yml` on the release commit, as a merge does.
CI extended has no main-push trigger: release calls it directly and waits for
success. The tag is pushed by `release-ready`, not by `prepare`.

That key can bypass every rule on `main`, so it lives in a `release`
environment that only `main` may deploy from, never in repository secrets that
a workflow on any branch could read. `prepare` declares `environment: release`
and fails first, before any guard or bump, when `RELEASE_DEPLOY_KEY` is
missing. Dry runs skip `prepare` and never need the key.

One-time owner setup, in this order:

1. Create the key, the environment and the secret. This changes nothing for
   the current workflow and can happen before this change merges.

   ```sh
   dir="$(mktemp -d)"
   ssh-keygen -t ed25519 -N '' -C 'volli-code release' -f "$dir/release_key"
   # Deploy key with write access (or Settings → Deploy keys → Add deploy key,
   # paste release_key.pub, tick "Allow write access"):
   gh repo deploy-key add "$dir/release_key.pub" --repo hussainph/volli-code --allow-write --title release.yml
   # Environment "release", deployable from main only:
   gh api -X PUT repos/hussainph/volli-code/environments/release \
     -F 'deployment_branch_policy[protected_branches]=false' \
     -F 'deployment_branch_policy[custom_branch_policies]=true'
   gh api -X POST repos/hussainph/volli-code/environments/release/deployment-branch-policies \
     -f name=main -f type=branch
   gh secret set RELEASE_DEPLOY_KEY --env release --repo hussainph/volli-code < "$dir/release_key"
   ```

2. Check the key works: `ssh -i "$dir/release_key" -o IdentitiesOnly=yes -T git@github.com`
   should greet `hussainph/volli-code`.
3. Delete the local files: `rm -rf "$dir"`.
4. Merge the release.yml change (VC-1057).
5. Apply the ruleset: `gh api -X PUT repos/hussainph/volli-code/rulesets/19737203 --input main-protection.json`.
   Applying it before step 4 breaks button releases.
6. Confirm with `gh api repos/hussainph/volli-code/rulesets/19737203`.

`main-protection.json` is the complete ruleset (a PUT replaces the rules and
bypass list wholesale):

```json
{
  "name": "Main Protection",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "bypass_actors": [{ "actor_id": null, "actor_type": "DeployKey", "bypass_mode": "always" }],
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": true,
        "required_status_checks": [{ "context": "CI gate", "integration_id": 15368 }]
      }
    }
  ]
}
```

`integration_id` 15368 is the GitHub Actions app, which posts `CI gate`.
`ci.yml` has no path filters, so every pull request reports it. Any deploy key
with write access can bypass this ruleset, so keep the release key the only
one.

A `hostd-assets` failure (including provenance signing) deliberately blocks the
desktop release: the signed desktop pin requires matching assets on that same
release. After a failure, use **“Re-run all jobs”**, not “re-run failed jobs”
(actions/download-artifact#486 reports cross-attempt artifact-download 404s).
Button-mode `prepare` is not idempotent and can bump again on a full rerun;
the release operator must account for that when choosing the retry/version. The artifact
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
