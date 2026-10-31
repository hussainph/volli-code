/**
 * The privileged half of an update (n3 §9.2–9.3): `volli-runner update
 * apply`, run by the update unit when the daemon writes a request, and once
 * at boot.
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
 * install says `sha-only` (test lanes). The tarball is extracted beside the
 * releases, must carry a `MANIFEST.json` for that version, is probed with its
 * own `bin/node`, then renamed into `releases/<version>-<revision>`.
 *
 * **Activate** (when the daemon has drained, or for an urgent update): the
 * staged release becomes `current` in one rename and the runner restarts.
 * Through {@link HEALTH_TIMEOUT_MS} the unit's main process must report
 * `online` at that version, and systemd must not restart it
 * {@link MAX_RESTARTS} times. Otherwise `current` moves back to exactly what
 * it was, the runner restarts on it, and the release is recorded as bad so it
 * is not staged again (unless the install's owner names it with `update --now
 * --to`). Data is never rolled back: a binary rollback relies on runner-local
 * migrations staying readable by N−1.
 *
 * An activation is written down before `current` moves; a run that finds one
 * unsettled (the unit was killed, the box rebooted) finishes its health check
 * or rolls it back before anything else.
 *
 * Which version a release is comes from its own `MANIFEST.json` (the
 * packager's), so the installer's directory names (`<version>-<revision>`)
 * and its absolute or relative `current` both read the same.
 *
 * Every step leaves an outcome in the updater state (`files.ts`), which the
 * daemon reports to Volli.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { compareVersions } from "@volli/shared";

import type { RunnerStatus } from "../shell/runner-status";
import {
  readNowRequest,
  readSmallFile,
  readUpdateRequest,
  readUpdaterState,
  writeUpdaterState,
  type Activation,
  type ReleaseRef,
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

/** A new release is watched this long after its restart before it is kept. */
export const HEALTH_TIMEOUT_MS = 2 * 60 * 1000;
/** As many automatic restarts in the health window fail it. */
export const MAX_RESTARTS = 3;
/** How many requests one run handles, should the daemon write more meanwhile. */
const MAX_REQUESTS_PER_RUN = 4;
const HEALTH_POLL_MS = 2_000;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_BUNDLE_BYTES = 4 * 1024 * 1024;

/** The runner's unit, as systemd sees it. */
export interface ServiceState {
  readonly mainPid: number;
  /** systemd's automatic restarts of the unit (`NRestarts`). */
  readonly restarts: number;
}

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
  /** The runner's unit as systemd reports it; `null` when it cannot say. */
  service(): Promise<ServiceState | null>;
  /** The daemon's status file if `owner` owns it (`files.ts`'s `readDaemonStatus`). */
  readStatus(owner: number): RunnerStatus | null;
  now(): Date;
  sleep(ms: number): Promise<void>;
  log(line: string): void;
}

export interface ApplyOptions {
  readonly layout: UpdateLayout;
  /** Trusted release origins (`manifest.ts`), from the install's `update.json`. */
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

export interface CurrentRelease extends ReleaseRef {
  /** `current`'s link target, exactly as written (relative or absolute). */
  readonly target: string;
}

const MANIFEST_FILE = "MANIFEST.json";

/** What a release directory's own `MANIFEST.json` says, or `null`. */
function releaseManifest(dir: string): { version: string; revision: unknown } | null {
  try {
    const text = readSmallFile(join(dir, MANIFEST_FILE), 64 * 1024);
    const row = JSON.parse(text ?? "null") as { version?: unknown; revision?: unknown } | null;
    return isReleaseVersion(row?.version) ? { version: row.version, revision: row.revision } : null;
  } catch {
    return null;
  }
}

/** The version a release directory's own `MANIFEST.json` names, or `null`. */
export function releaseVersion(dir: string): string | null {
  return releaseManifest(dir)?.version ?? null;
}

/** The release `current` points at; `null` when there is none this build can read. */
export function currentRelease(layout: UpdateLayout): CurrentRelease | null {
  let target: string;
  try {
    target = readlinkSync(layout.currentLink);
  } catch {
    return null;
  }
  const dir = resolve(dirname(layout.currentLink), target);
  const version = releaseVersion(dir);
  return version === null ? null : { version, name: basename(dir), target };
}

/** Points `current` at `target` in one rename, so nothing ever sees it missing. */
export function pointCurrentAt(layout: UpdateLayout, target: string): void {
  const temporary = `${layout.currentLink}.${process.pid}.tmp`;
  rmSync(temporary, { force: true });
  symlinkSync(target, temporary);
  renameSync(temporary, layout.currentLink);
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** `<version>-<revision>`, as the installer names a release; `<version>` without a revision. */
function releaseName(version: string, revision: unknown): string {
  return typeof revision === "string" && /^[0-9a-f]{7,40}$/u.test(revision)
    ? `${version}-${revision.slice(0, 12)}`
    : version;
}

class Run {
  state: UpdaterState;
  /** The data dir's owner: the account whose request and status files are believed. */
  readonly owner: number | null;

  constructor(
    readonly ports: ApplyPorts,
    readonly options: ApplyOptions,
  ) {
    this.owner = dataDirOwner(options.layout);
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

  record(
    request: UpdateRequest | null,
    patch: Partial<UpdaterState>,
    ...outcomes: UpdateOutcome[]
  ): void {
    this.save({
      ...patch,
      handled: request === null ? this.state.handled : [...this.state.handled, request.id],
      outcomes: [...this.state.outcomes, ...outcomes],
    });
  }

  async stage(
    request: Extract<UpdateRequest, { phase: "stage" }>,
    running: CurrentRelease,
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
    let name: string;
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
          !existsSync(join(release, "bin", "volli-runner")) ||
          releaseManifest(release)?.version !== version
        ) {
          throw new UpdateRefusal("bad_tarball", `The ${version} tarball is not a runner release.`);
        }
        await this.ports.probe(release);
        name = releaseName(version, releaseManifest(release)!.revision);
        const destination = join(layout.releasesDir, name);
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
      { staged: { version, name } },
      this.outcome("update_staged", version, running.version, null),
    );
    return { kind: "staged", version };
  }

  /**
   * Watches the unit for the whole health window: its main process must say
   * `online` at `version` when the window ends, and systemd must not have
   * restarted it {@link MAX_RESTARTS} times on the way.
   */
  async healthy(version: string): Promise<boolean> {
    const deadline =
      this.ports.now().getTime() + (this.options.healthTimeoutMs ?? HEALTH_TIMEOUT_MS);
    const before = await this.ports.service();
    for (;;) {
      const service = await this.ports.service();
      if (service === null || before === null) return false;
      if (service.restarts - before.restarts >= MAX_RESTARTS) return false;
      if (this.ports.now().getTime() >= deadline) {
        const status = this.owner === null ? null : this.ports.readStatus(this.owner);
        return (
          status !== null &&
          status.state === "online" &&
          status.version === version &&
          service.mainPid > 0 &&
          status.pid === service.mainPid
        );
      }
      await this.ports.sleep(HEALTH_POLL_MS);
    }
  }

  /** Restarts and waits for `version`; a failed restart is an unhealthy one. */
  async restartInto(version: string): Promise<{ healthy: boolean; reason: string }> {
    try {
      await this.ports.restart();
    } catch (error) {
      this.ports.log(`restarting on ${version} failed: ${(error as Error).message}`);
      return { healthy: false, reason: "restart_failed" };
    }
    return { healthy: await this.healthy(version), reason: "health_timeout" };
  }

  /** The new release stays: bookkeeping that never undoes it. */
  keep(request: UpdateRequest | null, activation: Activation): ApplyResult {
    this.record(
      request,
      {
        activating: null,
        bad: this.state.bad.filter((version) => version !== activation.version),
      },
      this.outcome("update_applied", activation.version, activation.fromVersion, null),
    );
    try {
      this.prune([activation.name, basename(activation.fromTarget)]);
      // `update --now` is answered; a stale one would make the next update urgent.
      rmSync(this.layout.nowFile, { force: true });
    } catch (error) {
      this.ports.log(`cleaning up old releases failed: ${(error as Error).message}`);
    }
    return { kind: "applied", version: activation.version, from: activation.fromVersion };
  }

  /** `current` back to exactly what it was; the release is marked bad. */
  async rollBack(
    request: UpdateRequest | null,
    activation: Activation,
    reason: string,
  ): Promise<ApplyResult> {
    const { version, fromVersion } = activation;
    this.ports.log(`${version} did not stay online (${reason}); rolling back to ${fromVersion}`);
    pointCurrentAt(this.layout, activation.fromTarget);
    this.save({ bad: [...new Set([...this.state.bad, version])] });
    const back = await this.restartInto(fromVersion);
    this.record(
      request,
      { activating: null },
      this.outcome("update_failed", version, fromVersion, reason),
      this.outcome(
        "rolled_back",
        fromVersion,
        version,
        back.healthy ? null : "unhealthy_after_rollback",
      ),
    );
    return { kind: "rolled_back", version, to: fromVersion, reason };
  }

  async activate(
    request: Extract<UpdateRequest, { phase: "activate" }>,
    running: CurrentRelease,
  ): Promise<ApplyResult> {
    const { version } = request;
    const { layout } = this;
    const staged = this.state.staged;
    if (staged?.version !== version || !existsSync(join(layout.releasesDir, staged.name))) {
      throw new UpdateRefusal("not_staged", `${version} is not staged.`);
    }
    if (!request.urgent && this.ports.readStatus(this.owner!)?.state !== "draining") {
      throw new UpdateRefusal(
        "not_draining",
        "The runner is not draining; it activates only when idle.",
      );
    }
    const activation: Activation = {
      version,
      name: staged.name,
      fromTarget: running.target,
      fromVersion: running.version,
    };
    // Written before the switch, so a crash after it is finished or undone.
    this.save({ staged: null, activating: activation, previous: running.target });
    this.ports.log(`activating ${version} (was ${running.version})`);
    pointCurrentAt(layout, join("releases", staged.name));
    const result = await this.restartInto(version);
    return result.healthy
      ? this.keep(request, activation)
      : this.rollBack(request, activation, result.reason);
  }

  /** An activation a killed run left unsettled: finish its health check, or undo it. */
  async recover(activation: Activation): Promise<ApplyResult> {
    this.ports.log(`settling an interrupted activation of ${activation.version}`);
    const current = currentRelease(this.layout);
    if (current?.name !== activation.name) {
      pointCurrentAt(this.layout, activation.fromTarget);
      this.record(
        null,
        { activating: null },
        this.outcome("update_failed", activation.version, activation.fromVersion, "interrupted"),
      );
      return {
        kind: "failed",
        code: "interrupted",
        message: `The activation of ${activation.version} was interrupted.`,
      };
    }
    return (await this.healthy(activation.version))
      ? this.keep(null, activation)
      : this.rollBack(null, activation, "health_timeout");
  }

  /** Keeps `keep` (the new release and its rollback) and drops older releases. */
  prune(keep: readonly string[]): void {
    for (const entry of readdirSync(this.layout.releasesDir)) {
      const path = join(this.layout.releasesDir, entry);
      if (keep.includes(entry) || entry.startsWith(".") || releaseVersion(path) === null) continue;
      rmSync(path, { recursive: true, force: true });
    }
  }

  /** One request, refused or failed into an `update_failed` outcome. */
  async handle(request: UpdateRequest, running: CurrentRelease): Promise<ApplyResult> {
    try {
      if (compareVersions(request.version, running.version) <= 0) {
        throw new UpdateRefusal(
          "downgrade",
          `${request.version} is not newer than the running ${running.version}; updates never downgrade.`,
        );
      }
      if (this.state.bad.includes(request.version) && !this.ownerNamed(request.version)) {
        throw new UpdateRefusal(
          "known_bad",
          `${request.version} failed its health check here before; \`volli-runner update --now --to ${request.version}\` tries it again.`,
        );
      }
      return request.phase === "stage"
        ? await this.stage(request, running)
        : await this.activate(request, running);
    } catch (error) {
      const refusal = error instanceof UpdateRefusal;
      const code = refusal ? error.code : "error";
      const message = (error as Error).message;
      this.ports.log(`update to ${request.version} ${refusal ? "refused" : "failed"}: ${message}`);
      this.record(
        request,
        {},
        this.outcome("update_failed", request.version, running.version, code),
      );
      return { kind: refusal ? "refused" : "failed", code, message };
    }
  }

  /** Whether the install root's owner asked for `version` by name (`update --now --to`). */
  ownerNamed(version: string): boolean {
    try {
      return readNowRequest(this.layout.nowFile)?.version === version;
    } catch {
      return false;
    }
  }
}

/** The data dir's owner: the account whose request and status files are believed. */
function dataDirOwner(layout: UpdateLayout): number | null {
  try {
    return lstatSync(layout.dataDir).uid;
  } catch {
    return null;
  }
}

/**
 * Settles an interrupted activation, then acts on the daemon's requests,
 * each once, until none is new. A refusal or a failure is recorded as an
 * `update_failed` outcome for the requested version, and the request is
 * marked handled either way, so a bad request is not retried until the
 * daemon writes a new one.
 */
export async function applyUpdate(ports: ApplyPorts, options: ApplyOptions): Promise<ApplyResult> {
  const run = new Run(ports, options);
  let result: ApplyResult = { kind: "idle", why: "no request" };
  if (run.state.activating !== null) result = await run.recover(run.state.activating);
  const { owner } = run;
  for (let handled = 0; handled < MAX_REQUESTS_PER_RUN; handled += 1) {
    let request: UpdateRequest | null;
    try {
      request = owner === null ? null : readUpdateRequest(options.layout.requestFile, owner);
    } catch (error) {
      ports.log(`ignoring the update request: ${(error as Error).message}`);
      return { kind: "refused", code: "bad_request", message: (error as Error).message };
    }
    if (request === null) return result;
    if (run.state.handled.includes(request.id)) {
      return result.kind === "idle" ? { kind: "idle", why: "already handled" } : result;
    }
    const running = currentRelease(options.layout);
    if (running === null) {
      // Nowhere to record it: there is no install root to update.
      const message = `No installed release is current in ${options.layout.installRoot}.`;
      ports.log(message);
      return { kind: "refused", code: "not_installed", message };
    }
    result = await run.handle(request, running);
  }
  return result;
}
