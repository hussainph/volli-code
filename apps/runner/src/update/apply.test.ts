/**
 * The applier against a real install root in a temporary directory, with the
 * network, `tar`, the probes, systemd and the daemon's status file faked.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import type { RunnerStatus } from "../shell/runner-status";
import {
  applyUpdate,
  currentVersion,
  HEALTH_TIMEOUT_MS,
  pointCurrentAt,
  type ApplyPorts,
  type ApplyResult,
} from "./apply";
import {
  readUpdaterState,
  writeNowRequest,
  writeUpdateRequest,
  writeUpdaterState,
  EMPTY_STATE,
} from "./files";
import { updateLayout, type UpdateLayout } from "./layout";
import { MANIFEST_ASSET, tarballName, UpdateRefusal } from "./manifest";
import type { ProvenanceSubject } from "./provenance";

const ORIGIN = "https://releases.test/";
const manifestUrl = (version: string): string => `${ORIGIN}v${version}/${MANIFEST_ASSET}`;
const sha = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

let root: string;
let layout: UpdateLayout;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "runner-apply-"));
  layout = updateLayout("system", join(root, "opt"), join(root, "data"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function release(version: string): void {
  const dir = join(layout.releasesDir, version, "bin");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "node"), "");
  writeFileSync(join(dir, "volli-runner"), "");
}

function installed(version = "0.3.0"): void {
  release(version);
  pointCurrentAt(layout, version);
}

/** A published release: its manifest, tarball and bundle, by URL. */
function publish(
  documents: Map<string, string>,
  version: string,
  options: { tarball?: string; size?: number } = {},
): string {
  const tarball = options.tarball ?? `tarball-${version}`;
  const base = `${ORIGIN}v${version}/`;
  documents.set(`${base}${tarballName(version, "x64")}`, tarball);
  documents.set(`${base}volli-runner-provenance.sigstore.json`, `bundle-${version}`);
  const manifest = JSON.stringify({
    schemaVersion: 1,
    version,
    releaseTag: `v${version}`,
    minRunnerVersion: "0.3.0",
    minGlibc: "2.31",
    targets: [
      {
        platform: "linux",
        arch: "x64",
        url: `${base}${tarballName(version, "x64")}`,
        size: options.size ?? Buffer.byteLength(tarball),
        sha256: sha(`tarball-${version}`),
      },
    ],
    provenance: { bundleUrl: `${base}volli-runner-provenance.sigstore.json` },
  });
  documents.set(manifestUrl(version), manifest);
  return manifest;
}

const status = (patch: Partial<RunnerStatus>): RunnerStatus => ({
  v: 1,
  state: "online",
  pid: 100,
  version: "0.3.0",
  startedAt: "",
  updatedAt: "",
  dataDir: "",
  socketPath: "",
  link: null,
  backend: null,
  update: null,
  credentials: null,
  ...patch,
});

interface Harness {
  ports: ApplyPorts;
  documents: Map<string, string>;
  verified: { bundle: string; version: string; subjects: readonly ProvenanceSubject[] }[];
  restarts: number;
  logs: string[];
  /** What the status file says after `restarts` restarts. */
  statusAfter: (restarts: number) => RunnerStatus | null;
  extract: (into: string, version: string) => void;
  probeError: Error | null;
  restartError: (restarts: number) => Error | null;
  provenanceError: Error | null;
  dead: Set<number>;
}

function harness(options: { provenance?: boolean } = {}): Harness {
  let clock = 0;
  const h: Harness = {
    documents: new Map(),
    verified: [],
    restarts: 0,
    logs: [],
    statusAfter: () => status({ state: "draining" }),
    extract: (into, version) => {
      const dir = join(into, `volli-runner-${version}-linux-x64`, "bin");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "node"), "");
      writeFileSync(join(dir, "volli-runner"), "");
    },
    probeError: null,
    restartError: () => null,
    provenanceError: null,
    dead: new Set(),
    ports: undefined as unknown as ApplyPorts,
  };
  const get = (url: string): string => {
    const body = h.documents.get(url);
    if (body === undefined) throw new UpdateRefusal("download", `GET ${url} answered 404.`);
    return body;
  };
  h.ports = {
    arch: "x64",
    fetchText: async (url) => get(url),
    download: async (url, path) => {
      const body = get(url);
      writeFileSync(path, body);
      return { sha256: sha(body), size: Buffer.byteLength(body) };
    },
    provenance:
      options.provenance === false
        ? null
        : {
            verify: async (bundle, version, subjects) => {
              h.verified.push({ bundle, version, subjects });
              if (h.provenanceError !== null) throw h.provenanceError;
            },
          },
    extract: async (tarball, into) => {
      const name = basename(tarball);
      h.extract(into, name.replace(/^volli-runner-/u, "").replace(/-linux-x64\.tar\.gz$/u, ""));
    },
    probe: async () => {
      if (h.probeError !== null) throw h.probeError;
    },
    restart: async () => {
      h.restarts += 1;
      const error = h.restartError(h.restarts);
      if (error !== null) throw error;
    },
    readStatus: () => h.statusAfter(h.restarts),
    alive: (pid) => !h.dead.has(pid),
    now: () => new Date(clock),
    sleep: async (ms) => {
      clock += ms;
    },
    log: (line) => h.logs.push(line),
  };
  return h;
}

const apply = (h: Harness): Promise<ApplyResult> =>
  applyUpdate(h.ports, { layout, origins: [ORIGIN] });

function stageRequest(version: string, url = manifestUrl(version)) {
  return writeUpdateRequest(layout.requestFile, {
    phase: "stage",
    version,
    manifestUrl: url,
    urgent: false,
  });
}

const state = () => readUpdaterState(layout.stateFile);

describe("staging", () => {
  it("does nothing without a request, or with one it already handled", async () => {
    installed();
    const h = harness();
    expect(await apply(h)).toEqual({ kind: "idle", why: "no request" });
    publish(h.documents, "0.4.0");
    stageRequest("0.4.0");
    expect((await apply(h)).kind).toBe("staged");
    expect(await apply(h)).toEqual({ kind: "idle", why: "already handled" });
  });

  it("downloads, verifies, probes and puts a release beside the current one", async () => {
    installed();
    const h = harness();
    const manifest = publish(h.documents, "0.4.0");
    stageRequest("0.4.0");
    expect(await apply(h)).toEqual({ kind: "staged", version: "0.4.0" });
    expect(existsSync(join(layout.releasesDir, "0.4.0", "bin", "volli-runner"))).toBe(true);
    expect(readlinkSync(layout.currentLink)).toBe(join("releases", "0.3.0"));
    expect(readdirSync(layout.releasesDir).toSorted()).toEqual(["0.3.0", "0.4.0"]);
    expect(readdirSync(layout.cacheDir)).toEqual([]);
    expect(h.verified).toEqual([
      {
        bundle: "bundle-0.4.0",
        version: "0.4.0",
        subjects: [
          { name: MANIFEST_ASSET, sha256: sha(manifest) },
          { name: tarballName("0.4.0", "x64"), sha256: sha("tarball-0.4.0") },
        ],
      },
    ]);
    const after = state();
    expect(after.staged).toBe("0.4.0");
    expect(after.outcomes.map((o) => [o.kind, o.version, o.fromVersion, o.reason])).toEqual([
      ["update_staged", "0.4.0", "0.3.0", null],
    ]);
  });

  it("checks only the checksum when the install says sha-only", async () => {
    installed();
    const h = harness({ provenance: false });
    publish(h.documents, "0.4.0");
    stageRequest("0.4.0");
    expect((await apply(h)).kind).toBe("staged");
    expect(h.verified).toEqual([]);
  });

  it("replaces a leftover of an earlier attempt", async () => {
    installed();
    mkdirSync(join(layout.releasesDir, "0.4.0", "junk"), { recursive: true });
    const h = harness();
    publish(h.documents, "0.4.0");
    stageRequest("0.4.0");
    expect((await apply(h)).kind).toBe("staged");
    expect(existsSync(join(layout.releasesDir, "0.4.0", "junk"))).toBe(false);
  });

  async function refused(h: Harness, code: string): Promise<void> {
    const result = await apply(h);
    expect(result).toMatchObject({ kind: "refused", code });
    const last = state().outcomes.at(-1);
    expect(last).toMatchObject({ kind: "update_failed", reason: code });
    expect(readdirSync(layout.releasesDir).filter((entry) => entry !== "0.3.0")).toEqual([]);
  }

  it("refuses a forged request for a URL outside the release origin", async () => {
    installed();
    const h = harness();
    stageRequest("0.4.0", "https://evil.test/v0.4.0/volli-runner-manifest.json");
    await refused(h, "untrusted_url");
    stageRequest("0.4.0", `${ORIGIN}v0.4.0/evil.json`);
    await refused(h, "untrusted_url");
  });

  it("refuses a downgrade, a reinstall and a release that failed here", async () => {
    installed();
    const h = harness();
    stageRequest("0.2.0");
    await refused(h, "downgrade");
    stageRequest("0.3.0");
    await refused(h, "downgrade");
    writeUpdaterState(layout.stateFile, { ...state(), bad: ["0.4.0"] });
    stageRequest("0.4.0");
    await refused(h, "known_bad");
  });

  it("refuses without an installed release", async () => {
    const h = harness();
    stageRequest("0.4.0");
    const result = await apply(h);
    expect(result).toMatchObject({ kind: "refused", code: "not_installed" });
    expect(existsSync(layout.stateFile)).toBe(false);
  });

  it("refuses a tarball that does not match its manifest", async () => {
    installed();
    const h = harness();
    publish(h.documents, "0.4.0", { tarball: "tampered" });
    stageRequest("0.4.0");
    await refused(h, "checksum");
    publish(h.documents, "0.4.0", { size: 999 });
    stageRequest("0.4.0");
    await refused(h, "checksum");
  });

  it("refuses a release whose provenance does not verify", async () => {
    installed();
    const h = harness();
    h.provenanceError = new UpdateRefusal("provenance", "not ours");
    publish(h.documents, "0.4.0");
    stageRequest("0.4.0");
    await refused(h, "provenance");
  });

  it("refuses a tarball that is not a runner release", async () => {
    installed();
    const h = harness();
    publish(h.documents, "0.4.0");
    h.extract = (into) => mkdirSync(join(into, "something-else"));
    stageRequest("0.4.0");
    await refused(h, "bad_tarball");
    h.extract = (into, version) =>
      mkdirSync(join(into, `volli-runner-${version}-linux-x64`, "bin"), { recursive: true });
    stageRequest("0.4.0");
    await refused(h, "bad_tarball");
    h.extract = (into, version) => {
      const bin = join(into, `volli-runner-${version}-linux-x64`, "bin");
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, "node"), "");
    };
    stageRequest("0.4.0");
    await refused(h, "bad_tarball");
  });

  it("records a probe failure as a failed update", async () => {
    installed();
    const h = harness();
    h.probeError = new Error("better-sqlite3 needs GLIBC_2.38");
    publish(h.documents, "0.4.0");
    stageRequest("0.4.0");
    expect(await apply(h)).toEqual({
      kind: "failed",
      code: "error",
      message: "better-sqlite3 needs GLIBC_2.38",
    });
    expect(h.logs.at(-1)).toMatch(/failed: better-sqlite3/u);
  });

  it("ignores a request that is not one, without recording it", async () => {
    installed();
    mkdirSync(join(layout.dataDir, "update"), { recursive: true });
    writeFileSync(layout.requestFile, "{");
    const h = harness();
    expect(await apply(h)).toMatchObject({ kind: "refused", code: "bad_request" });
    expect(state()).toEqual(EMPTY_STATE);
  });
});

describe("activating", () => {
  async function staged(h: Harness): Promise<void> {
    installed();
    release("0.2.0");
    publish(h.documents, "0.4.0");
    stageRequest("0.4.0");
    expect((await apply(h)).kind).toBe("staged");
  }

  const activate = (urgent = false) =>
    writeUpdateRequest(layout.requestFile, { phase: "activate", version: "0.4.0", urgent });

  it("moves current, restarts, and keeps the new release once it is online", async () => {
    const h = harness();
    await staged(h);
    writeNowRequest(layout.nowFile, null, new Date(0));
    h.statusAfter = (restarts) =>
      restarts === 0
        ? status({ state: "draining", pid: 100 })
        : status({ state: "online", pid: 200, version: "0.4.0" });
    activate();
    expect(await apply(h)).toEqual({ kind: "applied", version: "0.4.0", from: "0.3.0" });
    expect(h.restarts).toBe(1);
    expect(currentVersion(layout)).toBe("0.4.0");
    // The rollback stays; older releases go.
    expect(readdirSync(layout.releasesDir).toSorted()).toEqual(["0.3.0", "0.4.0"]);
    expect(existsSync(layout.nowFile)).toBe(false);
    const after = state();
    expect(after).toMatchObject({ staged: null, previous: "0.3.0", bad: [] });
    expect(after.outcomes.at(-1)).toMatchObject({
      kind: "update_applied",
      version: "0.4.0",
      fromVersion: "0.3.0",
    });
  });

  it("keeps stray files in the releases directory when pruning", async () => {
    const h = harness();
    await staged(h);
    writeFileSync(join(layout.releasesDir, "0.1.0"), "a file");
    mkdirSync(join(layout.releasesDir, "notes"));
    h.statusAfter = (restarts) =>
      restarts === 0 ? status({ state: "draining" }) : status({ pid: 200, version: "0.4.0" });
    activate();
    expect((await apply(h)).kind).toBe("applied");
    expect(readdirSync(layout.releasesDir).toSorted()).toEqual([
      "0.1.0",
      "0.3.0",
      "0.4.0",
      "notes",
    ]);
  });

  it("waits for a draining runner unless the update is urgent", async () => {
    const h = harness();
    await staged(h);
    h.statusAfter = (restarts) =>
      restarts === 0 ? status({ state: "online" }) : status({ pid: 200, version: "0.4.0" });
    activate();
    expect(await apply(h)).toMatchObject({ kind: "refused", code: "not_draining" });
    expect(currentVersion(layout)).toBe("0.3.0");
    h.statusAfter = (restarts) => (restarts === 0 ? null : status({ pid: 200, version: "0.4.0" }));
    activate();
    expect(await apply(h)).toMatchObject({ kind: "refused", code: "not_draining" });
    activate(true);
    expect((await apply(h)).kind).toBe("applied");
  });

  it("refuses to activate what is not staged", async () => {
    installed();
    const h = harness();
    activate();
    expect(await apply(h)).toMatchObject({ kind: "refused", code: "not_staged" });
    writeUpdaterState(layout.stateFile, { ...state(), staged: "0.4.0" });
    activate();
    expect(await apply(h)).toMatchObject({ kind: "refused", code: "not_staged" });
  });

  it("rolls back a release that does not come online, and never stages it again", async () => {
    const h = harness();
    await staged(h);
    // The new release crash-loops: the status file keeps the old process's
    // last words, and then the old version's new process comes back.
    h.statusAfter = (restarts) =>
      restarts < 2
        ? status({ state: "draining", pid: 100 })
        : status({ state: "online", pid: 300, version: "0.3.0" });
    activate();
    expect(await apply(h)).toEqual({
      kind: "rolled_back",
      version: "0.4.0",
      to: "0.3.0",
      reason: "health_timeout",
    });
    expect(h.restarts).toBe(2);
    expect(currentVersion(layout)).toBe("0.3.0");
    const after = state();
    expect(after.bad).toEqual(["0.4.0"]);
    expect(
      after.outcomes.slice(-2).map((o) => [o.kind, o.version, o.fromVersion, o.reason]),
    ).toEqual([
      ["update_failed", "0.4.0", "0.3.0", "health_timeout"],
      ["rolled_back", "0.3.0", "0.4.0", null],
    ]);
    stageRequest("0.4.0");
    expect(await apply(h)).toMatchObject({ kind: "refused", code: "known_bad" });
  });

  it("does not take a stale or dead process for a healthy one", async () => {
    const h = harness();
    await staged(h);
    h.dead.add(200);
    h.statusAfter = (restarts) =>
      restarts === 0
        ? status({ state: "draining", pid: 100, version: "0.4.0" })
        : restarts === 1
          ? status({ state: "online", pid: 200, version: "0.4.0" })
          : status({ state: "online", pid: 300, version: "0.3.0" });
    activate();
    expect((await apply(h)).kind).toBe("rolled_back");
  });

  it("rolls back when the new release never writes a status at all", async () => {
    const h = harness();
    await staged(h);
    h.statusAfter = (restarts) =>
      restarts === 0
        ? status({ state: "draining" })
        : restarts === 1
          ? null
          : status({ pid: 300, version: "0.3.0" });
    activate();
    expect((await apply(h)).kind).toBe("rolled_back");
    expect(state().outcomes.at(-1)).toMatchObject({ kind: "rolled_back", reason: null });
  });

  it("says so when the rollback does not come online either", async () => {
    const h = harness();
    await staged(h);
    h.statusAfter = () => status({ state: "draining", pid: 100 });
    activate();
    expect((await apply(h)).kind).toBe("rolled_back");
    expect(state().outcomes.at(-1)).toMatchObject({
      kind: "rolled_back",
      reason: "unhealthy_after_rollback",
    });
  });

  it("rolls back when the restart itself fails", async () => {
    const h = harness();
    await staged(h);
    h.restartError = () => new Error("Failed to restart volli-runner.service");
    activate();
    expect(await apply(h)).toMatchObject({ kind: "rolled_back", reason: "restart_failed" });
    expect(currentVersion(layout)).toBe("0.3.0");
    expect(state().outcomes.at(-1)).toMatchObject({ reason: "unhealthy_after_rollback" });
    expect(h.logs.filter((line) => line.startsWith("restarting on"))).toHaveLength(2);
  });

  it("gives a new release the whole health window", async () => {
    const h = harness();
    await staged(h);
    let polls = 0;
    h.statusAfter = (restarts) => {
      if (restarts === 0) return status({ state: "draining" });
      polls += 1;
      return polls * 2_000 > HEALTH_TIMEOUT_MS - 4_000
        ? status({ pid: 200, version: "0.4.0" })
        : status({ state: "starting", pid: 200, version: "0.4.0" });
    };
    activate();
    expect((await apply(h)).kind).toBe("applied");
  });
});

describe("the current release", () => {
  it("is read from the link, and none when it names no release", () => {
    expect(currentVersion(layout)).toBeNull();
    mkdirSync(layout.installRoot, { recursive: true });
    symlinkSync("somewhere/else", layout.currentLink);
    expect(currentVersion(layout)).toBeNull();
    installed("0.3.0");
    expect(currentVersion(layout)).toBe("0.3.0");
  });
});
