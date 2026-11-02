/**
 * Real Sigstore verification, offline: a provenance bundle `release.yml`
 * published for hostd 0.3.0-canary.3 (a dispatched release, so signed from
 * `refs/heads/main`) against a pinned copy of Sigstore's public-good trust
 * root. The runner's bundle has the same shape and signer.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";

import { TrustedRoot } from "@sigstore/protobuf-specs";

import { UpdateRefusal } from "./manifest";
import { checkStatement, releaseIdentity, sigstoreProvenance } from "./provenance";

vi.mock("@sigstore/tuf", () => ({
  getTrustedRoot: vi.fn(async (options: { cachePath: string }) => {
    if (options.cachePath === "/offline") throw new Error("getaddrinfo ENOTFOUND");
    return trustedRoot();
  }),
}));

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");

function trustedRoot(): TrustedRoot {
  return TrustedRoot.fromJSON(JSON.parse(fixture("sigstore-trusted-root.json")));
}

const BUNDLE = fixture("hostd-0.3.0-canary.3.sigstore.json");
const VERSION = "0.3.0-canary.3";
const SUBJECTS = [
  {
    name: "hostd-release-manifest.json",
    sha256: "2ce6348cdee1c827f8c6afe84447cc7a43cb7254ea1e4fd70bd40de4eb09da91",
  },
  {
    name: "volli-hostd-0.3.0-canary.3-linux-x64.tar.gz",
    sha256: "4a932e8b80ab47af8affde585b2f4737fab7f0d8dff760a3ebf3afbc22faff64",
  },
];

const verifier = () =>
  sigstoreProvenance({ cachePath: "/unused", trustedRoot: async () => trustedRoot() });

async function refusal(promise: Promise<unknown>): Promise<UpdateRefusal> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(UpdateRefusal);
  return error as UpdateRefusal;
}

describe("release provenance", () => {
  it("verifies a real release bundle and the digests it signs", async () => {
    await expect(verifier().verify(BUNDLE, VERSION, SUBJECTS)).resolves.toBeUndefined();
  });

  it("fetches Sigstore's trust root through TUF by default", async () => {
    const live = sigstoreProvenance({ cachePath: "/cache" });
    await expect(live.verify(BUNDLE, VERSION, SUBJECTS)).resolves.toBeUndefined();
    const offline = sigstoreProvenance({ cachePath: "/offline" });
    expect((await refusal(offline.verify(BUNDLE, VERSION, SUBJECTS))).code).toBe(
      "provenance_unavailable",
    );
  });

  it("refuses a digest the statement does not sign", async () => {
    const wrong = [{ ...SUBJECTS[1]!, sha256: "0".repeat(64) }];
    const error = await refusal(verifier().verify(BUNDLE, VERSION, wrong));
    expect(error.code).toBe("provenance");
    expect(error.message).toMatch(/does not name volli-hostd/u);
  });

  it("refuses a tampered statement", async () => {
    const bundle = JSON.parse(BUNDLE) as { dsseEnvelope: { payload: string } };
    const statement = JSON.parse(Buffer.from(bundle.dsseEnvelope.payload, "base64").toString());
    statement.subject[0].digest.sha256 = "0".repeat(64);
    bundle.dsseEnvelope.payload = Buffer.from(JSON.stringify(statement)).toString("base64");
    const error = await refusal(verifier().verify(JSON.stringify(bundle), VERSION, SUBJECTS));
    expect(error.message).toMatch(/does not verify/u);
  });

  it("refuses a signer other than this repository's release workflow", async () => {
    const identity = releaseIdentity("0.4.0");
    expect(
      identity.test(
        "https://github.com/hussainph/volli-code/.github/workflows/release.yml@refs/tags/v0.4.0",
      ),
    ).toBe(true);
    expect(
      identity.test(
        "https://github.com/hussainph/volli-code/.github/workflows/release.yml@refs/heads/main",
      ),
    ).toBe(true);
    for (const other of [
      "https://github.com/hussainph/volli-code/.github/workflows/release.yml@refs/tags/v0.4.1",
      "https://github.com/hussainph/volli-code/.github/workflows/release.yml@refs/heads/feature",
      "https://github.com/hussainph/volli-code/.github/workflows/ci.yml@refs/heads/main",
      "https://github.com/someone/volli-code/.github/workflows/release.yml@refs/heads/main",
      "https://github.com/hussainph/volli-codeX/.github/workflows/release.yml@refs/heads/main",
    ]) {
      expect(identity.test(other)).toBe(false);
    }
    // A version is matched literally, not as a pattern.
    const tagged =
      "https://github.com/hussainph/volli-code/.github/workflows/release.yml@refs/tags/v";
    expect(releaseIdentity("1.0.0+meta").test(`${tagged}1.0.0+meta`)).toBe(true);
    expect(releaseIdentity("1.0.0+meta").test(`${tagged}1.0.00meta`)).toBe(false);
  });

  it("refuses something that is not a signed statement", async () => {
    expect((await refusal(verifier().verify("{", VERSION, SUBJECTS))).message).toMatch(
      /not a Sigstore bundle/u,
    );
    const bundle = JSON.parse(BUNDLE) as Record<string, unknown>;
    delete bundle.dsseEnvelope;
    bundle.messageSignature = {
      messageDigest: { algorithm: "SHA2_256", digest: Buffer.alloc(32).toString("base64") },
      signature: Buffer.from("sig").toString("base64"),
    };
    expect(
      (await refusal(verifier().verify(JSON.stringify(bundle), VERSION, SUBJECTS))).message,
    ).toMatch(/no signed statement/u);
  });
});

const statement = (value: unknown): Buffer => Buffer.from(JSON.stringify(value));
const check = (type: string, payload: Buffer) => () =>
  checkStatement(type, payload, [{ name: "a", sha256: "1" }]);

describe("the signed statement", () => {
  const IN_TOTO = "application/vnd.in-toto+json";
  const V1 = "https://in-toto.io/Statement/v1";

  it("must be an in-toto v1 statement naming every subject", () => {
    expect(check("text/plain", statement({}))).toThrow(/not an in-toto statement/u);
    expect(check(IN_TOTO, Buffer.from("{"))).toThrow(/not an in-toto v1/u);
    expect(check(IN_TOTO, statement(null))).toThrow(/not an in-toto v1/u);
    expect(check(IN_TOTO, statement({ _type: "v0" }))).toThrow(/not an in-toto v1/u);
    expect(check(IN_TOTO, statement({ _type: V1 }))).toThrow(/does not name a/u);
    expect(
      check(
        IN_TOTO,
        statement({
          _type: V1,
          subject: [null, { name: "a" }, { name: "a", digest: { sha256: "2" } }],
        }),
      ),
    ).toThrow(/does not name a/u);
    expect(
      check(IN_TOTO, statement({ _type: V1, subject: [{ name: "a", digest: { sha256: "1" } }] })),
    ).not.toThrow();
  });
});
