/**
 * The privileged half of an update (n3 §9.2–9.3): `volli-runner update
 * apply`, run by the update unit when the daemon writes a request.
 *
 * In system mode it runs as root, because the releases are root's: the
 * daemon (as `volli`, like every agent) can ask, never install. In user mode
 * the same unit runs as the person, so both modes take one path.
 *
 * **Stage** (any time; nothing is interrupted): the requested release must be
 * newer than `current` and must not have failed here before. Its manifest
 * comes from a trusted release origin (`manifest.ts`) and must be for that
 * version; the tarball's size and SHA-256 must match it; the Sigstore bundle
 * must prove both came from the release workflow (`provenance.ts`), unless the
 * unit runs `--provenance sha-only` (test lanes). The tarball is extracted
 * beside the releases, probed with its own `bin/node`, then renamed into
 * `releases/<version>`.
 *
 * **Activate** (when the daemon has drained, or for an urgent update): the
 * staged release becomes `current` in one rename, the runner restarts, and
 * it must report `online` at that version from a new process within
 * {@link HEALTH_TIMEOUT_MS}. Otherwise `current` moves back, the runner
 * restarts on the release before, and the release is recorded as bad so it is
 * never staged again. Data is never rolled back: a binary rollback relies on
 * runner-local migrations staying readable by N−1.
 *
 * Every step leaves an outcome in the updater state (`files.ts`), which the
 * daemon reports to Volli.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { basename, join } from "node:path";

import { compareVersions } from "@volli/shared";

import type { RunnerStatus } from "../shell/runner-status";
import {
  readUpdateRequest,
  readUpdaterState,
  writeUpdaterState,
  type UpdateOutcome,
  type UpdateOutcomeKind,
  type UpdateRequest,
  type UpdaterState,
} from "./files";
import type { UpdateLayout } from "./layout";
import {
  isReleaseVersion,
  MANIFEST_ASSET,
  parseManifest,
  tarballName,
  targetFor,
  trustedUrl,
  UpdateRefusal,
} from "./manifest";
import type { ProvenanceVerifier } from "./provenance";

/** A new release must report online within this long, or it is rolled back. */
export const HEALTH_TIMEOUT_MS = 2 * 60 * 1000;
const HEALTH_POLL_MS = 2_000;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_BUNDLE_BYTES = 4 * 1024 * 1024;

/** What the applier reaches beyond the install root; the live ones are `live.ts`'s. */
export interface ApplyPorts {
  readonly arch: string;
  /** GET a small document, refusing one larger than `maxBytes`. */
  fetchText(url: string, maxBytes: number): Promise<string>;
  /** GET into `path`, refusing more than `maxBytes`; the bytes' SHA-256 (hex) and size. */
  download(url: string, path: string, maxBytes: number): Promise<{ sha256: string; size: number }>;
  readonly provenance: ProvenanceVerifier | null;
  /** Extract a `.tar.gz` into an existing, empty directory, as files owned by the extractor. */
  extract(tarball: string, into: string): Promise<void>;
  /** Run the release's own probes with its own `bin/node`; throws when this box cannot run it. */
  probe(releaseDir: string): Promise<void>;
  /** Restart the runner's unit. */
  restart(): Promise<void>;
  /** The daemon's status file, and whether a pid is alive. */
  readStatus(): RunnerStatus | null;
  alive(pid: number): boolean;
  now(): Date;
  sleep(ms: number): Promise<void>;
  log(line: string): void;
}

export interface ApplyOptions {
  readonly layout: UpdateLayout;
  /** Trusted release origins (`manifest.ts`), from the unit's command line. */
  readonly origins: readonly string[];
  readonly healthTimeoutMs?: number;
}

export type ApplyResult =
  | { readonly kind: "idle"; readonly why: string }
  | { readonly kind: "staged"; readonly version: string }
  | { readonly kind: "applied"; readonly version: string; readonly from: string }
  | {
      readonly kind: "refused" | "failed";
      readonly code: string;
      readonly message: string;
    }
  | {
      readonly kind: "rolled_back";
      readonly version: string;
      readonly to: string;
      readonly reason: string;
    };

/** The release `current` points at: `releases/<version>` → `<version>`; `null` when there is none. */
export function currentVersion(layout: UpdateLayout): string | null {
  let target: string;
  try {
    target = readlinkSync(layout.currentLink);
  } catch {
    return null;
  }
  const version = basename(target);
  return isReleaseVersion(version) ? version : null;
}

/** Points `current` at `releases/<version>` in one rename, so nothing ever sees it missing. */
export function pointCurrentAt(layout: UpdateLayout, version: string): void {
  const temporary = `${layout.currentLink}.${process.pid}.tmp`;
  rmSync(temporary, { force: true });
  symlinkSync(join("releases", version), temporary);
  renameSync(temporary, layout.currentLink);
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

class Run {
  state: UpdaterState;

  constructor(
    readonly ports: ApplyPorts,
    readonly options: ApplyOptions,
  ) {
    this.state = readUpdaterState(options.layout.stateFile);
  }

  get layout(): UpdateLayout {
    return this.options.layout;
  }

  save(patch: Partial<UpdaterState>): void {
    this.state = { ...this.state, ...patch };
    writeUpdaterState(this.layout.stateFile, this.state);
  }

  outcome(
    kind: UpdateOutcomeKind,
    version: string,
    fromVersion: string | null,
    reason: string | null,
  ): UpdateOutcome {
    return {
      id: randomUUID(),
      kind,
      version,
      fromVersion,
      reason,
      at: this.ports.now().toISOString(),
    };
  }

  record(request: UpdateRequest, patch: Partial<UpdaterState>, ...outcomes: UpdateOutcome[]): void {
    this.save({
      ...patch,
      handled: [...this.state.handled, request.id],
      outcomes: [...this.state.outcomes, ...outcomes],
    });
  }

  async stage(
    request: Extract<UpdateRequest, { phase: "stage" }>,
    running: string,
  ): Promise<ApplyResult> {
    const { version } = request;
    const { layout, origins } = this.options;
    const manifestUrl = trustedUrl(request.manifestUrl, origins, "manifest");
    if (!manifestUrl.endsWith(`/${MANIFEST_ASSET}`)) {
      throw new UpdateRefusal("untrusted_url", "The manifest URL does not name a runner manifest.");
    }
    const manifestText = await this.ports.fetchText(manifestUrl, MAX_MANIFEST_BYTES);
    const manifest = parseManifest(manifestText, version, origins);
    const target = targetFor(manifest, this.ports.arch);
    mkdirSync(layout.cacheDir, { recursive: true, mode: 0o700 });
    const tarball = join(layout.cacheDir, tarballName(version, target.arch));
    try {
      const got = await this.ports.download(target.url, tarball, target.size);
      if (got.size !== target.size || got.sha256 !== target.sha256) {
        throw new UpdateRefusal("checksum", `The ${version} tarball does not match its manifest.`);
      }
      if (this.ports.provenance !== null) {
        const bundle = await this.ports.fetchText(manifest.provenance.bundleUrl, MAX_BUNDLE_BYTES);
        await this.ports.provenance.verify(bundle, version, [
          { name: MANIFEST_ASSET, sha256: sha256(manifestText) },
          { name: tarballName(version, target.arch), sha256: target.sha256 },
        ]);
      }
      const staging = join(layout.releasesDir, `.${version}.staging`);
      rmSync(staging, { recursive: true, force: true });
      mkdirSync(staging, { recursive: true, mode: 0o755 });
      try {
        await this.ports.extract(tarball, staging);
        const top = `volli-runner-${version}-linux-${target.arch}`;
        const release = join(staging, top);
        if (
          readdirSync(staging).join("/") !== top ||
          !existsSync(join(release, "bin", "node")) ||
          !existsSync(join(release, "bin", "volli-runner"))
        ) {
          throw new UpdateRefusal("bad_tarball", `The ${version} tarball is not a runner release.`);
        }
        await this.ports.probe(release);
        const destination = join(layout.releasesDir, version);
        // A leftover of an earlier attempt; never `current`, which is older.
        rmSync(destination, { recursive: true, force: true });
        renameSync(release, destination);
      } finally {
        rmSync(staging, { recursive: true, force: true });
      }
    } finally {
      rmSync(tarball, { force: true });
    }
    this.record(
      request,
      { staged: version },
      this.outcome("update_staged", version, running, null),
    );
    return { kind: "staged", version };
  }

  async healthy(version: string, stalePid: number | null): Promise<boolean> {
    const deadline =
      this.ports.now().getTime() + (this.options.healthTimeoutMs ?? HEALTH_TIMEOUT_MS);
    for (;;) {
      const status = this.ports.readStatus();
      if (
        status !== null &&
        status.state === "online" &&
        status.version === version &&
        status.pid !== stalePid &&
        this.ports.alive(status.pid)
      ) {
        return true;
      }
      if (this.ports.now().getTime() >= deadline) return false;
      await this.ports.sleep(HEALTH_POLL_MS);
    }
  }

  async activate(
    request: Extract<UpdateRequest, { phase: "activate" }>,
    running: string,
  ): Promise<ApplyResult> {
    const { version } = request;
    const { layout } = this;
    if (this.state.staged !== version || !existsSync(join(layout.releasesDir, version))) {
      throw new UpdateRefusal("not_staged", `${version} is not staged.`);
    }
    const before = this.ports.readStatus();
    if (!request.urgent && before?.state !== "draining") {
      throw new UpdateRefusal(
        "not_draining",
        "The runner is not draining; it activates only when idle.",
      );
    }
    // Recorded before the switch, so a crash after it still knows the way back.
    this.save({ staged: null, previous: running });
    this.ports.log(`activating ${version} (was ${running})`);
    pointCurrentAt(layout, version);
    let reason = "health_timeout";
    try {
      await this.ports.restart();
      if (await this.healthy(version, before?.pid ?? null)) {
        this.record(request, {}, this.outcome("update_applied", version, running, null));
        this.prune([version, running]);
        // `update --now` is answered; a stale one would make the next update urgent.
        rmSync(layout.nowFile, { force: true });
        return { kind: "applied", version, from: running };
      }
    } catch (error) {
      reason = "restart_failed";
      this.ports.log(`restarting on ${version} failed: ${(error as Error).message}`);
    }
    this.ports.log(`${version} did not come online; rolling back to ${running}`);
    pointCurrentAt(layout, running);
    this.save({ bad: [...this.state.bad, version] });
    const stale = this.ports.readStatus()?.pid ?? null;
    let back = false;
    try {
      await this.ports.restart();
      back = await this.healthy(running, stale);
    } catch (error) {
      this.ports.log(`restarting on ${running} failed: ${(error as Error).message}`);
    }
    this.record(
      request,
      {},
      this.outcome("update_failed", version, running, reason),
      this.outcome("rolled_back", running, version, back ? null : "unhealthy_after_rollback"),
    );
    return { kind: "rolled_back", version, to: running, reason };
  }

  /** Keeps `keep` (the new release and its rollback) and drops older releases. */
  prune(keep: readonly string[]): void {
    for (const entry of readdirSync(this.layout.releasesDir)) {
      if (keep.includes(entry) || !isReleaseVersion(entry)) continue;
      const path = join(this.layout.releasesDir, entry);
      if (statSync(path).isDirectory()) rmSync(path, { recursive: true, force: true });
    }
  }
}

/**
 * Acts on the daemon's request once. A refusal or a failure is recorded as an
 * `update_failed` outcome for the requested version, and the request is
 * marked handled either way, so a bad request is not retried until the daemon
 * writes a new one.
 */
export async function applyUpdate(ports: ApplyPorts, options: ApplyOptions): Promise<ApplyResult> {
  const run = new Run(ports, options);
  let request: UpdateRequest | null;
  try {
    request = readUpdateRequest(options.layout.requestFile);
  } catch (error) {
    ports.log(`ignoring the update request: ${(error as Error).message}`);
    return { kind: "refused", code: "bad_request", message: (error as Error).message };
  }
  if (request === null) return { kind: "idle", why: "no request" };
  if (run.state.handled.includes(request.id)) return { kind: "idle", why: "already handled" };
  const running = currentVersion(options.layout);
  if (running === null) {
    // Nowhere to record it: there is no install root to update.
    const message = `No installed release is current in ${options.layout.installRoot}.`;
    ports.log(message);
    return { kind: "refused", code: "not_installed", message };
  }
  try {
    if (compareVersions(request.version, running) <= 0) {
      throw new UpdateRefusal(
        "downgrade",
        `${request.version} is not newer than the running ${running}; updates never downgrade.`,
      );
    }
    if (run.state.bad.includes(request.version)) {
      throw new UpdateRefusal(
        "known_bad",
        `${request.version} failed its health check here before.`,
      );
    }
    return request.phase === "stage"
      ? await run.stage(request, running)
      : await run.activate(request, running);
  } catch (error) {
    const refusal = error instanceof UpdateRefusal;
    const code = refusal ? error.code : "error";
    const message = (error as Error).message;
    ports.log(`update to ${request.version} ${refusal ? "refused" : "failed"}: ${message}`);
    run.record(request, {}, run.outcome("update_failed", request.version, running, code));
    return { kind: refusal ? "refused" : "failed", code, message };
  }
}
