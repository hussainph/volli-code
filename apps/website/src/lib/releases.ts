// Pure interpretation of the GitHub Releases feed for the download surface.
// Input is the JSON shape of `GET /repos/{owner}/{repo}/releases` — the page
// never templates asset names or version strings itself, so a new release
// needs zero website edits (VC-62). Keep this module free of DOM and fetch:
// it is unit-tested, the page's script stays a thin renderer.
//
// ONE CHANNEL (VC-64). The site used to split Stable and Canary, which for the
// alpha meant a permanently empty Stable card sitting above the only build that
// actually exists. The public surface now offers exactly one build — the newest
// one published — and says plainly whether it is a prerelease. Canary hunting
// stays possible through the "all releases" link; it is not a website feature.

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

export interface AlphaBuild {
  /** Version string without the tag's leading `v`, e.g. `0.1.0-canary.9`. */
  version: string;
  releaseUrl: string;
  publishedAt: string | null;
  /**
   * Whether GitHub marks this release a prerelease. The page states this rather
   * than hiding it: during the alpha every published build is expected to carry
   * it, and claiming otherwise would be the contradiction VC-64 exists to end.
   */
  prerelease: boolean;
  artifacts: DownloadArtifact[];
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

function toAlphaBuild(release: Release): AlphaBuild {
  return {
    version: release.tag_name.replace(/^v/, ""),
    releaseUrl: release.html_url,
    publishedAt: release.published_at,
    prerelease: release.prerelease,
    artifacts: releaseArtifacts(release),
  };
}

function publishedTime(release: Release): number {
  return release.published_at ? Date.parse(release.published_at) : 0;
}

/**
 * Resolve the one build the alpha offers: the newest published, non-draft
 * release that actually carries an installable artifact.
 *
 * Draft and artifact-less releases are skipped rather than presented as an
 * empty download, and the prerelease flag deliberately does NOT filter — during
 * the alpha every build is a prerelease, so filtering them out would leave the
 * page with nothing to offer. The flag is reported instead.
 */
export function resolveAlphaBuild(releases: Release[]): AlphaBuild | null {
  const published = releases
    .filter((release) => !release.draft)
    .toSorted((a, b) => publishedTime(b) - publishedTime(a));

  for (const release of published) {
    const build = toAlphaBuild(release);
    if (build.artifacts.length === 0) continue;
    return build;
  }
  return null;
}

/**
 * The one artifact a visitor should press: the Apple silicon dmg when it is
 * there, otherwise the first artifact published. Everything else stays
 * reachable in the secondary list — one primary, never two.
 */
export function primaryArtifact(build: AlphaBuild): DownloadArtifact | null {
  return build.artifacts.find((artifact) => artifact.kind === "dmg") ?? build.artifacts[0] ?? null;
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
