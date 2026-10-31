# Volli runner artifact

Self-contained Linux x64/arm64 build. Requires glibc 2.31 or newer; musl is
unsupported. The Mac runner is the Volli desktop app. Chromium is not included.

`bin/volli-runner` and `bin/volli` use the shipped `bin/node`, not a system Node.
The installer copies this entire directory to the release prefix before starting
the runner. Run `volli-runner doctor` for machine and model-login diagnostics.

Install the version-pinned `volli-runner-install.sh` from the same GitHub release.
It verifies the tarball SHA-256 against `volli-runner-manifest.json`. This detects
corruption; first-install authenticity relies on TLS to the release origin.
Use `--verify-provenance` with a logged-in GitHub CLI for additional verification:

```sh
gh attestation verify volli-runner-<version>-linux-x64.tar.gz --repo hussainph/volli-code
```

Alternatively, with cosign and the release's Sigstore bundle:

```sh
cosign verify-blob-attestation --type slsaprovenance1 --bundle volli-runner-provenance.sigstore.json \
  --certificate-identity 'https://github.com/hussainph/volli-code/.github/workflows/release.yml@refs/tags/v<version>' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  volli-runner-<version>-linux-x64.tar.gz
```

For a button-dispatched release, the workflow identity ends in
`@refs/heads/main` instead of `@refs/tags/v<version>`; use the identity of that
release run. Both commands verify the tarball digest in the signed statement.

`--channel` selects the update channel; the installer installs its stamped
version unless `--version` is given. `--release-base` overrides the containing
release URL (for a mirror or a loopback test release). Target URLs in the manifest
are absolute, so mirrors must regenerate the manifest with their own base URL.
Without systemd, installation skips starting a service; use `volli-runner run`.

The shell bootstrap hands a private `${TMPDIR:-/tmp}/volli-runner.*` staging
directory to the binary installer. It is removed on download/probe errors, but
retained after a successful or failed handoff. Once no installation is running,
that staging directory can be deleted; the installed release does not use it.
