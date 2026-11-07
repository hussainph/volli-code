/**
 * Release provenance: the Sigstore bundle `release.yml` publishes beside the
 * runner (`volli-runner-provenance.sigstore.json`, from
 * `actions/attest-build-provenance`). The bundle is a signed in-toto statement
 * whose subjects are the release's assets by name and SHA-256.
 *
 * An update is installed only when:
 * - the bundle verifies against Sigstore's public-good trust root (Fulcio
 *   certificate chain, Rekor inclusion, the DSSE signature);
 * - its signer is this repository's release workflow, from the release's tag
 *   (`release.yml@refs/tags/v<version>`) or from `main`, which a dispatched
 *   release runs from (`release.yml@refs/heads/main`), issued by GitHub
 *   Actions' OIDC;
 * - its statement names the manifest and this box's tarball with the very
 *   digests the updater checked.
 *
 * That is stronger than install.sh's first-install check (SHA-256 against a
 * manifest from the same TLS origin): a release origin that serves a forged
 * manifest and tarball still cannot produce this signature. The trust root
 * comes from Sigstore's TUF repository, cached under the install root, never
 * from the release origin.
 *
 * The Sigstore libraries load on first use, so no other command pays for them.
 */
import type { Bundle } from "@sigstore/bundle";
import type { TrustedRoot } from "@sigstore/protobuf-specs";

import { RELEASE_REPO, UpdateRefusal } from "./manifest";

/** One asset the statement must name, with the digest the updater checked. */
export interface ProvenanceSubject {
  readonly name: string;
  readonly sha256: string;
}

export interface ProvenanceVerifier {
  /** Resolves when `bundle` proves `subjects` came from `version`'s release; throws {@link UpdateRefusal} otherwise. */
  verify(bundle: string, version: string, subjects: readonly ProvenanceSubject[]): Promise<void>;
}

export const GITHUB_ACTIONS_ISSUER = "https://token.actions.githubusercontent.com";

const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** The release workflow's certificate identity for `version`: its tag, or `main`. */
export function releaseIdentity(version: string): RegExp {
  return new RegExp(
    `^https://github\\.com/${escape(RELEASE_REPO)}/\\.github/workflows/release\\.yml@refs/(?:tags/v${escape(version)}|heads/main)$`,
    "u",
  );
}

function refuse(message: string): never {
  throw new UpdateRefusal("provenance", message);
}

interface Statement {
  readonly _type?: unknown;
  readonly subject?: unknown;
}

/**
 * The signed statement must be in-toto v1 and name every one of `subjects`
 * with its digest. Called only on a payload whose signature verified.
 */
export function checkStatement(
  payloadType: string,
  payload: Buffer,
  subjects: readonly ProvenanceSubject[],
): void {
  if (payloadType !== "application/vnd.in-toto+json") {
    refuse(`The provenance bundle signs ${payloadType}, not an in-toto statement.`);
  }
  let statement: Statement | null;
  try {
    statement = JSON.parse(payload.toString("utf8")) as Statement | null;
  } catch {
    statement = null;
  }
  // oxlint-disable-next-line no-underscore-dangle -- in-toto's own field name.
  if (statement === null || statement._type !== "https://in-toto.io/Statement/v1") {
    refuse("The provenance statement is not an in-toto v1 statement.");
  }
  const listed = Array.isArray(statement.subject) ? (statement.subject as unknown[]) : [];
  for (const wanted of subjects) {
    const found = listed.some((entry) => {
      const row = entry as { name?: unknown; digest?: { sha256?: unknown } } | null;
      return row?.name === wanted.name && row.digest?.sha256 === wanted.sha256;
    });
    if (!found) refuse(`The provenance statement does not name ${wanted.name} with its digest.`);
  }
}

/**
 * The live verifier. `trustedRoot` defaults to Sigstore's TUF repository,
 * cached at `cachePath`; tests pass a fixed root.
 */
export function sigstoreProvenance(options: {
  readonly cachePath: string;
  readonly trustedRoot?: () => Promise<TrustedRoot>;
}): ProvenanceVerifier {
  const loadRoot =
    options.trustedRoot ??
    (async () => (await import("@sigstore/tuf")).getTrustedRoot({ cachePath: options.cachePath }));
  return {
    async verify(text, version, subjects) {
      const { bundleFromJSON } = await import("@sigstore/bundle");
      const { toSignedEntity, toTrustMaterial, Verifier } = await import("@sigstore/verify");
      let bundle: Bundle;
      try {
        bundle = bundleFromJSON(JSON.parse(text));
      } catch (error) {
        return refuse(
          `The provenance bundle is not a Sigstore bundle: ${(error as Error).message}`,
        );
      }
      if (bundle.content.$case !== "dsseEnvelope") {
        return refuse("The provenance bundle holds no signed statement.");
      }
      let root: TrustedRoot;
      try {
        root = await loadRoot();
      } catch (error) {
        throw new UpdateRefusal(
          "provenance_unavailable",
          `Sigstore's trust root could not be fetched: ${(error as Error).message}`,
        );
      }
      try {
        new Verifier(toTrustMaterial(root)).verify(toSignedEntity(bundle), {
          subjectAlternativeName: releaseIdentity(version),
          extensions: { issuer: GITHUB_ACTIONS_ISSUER },
        });
      } catch (error) {
        refuse(`The provenance bundle does not verify: ${(error as Error).message}`);
      }
      const envelope = bundle.content.dsseEnvelope;
      checkStatement(envelope.payloadType, envelope.payload, subjects);
    },
  };
}
