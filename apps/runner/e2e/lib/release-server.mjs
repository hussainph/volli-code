/**
 * A local "GitHub release" for the BYO runner acceptance lane (VC-1043): the
 * runner's release assets (C4) served from loopback in GitHub's own layout,
 * so `install.sh --release-base <url>` and an update's absolute manifest URLs
 * exercise exactly the paths a real release has.
 *
 *   GET /<owner>/<repo>/releases/download/<tag>/<asset>
 *   GET /<owner>/<repo>/releases/latest/download/<asset>   (newest non-prerelease)
 *   GET /api/v3/repos/<owner>/<repo>/releases              (the public Releases API shape)
 *   GET /api/v3/repos/<owner>/<repo>/releases/latest
 *
 * {@link ReleaseServer.publish} adds a release from files or bytes. A draft
 * is listed by nothing, as on GitHub's unauthenticated API. HEAD and GET only;
 * every request is recorded for evidence.
 *
 * It listens on its own loopback port, or is **mounted** on another server
 * (`mountedAt(origin)` + {@link ReleaseServer.handle}): the lane mounts it on
 * the fake GitHub, so release downloads come from the same HTTPS origin as
 * the repository, as on github.com.
 */

import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { basename } from "node:path";

const DOWNLOAD = /^\/([^/]+)\/([^/]+)\/releases\/download\/([^/]+)\/([^/]+)$/u;
const LATEST = /^\/([^/]+)\/([^/]+)\/releases\/latest\/download\/([^/]+)$/u;
const API_LIST = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/releases(\/latest)?$/u;

const ASSET_NAME = /^[A-Za-z0-9._-]+$/u;

/** The runner tarball's name (C4): `volli-runner-<version>-linux-<arch>.tar.gz`. */
const RUNNER_TARBALL = /^volli-runner-(.+)-linux-(x64|arm64)\.tar\.gz$/u;

/**
 * The version a C4 asset set carries, read from its tarball names (both
 * targets must be present and agree).
 */
export function assetSetVersion(names) {
  const found = names.flatMap((name) => {
    const match = RUNNER_TARBALL.exec(name);
    return match ? [{ version: match[1], arch: match[2] }] : [];
  });
  const arches = found.map((entry) => entry.arch).toSorted();
  const versions = new Set(found.map((entry) => entry.version));
  if (arches.join(",") !== "arm64,x64" || versions.size !== 1) {
    throw new Error(
      `need both linux tarballs of one version, found: ${names.join(", ") || "none"}`,
    );
  }
  return [...versions][0];
}

function contentType(name) {
  if (name.endsWith(".json")) return "application/json";
  if (name.endsWith(".sh")) return "text/x-shellscript";
  if (name.endsWith(".tar.gz")) return "application/gzip";
  return "application/octet-stream";
}

export class ReleaseServer {
  /** @type {{ tag: string, prerelease: boolean, draft: boolean, publishedAt: string, assets: Map<string, Buffer> }[]} */
  releases = [];
  requests = [];
  #server = null;
  #mountedOrigin = null;

  constructor({ owner = "hussainph", repo = "volli-code", host = "127.0.0.1" } = {}) {
    this.owner = owner;
    this.repo = repo;
    this.host = host;
  }

  /** Serve under another server's `origin`; that server calls {@link handle}. */
  mountedAt(origin) {
    this.#mountedOrigin = origin.replace(/\/+$/u, "");
    return this;
  }

  get origin() {
    if (this.#mountedOrigin !== null) return this.#mountedOrigin;
    if (this.#server === null) throw new Error("the release server is not listening");
    return `http://${this.host}:${this.#server.address().port}`;
  }

  /** Whether `pathname` is one of this repository's release paths. */
  serves(pathname) {
    const repoOf = (match) => match !== null && match[1] === this.owner && match[2] === this.repo;
    return [DOWNLOAD, LATEST, API_LIST].some((pattern) => repoOf(pattern.exec(pathname)));
  }

  /** Answer `request` when it is a release path; `false` (untouched) otherwise. */
  handle(request, response) {
    const url = new URL(request.url ?? "/", "http://release.invalid");
    if (!this.serves(url.pathname)) return false;
    this.#handle(request, response);
    return true;
  }

  /** The directory a tag's assets live under: what `--release-base` takes. */
  downloadBase(tag) {
    return `${this.origin}/${this.owner}/${this.repo}/releases/download/${tag}`;
  }

  /** One asset's absolute URL, as a C4 manifest's `targets[].url` names it. */
  assetUrl(tag, name) {
    return `${this.downloadBase(tag)}/${name}`;
  }

  /** What `GITHUB_API_URL`-style pollers read (the Releases API root). */
  get apiUrl() {
    return `${this.origin}/api/v3`;
  }

  /**
   * Publish `tag` with `assets`: a map of asset name → a file path (a string)
   * or the bytes themselves (a Buffer).
   * Re-publishing a tag replaces it (GitHub needs a delete first; the lane
   * never does it, but a test may).
   */
  publish(tag, assets, { prerelease = false, draft = false } = {}) {
    const files = new Map();
    for (const [name, source] of Object.entries(assets)) {
      if (!ASSET_NAME.test(name)) throw new Error(`not an asset name: ${name}`);
      files.set(name, Buffer.isBuffer(source) ? source : readFileSync(source));
    }
    this.releases = this.releases.filter((release) => release.tag !== tag);
    const release = {
      tag,
      prerelease,
      draft,
      publishedAt: new Date().toISOString(),
      assets: files,
    };
    this.releases.push(release);
    return release;
  }

  /** Add one file to an existing release (named after the file unless `name` is given). */
  attach(tag, path, name = basename(path)) {
    const release = this.releases.find((candidate) => candidate.tag === tag);
    if (release === undefined) throw new Error(`no release ${tag}`);
    release.assets.set(name, readFileSync(path));
  }

  /** The newest published non-prerelease, as `releases/latest` answers. */
  latest() {
    return this.releases.findLast((release) => !release.draft && !release.prerelease) ?? null;
  }

  #apiRelease(release) {
    return {
      tag_name: release.tag,
      name: release.tag,
      draft: release.draft,
      prerelease: release.prerelease,
      published_at: release.publishedAt,
      html_url: `${this.origin}/${this.owner}/${this.repo}/releases/tag/${release.tag}`,
      assets: [...release.assets].map(([name, bytes]) => ({
        name,
        size: bytes.length,
        browser_download_url: this.assetUrl(release.tag, name),
      })),
    };
  }

  #send(request, response, status, body, type) {
    response.writeHead(status, { "content-type": type, "content-length": body.length });
    response.end(request.method === "HEAD" ? undefined : body);
  }

  #handle(request, response) {
    const url = new URL(request.url ?? "/", "http://release.invalid");
    const record = { at: Date.now(), method: request.method, path: url.pathname };
    this.requests.push(record);
    const notFound = () =>
      this.#send(request, response, 404, Buffer.from("Not Found\n"), "text/plain");
    if (request.method !== "GET" && request.method !== "HEAD") {
      record.status = 405;
      return this.#send(request, response, 405, Buffer.from(""), "text/plain");
    }
    const ours = (owner, repo) => owner === this.owner && repo === this.repo;
    let release = null;
    let asset = null;
    let match = DOWNLOAD.exec(url.pathname);
    if (match && ours(match[1], match[2])) {
      release = this.releases.find((candidate) => candidate.tag === match[3] && !candidate.draft);
      asset = match[4];
    }
    match = LATEST.exec(url.pathname);
    if (match && ours(match[1], match[2])) {
      release = this.latest();
      asset = match[3];
    }
    if (asset !== null) {
      const bytes = release?.assets.get(asset);
      record.status = bytes === undefined ? 404 : 200;
      return bytes === undefined
        ? notFound()
        : this.#send(request, response, 200, bytes, contentType(asset));
    }
    match = API_LIST.exec(url.pathname);
    if (match && ours(match[1], match[2])) {
      const visible = this.releases.filter((candidate) => !candidate.draft);
      const value = match[3] ? this.latest() : visible.toReversed();
      record.status = value === null ? 404 : 200;
      if (value === null) return notFound();
      const body = Buffer.from(
        JSON.stringify(
          Array.isArray(value)
            ? value.map((entry) => this.#apiRelease(entry))
            : this.#apiRelease(value),
        ),
      );
      return this.#send(request, response, 200, body, "application/json");
    }
    record.status = 404;
    return notFound();
  }

  async listen(port = 0) {
    this.#server = createServer((request, response) => this.#handle(request, response));
    await new Promise((done, fail) => {
      this.#server.once("error", fail);
      this.#server.listen(port, this.host, done);
    });
    return this;
  }

  async close() {
    if (this.#server === null) return;
    const server = this.#server;
    server.closeAllConnections?.();
    await new Promise((done) => server.close(() => done()));
  }
}

export function startReleaseServer(options = {}) {
  return new ReleaseServer(options).listen(options.port ?? 0);
}
