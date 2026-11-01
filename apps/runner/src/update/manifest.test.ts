import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_RELEASE_ORIGIN,
  isReleaseVersion,
  parseManifest,
  parseReleaseOrigin,
  tarballName,
  targetFor,
  trustedUrl,
  UpdateRefusal,
} from "./manifest";

const ORIGIN = DEFAULT_RELEASE_ORIGIN;
const BASE = `${ORIGIN}v0.4.0/`;

function manifest(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    version: "0.4.0",
    releaseTag: "v0.4.0",
    minRunnerVersion: "0.3.0",
    minGlibc: "2.31",
    targets: [
      {
        platform: "linux",
        arch: "x64",
        url: `${BASE}${tarballName("0.4.0", "x64")}`,
        size: 10,
        sha256: "a".repeat(64),
      },
      {
        platform: "linux",
        arch: "arm64",
        url: `${BASE}${tarballName("0.4.0", "arm64")}`,
        size: 11,
        sha256: "b".repeat(64),
      },
    ],
    provenance: { bundleUrl: `${BASE}volli-runner-provenance.sigstore.json` },
    ...patch,
  };
}

const parse = (value: unknown, version = "0.4.0") =>
  parseManifest(typeof value === "string" ? value : JSON.stringify(value), version, [ORIGIN]);

function refusal(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(UpdateRefusal);
    return (error as UpdateRefusal).code;
  }
  throw new Error("expected a refusal");
}

describe("release versions", () => {
  it("accepts semver without a leading v", () => {
    expect(isReleaseVersion("0.3.0")).toBe(true);
    expect(isReleaseVersion("0.3.0-canary.4+build.1")).toBe(true);
    expect(isReleaseVersion("v0.3.0")).toBe(false);
    expect(isReleaseVersion("0.3")).toBe(false);
    expect(isReleaseVersion("../0.3.0")).toBe(false);
    expect(isReleaseVersion(`1.0.0-${"a".repeat(100)}`)).toBe(false);
    expect(isReleaseVersion(3)).toBe(false);
  });
});

describe("release origins", () => {
  it("takes https anywhere and http on loopback, ending in a slash", () => {
    expect(parseReleaseOrigin("https://dl.example.com/runner")).toBe(
      "https://dl.example.com/runner/",
    );
    expect(parseReleaseOrigin("http://127.0.0.1:8080/r/")).toBe("http://127.0.0.1:8080/r/");
    expect(parseReleaseOrigin("http://[::1]:9/")).toBe("http://[::1]:9/");
    expect(parseReleaseOrigin("http://localhost/")).toBe("http://localhost/");
  });

  it("refuses plain http elsewhere, credentials, queries, fragments and non-URLs", () => {
    for (const bad of [
      "http://example.com/",
      "https://user:pw@example.com/",
      "https://user@example.com/",
      "https://example.com/?a=1",
      "https://example.com/#x",
      "ftp://example.com/",
      "not a url",
    ]) {
      expect(refusal(() => parseReleaseOrigin(bad))).toBe("bad_origin");
    }
  });

  it("trusts a URL only under an origin", () => {
    expect(trustedUrl(`${BASE}x`, [ORIGIN], "x")).toBe(`${BASE}x`);
    for (const bad of [
      "https://evil.example/v0.4.0/x",
      `${ORIGIN}../../../evil/x`.replace(ORIGIN, "https://github.com/hussainph/volli-code/"),
      `https://u:p@github.com/hussainph/volli-code/releases/download/x`,
      `https://u@github.com/hussainph/volli-code/releases/download/x`,
      `${BASE}x#frag`,
      "::",
      42,
      `${BASE}${"a".repeat(2048)}`,
    ]) {
      expect(refusal(() => trustedUrl(bad, [ORIGIN], "x"))).toBe("untrusted_url");
    }
  });
});

describe("a release manifest", () => {
  it("parses one for the version asked for", () => {
    const parsed = parse(manifest());
    expect(parsed.version).toBe("0.4.0");
    expect(targetFor(parsed, "arm64").size).toBe(11);
    expect(parsed.provenance.bundleUrl).toBe(`${BASE}volli-runner-provenance.sigstore.json`);
  });

  it("refuses another version's manifest", () => {
    expect(refusal(() => parse(manifest(), "0.4.1"))).toBe("wrong_version");
    expect(refusal(() => parse(manifest({ releaseTag: "v0.4.1" })))).toBe("wrong_version");
  });

  it("refuses a box arch the release lacks", () => {
    const one = manifest({ targets: [(manifest().targets as unknown[])[0]] });
    expect(refusal(() => targetFor(parse(one), "arm64"))).toBe("no_target");
  });

  it("is strict about its shape", () => {
    const target = (patch: Record<string, unknown>) =>
      manifest({
        targets: [{ ...(manifest().targets as Record<string, unknown>[])[0], ...patch }],
      });
    const cases: unknown[] = [
      "not json",
      "[]",
      "null",
      manifest({ extra: 1 }),
      { ...manifest(), schemaVersion: undefined },
      manifest({ schemaVersion: 2 }),
      manifest({ minRunnerVersion: "0.5.0" }),
      manifest({ minRunnerVersion: "x" }),
      manifest({ minGlibc: 2.31 }),
      manifest({ minGlibc: "2" }),
      manifest({ targets: [] }),
      manifest({ targets: "x" }),
      manifest({ targets: [1, 2, 3] }),
      manifest({ targets: [null] }),
      target({ extra: true }),
      target({ platform: "darwin" }),
      target({ arch: "armv7" }),
      target({ size: 0 }),
      target({ size: 1.5 }),
      target({ sha256: "A".repeat(64) }),
      target({ sha256: 7 }),
      target({ url: `${BASE}${tarballName("0.3.9", "x64")}` }),
      manifest({
        targets: [(manifest().targets as unknown[])[0], (manifest().targets as unknown[])[0]],
      }),
      manifest({ provenance: { bundleUrl: `${BASE}b`, more: 1 } }),
      manifest({ provenance: [] }),
    ];
    for (const value of cases) {
      expect(refusal(() => parse(value))).toBe("bad_manifest");
    }
    expect(refusal(() => parse(target({ url: "https://evil.example/x" })))).toBe("untrusted_url");
    expect(
      refusal(() => parse(manifest({ provenance: { bundleUrl: "https://evil.example/b" } }))),
    ).toBe("untrusted_url");
  });
});
