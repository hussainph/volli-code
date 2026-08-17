// Pure interpretation of the GitHub Releases feed for the download surface.
// Input is the JSON shape of `GET /repos/{owner}/{repo}/releases` — the page
// never templates asset names or version strings itself, so a new release
// needs zero website edits (VC-62). Keep this module free of DOM and fetch:
// it is unit-tested, the page's script stays a thin renderer.

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

export interface Release {
  tag_name: string;
  html_url: string;
  draft: boolean;
  prerelease: boolean;
  published_at: string | null;
  assets: ReleaseAsset[];
}

export type Arch = "Apple Silicon" | "Intel" | "Universal";

export interface DownloadArtifact {
  kind: "dmg" | "zip";
  arch: Arch | null;
  name: string;
  url: string;
  sizeBytes: number;
}

export interface ChannelBuild {
  /** Version string without the tag's leading `v`, e.g. `0.1.0-canary.5`. */
  version: string;
  releaseUrl: string;
  publishedAt: string | null;
  artifacts: DownloadArtifact[];
}

export interface DownloadFeed {
  stable: ChannelBuild | null;
  canary: ChannelBuild | null;
}

const ARTIFACT_KINDS: Record<string, DownloadArtifact["kind"]> = {
  ".dmg": "dmg",
  ".zip": "zip",
};

function artifactKind(name: string): DownloadArtifact["kind"] | null {
  // Extension match keeps blockmaps (`….dmg.blockmap`, and the dot-named
  // `Volli.Code-…zip.blockmap`) and `latest-mac.yml` out without a denylist.
  const lower = name.toLowerCase();
  for (const [ext, kind] of Object.entries(ARTIFACT_KINDS)) {
    if (lower.endsWith(ext)) return kind;
  }
  return null;
}

function artifactArch(name: string): Arch | null {
  const lower = name.toLowerCase();
  if (lower.includes("universal")) return "Universal";
  if (lower.includes("arm64")) return "Apple Silicon";
  if (lower.includes("x64") || lower.includes("intel")) return "Intel";
  return null;
}

const KIND_ORDER: Record<DownloadArtifact["kind"], number> = { dmg: 0, zip: 1 };
const ARCH_ORDER: Record<Arch, number> = { "Apple Silicon": 0, Universal: 1, Intel: 2 };

function archRank(arch: Arch | null): number {
  return arch === null ? ARCH_ORDER.Intel + 1 : ARCH_ORDER[arch];
}

function releaseArtifacts(release: Release): DownloadArtifact[] {
  const artifacts: DownloadArtifact[] = [];
  for (const asset of release.assets) {
    const kind = artifactKind(asset.name);
    if (!kind) continue;
    artifacts.push({
      kind,
      arch: artifactArch(asset.name),
      name: asset.name,
      url: asset.browser_download_url,
      sizeBytes: asset.size,
    });
  }
  artifacts.sort((a, b) => {
    if (KIND_ORDER[a.kind] !== KIND_ORDER[b.kind]) return KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
    return archRank(a.arch) - archRank(b.arch);
  });
  return artifacts;
}

function toChannelBuild(release: Release): ChannelBuild {
  return {
    version: release.tag_name.replace(/^v/, ""),
    releaseUrl: release.html_url,
    publishedAt: release.published_at,
    artifacts: releaseArtifacts(release),
  };
}

function publishedTime(release: Release): number {
  return release.published_at ? Date.parse(release.published_at) : 0;
}

/**
 * Resolve the latest downloadable build per channel. A channel's latest is the
 * newest published, non-draft release of that channel that actually carries an
 * installable artifact — a release with only metadata assets is skipped rather
 * than presented as an empty download.
 */
export function resolveDownloadFeed(releases: Release[]): DownloadFeed {
  const published = releases
    .filter((release) => !release.draft)
    .toSorted((a, b) => publishedTime(b) - publishedTime(a));

  let stable: ChannelBuild | null = null;
  let canary: ChannelBuild | null = null;
  for (const release of published) {
    const channel = release.prerelease ? "canary" : "stable";
    if (channel === "stable" && stable) continue;
    if (channel === "canary" && canary) continue;
    const build = toChannelBuild(release);
    if (build.artifacts.length === 0) continue;
    if (channel === "stable") stable = build;
    else canary = build;
    if (stable && canary) break;
  }
  return { stable, canary };
}

/**
 * Which channel carries the page's single primary download emphasis: stable
 * when it exists, otherwise canary — two competing primaries would leave the
 * recommendation ambiguous.
 */
export function emphasizedChannel(feed: DownloadFeed): "stable" | "canary" | null {
  if (feed.stable) return "stable";
  if (feed.canary) return "canary";
  return null;
}

export function formatBytes(sizeBytes: number): string {
  const mb = sizeBytes / 1_000_000;
  if (mb >= 1000) return `${(mb / 1000).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}

export function formatPublishedDate(iso: string | null): string | null {
  if (iso === null) return null;
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return null;
  return new Date(time).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Platform-note helper: true when the visitor is plausibly on macOS. */
export function isMacPlatform(userAgent: string, platform: string): boolean {
  return /mac/i.test(platform) || /mac os x|macintosh/i.test(userAgent);
}
