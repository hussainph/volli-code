import { describe, expect, it } from "vite-plus/test";
import {
  emphasizedChannel,
  formatBytes,
  formatPublishedDate,
  isMacPlatform,
  resolveDownloadFeed,
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
function canaryAssets(version: string): ReleaseAsset[] {
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
    prerelease: true,
    published_at: "2026-08-16T23:08:03Z",
    assets: canaryAssets(overrides.tag_name.replace(/^v/, "")),
    ...overrides,
  };
}

describe("resolveDownloadFeed", () => {
  it("resolves the newest canary and reports no stable when only prereleases exist", () => {
    const feed = resolveDownloadFeed([
      release({ tag_name: "v0.1.0-canary.5", published_at: "2026-08-16T23:08:03Z" }),
      release({ tag_name: "v0.1.0-canary.4", published_at: "2026-08-16T13:12:50Z" }),
      release({ tag_name: "v0.1.0-canary.2", published_at: "2026-08-16T03:39:16Z" }),
    ]);
    expect(feed.stable).toBeNull();
    expect(feed.canary?.version).toBe("0.1.0-canary.5");
    expect(feed.canary?.releaseUrl).toBe(
      "https://github.com/hussainph/volli-code/releases/tag/v0.1.0-canary.5",
    );
  });

  it("orders by published date, not array order", () => {
    const feed = resolveDownloadFeed([
      release({ tag_name: "v0.1.0-canary.4", published_at: "2026-08-16T13:12:50Z" }),
      release({ tag_name: "v0.1.0-canary.5", published_at: "2026-08-16T23:08:03Z" }),
    ]);
    expect(feed.canary?.version).toBe("0.1.0-canary.5");
  });

  it("splits stable and canary channels by the prerelease flag", () => {
    const feed = resolveDownloadFeed([
      release({ tag_name: "v0.2.0-canary.1", published_at: "2026-09-02T00:00:00Z" }),
      release({ tag_name: "v0.1.0", prerelease: false, published_at: "2026-09-01T00:00:00Z" }),
    ]);
    expect(feed.stable?.version).toBe("0.1.0");
    expect(feed.canary?.version).toBe("0.2.0-canary.1");
  });

  it("ignores drafts", () => {
    const feed = resolveDownloadFeed([
      release({ tag_name: "v0.1.0-canary.6", draft: true, published_at: "2026-08-17T00:00:00Z" }),
      release({ tag_name: "v0.1.0-canary.5" }),
    ]);
    expect(feed.canary?.version).toBe("0.1.0-canary.5");
  });

  it("skips releases without installable artifacts instead of offering an empty download", () => {
    const feed = resolveDownloadFeed([
      release({
        tag_name: "v0.1.0-canary.6",
        published_at: "2026-08-17T00:00:00Z",
        assets: [asset("latest-mac.yml", 550)],
      }),
      release({ tag_name: "v0.1.0-canary.5" }),
    ]);
    expect(feed.canary?.version).toBe("0.1.0-canary.5");
  });

  it("keeps only dmg/zip assets, dmg first, and labels the published arch", () => {
    const feed = resolveDownloadFeed([release({ tag_name: "v0.1.0-canary.5" })]);
    expect(feed.canary?.artifacts).toEqual([
      {
        kind: "dmg",
        arch: "Apple Silicon",
        name: "Volli-Code-0.1.0-canary.5-arm64.dmg",
        url: "https://github.com/hussainph/volli-code/releases/download/tag/Volli-Code-0.1.0-canary.5-arm64.dmg",
        sizeBytes: 122_097_864,
      },
      {
        kind: "zip",
        arch: "Apple Silicon",
        name: "Volli-Code-0.1.0-canary.5-arm64-mac.zip",
        url: "https://github.com/hussainph/volli-code/releases/download/tag/Volli-Code-0.1.0-canary.5-arm64-mac.zip",
        sizeBytes: 121_929_170,
      },
    ]);
  });

  it("sorts multi-arch artifacts Apple Silicon, Universal, Intel, then unknown", () => {
    const feed = resolveDownloadFeed([
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
    expect(feed.stable?.artifacts.map((a) => a.arch)).toEqual([
      "Apple Silicon",
      "Universal",
      "Intel",
      null,
    ]);
  });

  it("keeps only the newest release per channel", () => {
    const feed = resolveDownloadFeed([
      release({ tag_name: "v0.2.0", prerelease: false, published_at: "2026-10-01T00:00:00Z" }),
      release({ tag_name: "v0.1.0", prerelease: false, published_at: "2026-09-01T00:00:00Z" }),
    ]);
    expect(feed.stable?.version).toBe("0.2.0");
  });

  it("resolves both channels even when the newest canary predates stable", () => {
    const feed = resolveDownloadFeed([
      release({ tag_name: "v0.1.0", prerelease: false, published_at: "2026-09-05T00:00:00Z" }),
      release({ tag_name: "v0.1.0-canary.5", published_at: "2026-08-16T23:08:03Z" }),
    ]);
    expect(feed.stable?.version).toBe("0.1.0");
    expect(feed.canary?.version).toBe("0.1.0-canary.5");
  });

  it("treats a missing published_at as oldest", () => {
    const feed = resolveDownloadFeed([
      release({ tag_name: "v0.1.0-canary.3", published_at: null }),
      release({ tag_name: "v0.1.0-canary.5" }),
    ]);
    expect(feed.canary?.version).toBe("0.1.0-canary.5");
  });

  it("returns an empty feed for an empty list", () => {
    expect(resolveDownloadFeed([])).toEqual({ stable: null, canary: null });
  });
});

describe("emphasizedChannel", () => {
  it("prefers stable, falls back to canary, and yields null when empty", () => {
    const stable = resolveDownloadFeed([release({ tag_name: "v0.1.0", prerelease: false })]);
    const canaryOnly = resolveDownloadFeed([release({ tag_name: "v0.1.0-canary.5" })]);
    const both = resolveDownloadFeed([
      release({ tag_name: "v0.1.0", prerelease: false }),
      release({ tag_name: "v0.2.0-canary.1" }),
    ]);
    expect(emphasizedChannel(stable)).toBe("stable");
    expect(emphasizedChannel(canaryOnly)).toBe("canary");
    expect(emphasizedChannel(both)).toBe("stable");
    expect(emphasizedChannel({ stable: null, canary: null })).toBeNull();
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
