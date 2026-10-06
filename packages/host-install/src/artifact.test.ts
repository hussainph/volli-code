import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  artifactFileName,
  parseChecksum,
  parseHostdReleasePin,
  resolveArtifact,
  sha256File,
  supportedTargets,
  type ArtifactRequest,
} from "./artifact";
import { recordingLogger } from "./testing/fake-process";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "host-install-artifact-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const BYTES = "pretend tarball";
const SHA = createHash("sha256").update(BYTES).digest("hex");
const NAME = "volli-hostd-1.1.0-linux-x64.tar.gz";

const MANIFEST = {
  schemaVersion: 1,
  version: "1.1.0",
  releaseTag: "v1.1.0",
  assets: [
    { platform: "linux", arch: "x64", name: NAME, sha256: SHA, size: BYTES.length },
    {
      platform: "linux",
      arch: "arm64",
      name: "volli-hostd-1.1.0-linux-arm64.tar.gz",
      sha256: "a".repeat(64),
    },
  ],
};
const PIN = parseHostdReleasePin(MANIFEST)!;

function request(overrides: Partial<ArtifactRequest> = {}): ArtifactRequest {
  return {
    version: "1.1.0",
    target: "linux-x64",
    cacheDir: join(root, "cache"),
    pin: PIN,
    logger: recordingLogger().logger,
    ...overrides,
  };
}

/** A fetch that serves `files` by URL, 404 otherwise, and records what was asked. */
function serving(files: Record<string, string | number | null>) {
  const asked: string[] = [];
  const fetch = (async (url: string) => {
    asked.push(url);
    const body = files[url];
    if (body === undefined) return new Response(null, { status: 404 });
    if (body === null) return new Response(null, { status: 200 });
    if (typeof body === "number") return new Response(null, { status: body });
    return new Response(body);
  }) as typeof globalThis.fetch;
  return { fetch, asked };
}

const RELEASE_URL = `https://github.com/hussainph/volli-code/releases/download/v1.1.0/${NAME}`;

describe("the signed app's hostd pin", () => {
  it("reads VC-701's manifest, keeping only well-formed assets of this version", () => {
    expect(PIN).toEqual({
      version: "1.1.0",
      releaseTag: "v1.1.0",
      assets: [
        { target: "linux-x64", name: NAME, sha256: SHA, size: BYTES.length },
        {
          target: "linux-arm64",
          name: "volli-hostd-1.1.0-linux-arm64.tar.gz",
          sha256: "a".repeat(64),
          size: null,
        },
      ],
    });
    expect(
      parseHostdReleasePin({
        ...MANIFEST,
        assets: [
          null,
          { ...MANIFEST.assets[0], name: "other" },
          { ...MANIFEST.assets[0], sha256: "x" },
        ],
      })?.assets,
    ).toEqual([]);
    for (const bad of [
      null,
      "x",
      { ...MANIFEST, schemaVersion: 2 },
      { ...MANIFEST, version: 1 },
      { ...MANIFEST, releaseTag: "1.1.0" },
      { ...MANIFEST, assets: {} },
    ]) {
      expect(parseHostdReleasePin(bad)).toBeNull();
    }
  });

  it("names the targets this build can install", () => {
    expect(supportedTargets(PIN)).toEqual(["linux-x64", "linux-arm64"]);
    expect(supportedTargets(null)).toEqual(["linux-x64"]);
    expect(supportedTargets({ ...PIN, assets: [] })).toEqual(["linux-x64"]);
  });
});

describe("resolving the tarball", () => {
  it("downloads a pinned asset, checks it against the pin alone, and caches it", async () => {
    const { fetch, asked } = serving({
      [RELEASE_URL]: BYTES,
      [`${RELEASE_URL}.sha256`]: `${"0".repeat(64)}  ${NAME}\n`,
    });
    const artifact = await resolveArtifact(request({ fetch }));
    expect(artifact).toMatchObject({
      source: "release",
      sha256: SHA,
      bytes: BYTES.length,
      fileName: NAME,
    });
    // The sidecar is never asked for: the pin is the only trust root.
    expect(asked).toEqual([RELEASE_URL]);
    const again = await resolveArtifact(request({ fetch }));
    expect(again).toMatchObject({ source: "cache" });
    expect(asked).toHaveLength(1);
  });

  it("refuses a download that does not match the pin, and fetches again over a cache that does not", async () => {
    const cached = join(root, "cache/1.1.0", NAME);
    mkdirSync(join(root, "cache/1.1.0"), { recursive: true });
    writeFileSync(cached, "tampered");
    const { fetch } = serving({ [RELEASE_URL]: "also tampered" });
    expect(await resolveArtifact(request({ fetch }))).toMatchObject({ kind: "artifact-checksum" });
    expect(readFileSync(cached, "utf8")).toBe("tampered");
  });

  it("says what is unavailable, and why a fetch failed", async () => {
    expect(await resolveArtifact(request({ fetch: serving({}).fetch }))).toMatchObject({
      kind: "artifact-unavailable",
      detail: `${NAME} is not published at v1.1.0.`,
    });
    expect(
      await resolveArtifact(request({ fetch: serving({ [RELEASE_URL]: 500 }).fetch })),
    ).toMatchObject({
      kind: "artifact-fetch-failed",
    });
    expect(
      await resolveArtifact(request({ fetch: serving({ [RELEASE_URL]: null }).fetch })),
    ).toMatchObject({
      kind: "artifact-fetch-failed",
    });
    const throwing = (async () => {
      throw new Error("offline");
    }) as typeof globalThis.fetch;
    expect(await resolveArtifact(request({ fetch: throwing }))).toEqual({
      kind: "artifact-fetch-failed",
      detail: "offline",
    });
    expect(await resolveArtifact(request({ target: "linux-riscv64" }))).toMatchObject({
      kind: "artifact-unavailable",
      detail: "This app pins no linux-riscv64 hostd.",
    });
    expect(await resolveArtifact(request({ version: "1.2.0" }))).toMatchObject({
      detail: "This app pins hostd 1.1.0, not 1.2.0.",
    });
  });

  it("uses only the dev tarball when the build has no release assets, missing or empty alike", async () => {
    const tarball = join(root, NAME);
    writeFileSync(tarball, BYTES);
    writeFileSync(`${tarball}.sha256`, `${SHA}  ${NAME}\n`);
    for (const pin of [null, { ...PIN, assets: [] }]) {
      expect(await resolveArtifact(request({ pin, devTarball: tarball }))).toMatchObject({
        source: "dev",
        sha256: SHA,
      });
      expect(await resolveArtifact(request({ pin }))).toMatchObject({
        kind: "artifact-unavailable",
      });
    }
    writeFileSync(`${tarball}.sha256`, `${"0".repeat(64)}  ${NAME}\n`);
    expect(await resolveArtifact(request({ pin: null, devTarball: tarball }))).toMatchObject({
      kind: "artifact-checksum",
    });
    writeFileSync(`${tarball}.sha256`, "not a digest");
    expect(await resolveArtifact(request({ pin: null, devTarball: tarball }))).toMatchObject({
      kind: "artifact-checksum",
    });
    rmSync(`${tarball}.sha256`);
    expect(await resolveArtifact(request({ pin: null, devTarball: tarball }))).toMatchObject({
      detail: `${tarball}.sha256 is missing.`,
    });
    writeFileSync(`${tarball}.sha256`, SHA);
    rmSync(tarball);
    expect(await resolveArtifact(request({ pin: null, devTarball: tarball }))).toMatchObject({
      detail: `${tarball} is missing.`,
    });
  });

  it("uses the platform's fetch and a given release base", async () => {
    const { fetch, asked } = serving({ [`https://mirror.test/v1.1.0/${NAME}`]: BYTES });
    vi.stubGlobal("fetch", fetch);
    try {
      expect(
        await resolveArtifact(request({ releaseBaseUrl: "https://mirror.test" })),
      ).toMatchObject({ source: "release" });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(asked).toEqual([`https://mirror.test/v1.1.0/${NAME}`]);
  });

  it("names files and reads digests as sha256sum writes them", async () => {
    expect(artifactFileName("1.0.0", "linux-arm64")).toBe("volli-hostd-1.0.0-linux-arm64.tar.gz");
    expect(parseChecksum(`${SHA.toUpperCase()}  file\n`)).toBe(SHA);
    expect(parseChecksum("nope")).toBeNull();
    expect(await sha256File(join(root, "none"))).toBeNull();
  });
});
