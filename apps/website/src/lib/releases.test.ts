import { describe, expect, it } from "vite-plus/test";
import {
  formatBytes,
  formatPublishedDate,
  isMacPlatform,
  primaryArtifact,
  resolveStableBuild,
  type Release,
  type ReleaseAsset,
} from "./releases";

function asset(name: string, size = 122_097_864): ReleaseAsset {
  return {
    name,
    browser_download_url: `https://github.com/hussainph/volli-code/releases/download/tag/${name}`,
    size,
  };
}

// The exact asset set the release pipeline publishes today (VC-24/VC-25),
// including the dot-named zip blockmap oddity.
function releaseAssets(version: string): ReleaseAsset[] {
  return [
    asset("latest-mac.yml", 550),
    asset(`Volli-Code-${version}-arm64-mac.zip`, 121_929_170),
    asset(`Volli-Code-${version}-arm64.dmg`, 122_097_864),
    asset(`Volli-Code-${version}-arm64.dmg.blockmap`, 128_070),
    asset(`Volli.Code-${version}-arm64-mac.zip.blockmap`, 127_588),
  ];
}

function release(overrides: Partial<Release> & { tag_name: string }): Release {
  return {
    html_url: `https://github.com/hussainph/volli-code/releases/tag/${overrides.tag_name}`,
    draft: false,
    prerelease: false,
    published_at: "2026-08-16T23:08:03Z",
    assets: releaseAssets(overrides.tag_name.replace(/^v/, "")),
    ...overrides,
  };
}

describe("resolveStableBuild", () => {
  it("returns null when only prereleases exist", () => {
    expect(
      resolveStableBuild([
        release({ tag_name: "v0.1.0-canary.5", prerelease: true }),
        release({ tag_name: "v0.1.0-beta.1", prerelease: true }),
      ]),
    ).toBeNull();
  });

  it("orders stable builds by published date, not array order", () => {
    const build = resolveStableBuild([
      release({ tag_name: "v0.1.0", published_at: "2026-08-16T13:12:50Z" }),
      release({ tag_name: "v0.1.1", published_at: "2026-08-16T23:08:03Z" }),
    ]);
    expect(build?.version).toBe("0.1.1");
    expect(build?.releaseUrl).toBe("https://github.com/hussainph/volli-code/releases/tag/v0.1.1");
  });

  it("offers stable even when a newer canary has installable artifacts", () => {
    const build = resolveStableBuild([
      release({
        tag_name: "v0.2.0-canary.1",
        prerelease: true,
        published_at: "2026-09-02T00:00:00Z",
      }),
      release({ tag_name: "v0.1.0", published_at: "2026-09-01T00:00:00Z" }),
    ]);
    expect(build?.version).toBe("0.1.0");
    expect(build?.artifacts.every((artifact) => !artifact.name.includes("canary"))).toBe(true);
  });

  it("skips a prerelease even when its tag looks stable", () => {
    const build = resolveStableBuild([
      release({ tag_name: "v0.2.0", prerelease: true, published_at: "2026-09-02T00:00:00Z" }),
      release({ tag_name: "v0.1.0", published_at: "2026-09-01T00:00:00Z" }),
    ]);
    expect(build?.version).toBe("0.1.0");
  });

  it("does not fall back to a canary when stable has no installable artifacts", () => {
    expect(
      resolveStableBuild([
        release({ tag_name: "v0.2.0", assets: [asset("latest-mac.yml")] }),
        release({ tag_name: "v0.2.1-canary.1", prerelease: true }),
      ]),
    ).toBeNull();
  });

  it("ignores drafts", () => {
    const build = resolveStableBuild([
      release({ tag_name: "v0.1.1", draft: true, published_at: "2026-08-17T00:00:00Z" }),
      release({ tag_name: "v0.1.0" }),
    ]);
    expect(build?.version).toBe("0.1.0");
  });

  it("skips releases without installable artifacts instead of offering an empty download", () => {
    const build = resolveStableBuild([
      release({
        tag_name: "v0.1.1",
        published_at: "2026-08-17T00:00:00Z",
        assets: [asset("latest-mac.yml", 550)],
      }),
      release({ tag_name: "v0.1.0" }),
    ]);
    expect(build?.version).toBe("0.1.0");
  });

  it("keeps only dmg/zip assets, dmg first, and labels the published arch", () => {
    const build = resolveStableBuild([release({ tag_name: "v0.1.0" })]);
    expect(build?.artifacts).toEqual([
      {
        kind: "dmg",
        arch: "Apple Silicon",
        name: "Volli-Code-0.1.0-arm64.dmg",
        url: "https://github.com/hussainph/volli-code/releases/download/tag/Volli-Code-0.1.0-arm64.dmg",
        sizeBytes: 122_097_864,
      },
      {
        kind: "zip",
        arch: "Apple Silicon",
        name: "Volli-Code-0.1.0-arm64-mac.zip",
        url: "https://github.com/hussainph/volli-code/releases/download/tag/Volli-Code-0.1.0-arm64-mac.zip",
        sizeBytes: 121_929_170,
      },
    ]);
  });

  it("sorts multi-arch artifacts Apple Silicon, Universal, Intel, then unknown", () => {
    const build = resolveStableBuild([
      release({
        tag_name: "v0.2.0",
        prerelease: false,
        assets: [
          asset("Volli-Code-0.2.0.dmg"),
          asset("Volli-Code-0.2.0-x64.dmg"),
          asset("Volli-Code-0.2.0-universal.dmg"),
          asset("Volli-Code-0.2.0-arm64.dmg"),
        ],
      }),
    ]);
    expect(build?.artifacts.map((a) => a.arch)).toEqual([
      "Apple Silicon",
      "Universal",
      "Intel",
      null,
    ]);
  });

  it("keeps only the newest release", () => {
    const build = resolveStableBuild([
      release({ tag_name: "v0.2.0", prerelease: false, published_at: "2026-10-01T00:00:00Z" }),
      release({ tag_name: "v0.1.0", prerelease: false, published_at: "2026-09-01T00:00:00Z" }),
    ]);
    expect(build?.version).toBe("0.2.0");
  });

  it("treats a missing published_at as oldest", () => {
    const build = resolveStableBuild([
      release({ tag_name: "v0.0.9", published_at: null }),
      release({ tag_name: "v0.1.0" }),
    ]);
    expect(build?.version).toBe("0.1.0");
  });

  it("returns null for an empty list", () => {
    expect(resolveStableBuild([])).toBeNull();
  });
});

describe("primaryArtifact", () => {
  it("prefers the dmg over the zip", () => {
    const build = resolveStableBuild([release({ tag_name: "v0.1.0" })]);
    expect(build && primaryArtifact(build)?.kind).toBe("dmg");
  });

  it("falls back to the first artifact when no dmg was published", () => {
    const build = resolveStableBuild([
      release({
        tag_name: "v0.1.0",
        assets: [asset("Volli-Code-0.1.0-arm64-mac.zip")],
      }),
    ]);
    expect(build && primaryArtifact(build)?.kind).toBe("zip");
  });

  // resolveStableBuild never hands back an artifact-less build, so this build is
  // constructed by hand. The case still has to answer: the signature promises
  // `| null`, and download.astro marks its primary row by identity
  // (`artifact === primary`). Returning undefined there would quietly make the
  // comparison lie rather than say "nothing is primary".
  it("returns null when the build has no artifacts", () => {
    expect(
      primaryArtifact({
        version: "0.1.0",
        releaseUrl: "https://github.com/hussainph/volli-code/releases/tag/v0.1.0",
        publishedAt: null,
        artifacts: [],
      }),
    ).toBeNull();
  });
});

describe("formatBytes", () => {
  it("rounds to whole megabytes", () => {
    expect(formatBytes(122_097_864)).toBe("122 MB");
  });

  it("switches to gigabytes above 1000 MB", () => {
    expect(formatBytes(1_250_000_000)).toBe("1.3 GB");
  });
});

describe("formatPublishedDate", () => {
  it("formats an ISO timestamp as a short date", () => {
    expect(formatPublishedDate("2026-08-16T23:08:03Z")).toBe("Aug 16, 2026");
  });

  it("returns null for missing or invalid input", () => {
    expect(formatPublishedDate(null)).toBeNull();
    expect(formatPublishedDate("not-a-date")).toBeNull();
  });
});

describe("isMacPlatform", () => {
  it("recognises macOS via platform or user agent", () => {
    expect(isMacPlatform("", "MacIntel")).toBe(true);
    expect(isMacPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", "")).toBe(true);
  });

  it("rejects other platforms", () => {
    expect(isMacPlatform("Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "Win32")).toBe(false);
    expect(isMacPlatform("Mozilla/5.0 (X11; Linux x86_64)", "Linux x86_64")).toBe(false);
  });
});
