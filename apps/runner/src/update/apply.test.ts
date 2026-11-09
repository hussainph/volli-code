/**
 * The applier against a real install root in a temporary directory, with the
 * network, `tar`, the probes, systemd and the runner's process faked.
 */
import { createHash } from "node:crypto";
import {
  chmodSync,
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
  currentRelease,
  HEALTH_TIMEOUT_MS,
  MAX_RESTARTS,
  pointCurrentAt,
  type ApplyPorts,
  type ApplyResult,
} from "./apply";
import {
  EMPTY_STATE,
  readUpdaterState,
  writeNowRequest,
  writeUpdateRequest,
  writeUpdaterState,
  type UpdaterState,
} from "./files";
import { updateLayout, type UpdateLayout } from "./layout";
import { MANIFEST_ASSET, tarballName, UpdateRefusal } from "./manifest";
import type { ProvenanceSubject } from "./provenance";

const ORIGIN = "https://releases.test/";
const REV = "0123456789abcdef0123456789abcdef01234567";
const manifestUrl = (version: string): string => `${ORIGIN}v${version}/${MANIFEST_ASSET}`;
const sha = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

let root: string;
let layout: UpdateLayout;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "runner-apply-"));
  layout = updateLayout("system", join(root, "opt"), join(root, "data"));
  mkdirSync(layout.dataDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A release directory as the packager makes it. */
function makeRelease(dir: string, version: string, revision: string | null = REV): void {
  mkdirSync(join(dir, "bin"), { recursive: true });
  writeFileSync(join(dir, "bin", "node"), "");
  writeFileSync(join(dir, "bin", "volli-runner"), "");
  writeFileSync(
    join(dir, "MANIFEST.json"),
    JSON.stringify({ name: "volli-runner", version, ...(revision === null ? {} : { revision }) }),
  );
}

/** The installer's layout: `releases/<version>-<rev>`, `current` relative or absolute. */
function installed(version = "0.3.0", absolute = false): string {
  const name = `${version}-install`;
  makeRelease(join(layout.releasesDir, name), version);
  const target = absolute ? join(layout.releasesDir, name) : join("releases", name);
  pointCurrentAt(layout, target);
  return target;
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

/** How a release behaves once systemd starts it. */
type Behaviour = "online" | "silent" | "crash-loop" | "impostor";

interface Harness {
  ports: ApplyPorts;
  documents: Map<string, string>;
  verified: { bundle: string; version: string; subjects: readonly ProvenanceSubject[] }[];
  restarts: number;
  logs: string[];
  /** The runner's status before any restart. */
  before: RunnerStatus | null;
  behaviour: (version: string) => Behaviour;
  extract: (into: string, version: string) => void;
  probe: () => void;
  restartError: (restarts: number) => Error | null;
  provenanceError: Error | null;
  serviceKnown: boolean;
}

function harness(options: { provenance?: boolean } = {}): Harness {
  let clock = 0;
  let mainPid = 100;
  let crashes = 0;
  let running: string | null = null;
  const h: Harness = {
    documents: new Map(),
    verified: [],
    restarts: 0,
    logs: [],
    before: status({ state: "draining" }),
    behaviour: () => "online",
    extract: (into, version) =>
      makeRelease(join(into, `volli-runner-${version}-linux-x64`), version),
    probe: () => {},
    restartError: () => null,
    provenanceError: null,
    serviceKnown: true,
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
      h.extract(into, basename(tarball).replace(/^volli-runner-|-linux-x64\.tar\.gz$/gu, ""));
    },
    probe: async () => h.probe(),
    restart: async () => {
      h.restarts += 1;
      const error = h.restartError(h.restarts);
      if (error !== null) throw error;
      mainPid += 1;
      running = currentRelease(layout)?.version ?? null;
    },
    service: async () => {
      if (!h.serviceKnown) return null;
      if (running !== null && h.behaviour(running) === "crash-loop") crashes += 1;
      return { mainPid, restarts: crashes };
    },
    readStatus: (owner) => {
      expect(owner).toBe(process.getuid!());
      if (running === null) return h.before;
      const behaviour = h.behaviour(running);
      if (behaviour === "silent")
        return status({ state: "starting", pid: mainPid, version: running });
      // An agent's forged file: online, but not the unit's main process.
      if (behaviour === "impostor") return status({ pid: 1, version: running });
      return status({ pid: mainPid, version: running });
    },
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

const activate = (urgent = false) =>
  writeUpdateRequest(layout.requestFile, { phase: "activate", version: "0.4.0", urgent });

const state = (): UpdaterState => readUpdaterState(layout.stateFile);
const STAGED = `0.4.0-${REV.slice(0, 12)}`;

const top = (into: string, version: string): string =>
  join(into, `volli-runner-${version}-linux-x64`);

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

  it("does nothing without a data dir", async () => {
    installed();
    rmSync(layout.dataDir, { recursive: true });
    expect(await apply(harness())).toEqual({ kind: "idle", why: "no request" });
  });

  it("downloads, verifies, probes and puts a release beside the current one", async () => {
    const target = installed();
    const h = harness();
    const manifest = publish(h.documents, "0.4.0");
    stageRequest("0.4.0");
    expect(await apply(h)).toEqual({ kind: "staged", version: "0.4.0" });
    expect(existsSync(join(layout.releasesDir, STAGED, "bin", "volli-runner"))).toBe(true);
    expect(readlinkSync(layout.currentLink)).toBe(target);
    expect(readdirSync(layout.releasesDir).toSorted()).toEqual(["0.3.0-install", STAGED]);
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
    expect(after.staged).toEqual({ version: "0.4.0", name: STAGED });
    expect(after.outcomes.map((o) => [o.kind, o.version, o.fromVersion, o.reason])).toEqual([
      ["update_staged", "0.4.0", "0.3.0", null],
    ]);
  });

  it("names a release without a revision by its version", async () => {
    installed("0.3.0", true);
    const h = harness({ provenance: false });
    h.extract = (into, version) =>
      makeRelease(join(into, `volli-runner-${version}-linux-x64`), version, null);
    publish(h.documents, "0.4.0");
    stageRequest("0.4.0");
    expect((await apply(h)).kind).toBe("staged");
    expect(state().staged).toEqual({ version: "0.4.0", name: "0.4.0" });
    expect(h.verified).toEqual([]);
  });

  it("names a release with an odd revision by its version, too", async () => {
    installed();
    const h = harness();
    h.extract = (into, version) =>
      makeRelease(join(into, `volli-runner-${version}-linux-x64`), version, "unknown");
    publish(h.documents, "0.4.0");
    stageRequest("0.4.0");
    expect((await apply(h)).kind).toBe("staged");
    expect(state().staged?.name).toBe("0.4.0");
  });

  it("replaces a leftover of an earlier attempt", async () => {
    installed();
    mkdirSync(join(layout.releasesDir, STAGED, "junk"), { recursive: true });
    const h = harness();
    publish(h.documents, "0.4.0");
    stageRequest("0.4.0");
    expect((await apply(h)).kind).toBe("staged");
    expect(existsSync(join(layout.releasesDir, STAGED, "junk"))).toBe(false);
  });

  async function refused(h: Harness, code: string): Promise<void> {
    const result = await apply(h);
    expect(result).toMatchObject({ kind: "refused", code });
    const last = state().outcomes.at(-1);
    expect(last).toMatchObject({ kind: "update_failed", reason: code });
    expect(readdirSync(layout.releasesDir).filter((entry) => entry !== "0.3.0-install")).toEqual(
      [],
    );
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

  it("tries a bad release again when the install's owner names it", async () => {
    installed();
    writeUpdaterState(layout.stateFile, { ...EMPTY_STATE, bad: ["0.4.0"] });
    writeNowRequest(layout.nowFile, "0.4.1", new Date(0));
    const h = harness();
    publish(h.documents, "0.4.0");
    stageRequest("0.4.0");
    expect((await apply(h)).kind).toBe("refused");
    writeNowRequest(layout.nowFile, "0.4.0", new Date(0));
    stageRequest("0.4.0");
    expect((await apply(h)).kind).toBe("staged");
    writeFileSync(layout.nowFile, "{");
    stageRequest("0.4.0");
    expect((await apply(h)).kind).toBe("refused");
  });

  it("refuses without an installed release, recording nothing", async () => {
    const h = harness();
    stageRequest("0.4.0");
    expect(await apply(h)).toMatchObject({ kind: "refused", code: "not_installed" });
    expect(existsSync(layout.stateFile)).toBe(false);
    // A `current` whose release names no version is no install either.
    mkdirSync(join(layout.releasesDir, "x"), { recursive: true });
    pointCurrentAt(layout, join("releases", "x"));
    expect(await apply(h)).toMatchObject({ kind: "refused", code: "not_installed" });
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

  it("refuses a tarball that is not this runner release", async () => {
    installed();
    const h = harness();
    publish(h.documents, "0.4.0");
    const cases: ((into: string, version: string) => void)[] = [
      (into) => mkdirSync(join(into, "something-else")),
      (into, version) => mkdirSync(join(top(into, version), "bin"), { recursive: true }),
      (into, version) => {
        makeRelease(top(into, version), version);
        rmSync(join(top(into, version), "bin", "volli-runner"));
      },
      (into, version) => makeRelease(top(into, version), "0.3.9"),
      (into, version) => {
        makeRelease(top(into, version), version);
        rmSync(join(top(into, version), "MANIFEST.json"));
      },
    ];
    for (const extract of cases) {
      h.extract = extract;
      stageRequest("0.4.0");
      await refused(h, "bad_tarball");
    }
  });

  it("records a probe failure as a failed update", async () => {
    installed();
    const h = harness();
    h.probe = () => {
      throw new Error("better-sqlite3 needs GLIBC_2.38");
    };
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
    expect(await apply(harness())).toMatchObject({ kind: "refused", code: "bad_request" });
    expect(state()).toEqual(EMPTY_STATE);
  });

  it("goes on to a request the daemon wrote meanwhile", async () => {
    installed();
    const h = harness();
    publish(h.documents, "0.4.0");
    // The daemon drains and asks to activate while the stage is still running.
    h.probe = () => void activate(true);
    stageRequest("0.4.0");
    expect(await apply(h)).toEqual({ kind: "applied", version: "0.4.0", from: "0.3.0" });
  });

  it("handles a bounded number of requests per run", async () => {
    installed();
    const h = harness();
    publish(h.documents, "0.4.0");
    h.probe = () => void stageRequest("0.4.0");
    stageRequest("0.4.0");
    expect((await apply(h)).kind).toBe("staged");
    expect(state().handled).toHaveLength(4);
  });
});

describe("activating", () => {
  async function staged(h: Harness): Promise<string> {
    const target = installed();
    makeRelease(join(layout.releasesDir, "0.2.0-old"), "0.2.0");
    publish(h.documents, "0.4.0");
    stageRequest("0.4.0");
    expect((await apply(h)).kind).toBe("staged");
    return target;
  }

  it("moves current, restarts, and keeps the new release once it stays online", async () => {
    const h = harness();
    await staged(h);
    mkdirSync(join(layout.releasesDir, "notes"));
    writeFileSync(join(layout.releasesDir, "0.1.0"), "a file");
    writeNowRequest(layout.nowFile, "0.4.0", new Date(0));
    writeUpdaterState(layout.stateFile, { ...state(), bad: ["0.4.0", "0.3.5"] });
    activate();
    expect(await apply(h)).toEqual({ kind: "applied", version: "0.4.0", from: "0.3.0" });
    expect(h.restarts).toBe(1);
    expect(readlinkSync(layout.currentLink)).toBe(join("releases", STAGED));
    expect(currentRelease(layout)?.version).toBe("0.4.0");
    // The rollback stays; older releases go; what is not a release stays.
    expect(readdirSync(layout.releasesDir).toSorted()).toEqual([
      "0.1.0",
      "0.3.0-install",
      STAGED,
      "notes",
    ]);
    expect(existsSync(layout.nowFile)).toBe(false);
    const after = state();
    expect(after).toMatchObject({
      staged: null,
      activating: null,
      previous: join("releases", "0.3.0-install"),
      bad: ["0.3.5"],
    });
    expect(after.outcomes.at(-1)).toMatchObject({
      kind: "update_applied",
      version: "0.4.0",
      fromVersion: "0.3.0",
    });
  });

  it("keeps a healthy release when cleaning up after it fails", async () => {
    const h = harness();
    await staged(h);
    const old = join(layout.releasesDir, "0.2.0-old");
    mkdirSync(join(old, "locked", "deep"), { recursive: true });
    chmodSync(join(old, "locked"), 0o500);
    activate();
    try {
      expect((await apply(h)).kind).toBe("applied");
    } finally {
      chmodSync(join(old, "locked"), 0o700);
    }
    expect(h.logs.at(-1)).toMatch(/^cleaning up old releases failed/u);
    expect(state().bad).toEqual([]);
  });

  it("waits for a draining runner unless the update is urgent", async () => {
    const h = harness();
    await staged(h);
    h.before = status({ state: "online" });
    activate();
    expect(await apply(h)).toMatchObject({ kind: "refused", code: "not_draining" });
    h.before = null;
    activate();
    expect(await apply(h)).toMatchObject({ kind: "refused", code: "not_draining" });
    expect(currentRelease(layout)?.version).toBe("0.3.0");
    activate(true);
    expect((await apply(h)).kind).toBe("applied");
  });

  it("refuses to activate what is not staged", async () => {
    installed();
    const h = harness();
    activate();
    expect(await apply(h)).toMatchObject({ kind: "refused", code: "not_staged" });
    writeUpdaterState(layout.stateFile, { ...state(), staged: { version: "0.4.0", name: "gone" } });
    activate();
    expect(await apply(h)).toMatchObject({ kind: "refused", code: "not_staged" });
  });

  async function rolledBack(h: Harness, reason: string, back: string | null = null) {
    expect(await apply(h)).toEqual({ kind: "rolled_back", version: "0.4.0", to: "0.3.0", reason });
    const after = state();
    expect(after.bad).toEqual(["0.4.0"]);
    expect(after.activating).toBeNull();
    expect(
      after.outcomes.slice(-2).map((o) => [o.kind, o.version, o.fromVersion, o.reason]),
    ).toEqual([
      ["update_failed", "0.4.0", "0.3.0", reason],
      ["rolled_back", "0.3.0", "0.4.0", back],
    ]);
  }

  it("rolls back a release that never comes online, to exactly the link it had", async () => {
    const h = harness();
    const target = await staged(h);
    h.behaviour = (version) => (version === "0.4.0" ? "silent" : "online");
    activate();
    await rolledBack(h, "health_timeout");
    expect(h.restarts).toBe(2);
    expect(readlinkSync(layout.currentLink)).toBe(target);
    stageRequest("0.4.0");
    expect(await apply(h)).toMatchObject({ kind: "refused", code: "known_bad" });
  });

  it("restores an absolute current as the installer wrote it", async () => {
    const h = harness();
    const target = installed("0.3.0", true);
    publish(h.documents, "0.4.0");
    stageRequest("0.4.0");
    await apply(h);
    h.behaviour = (version) => (version === "0.4.0" ? "silent" : "online");
    activate(true);
    expect((await apply(h)).kind).toBe("rolled_back");
    expect(readlinkSync(layout.currentLink)).toBe(target);
  });

  it(`rolls back a release systemd restarts ${MAX_RESTARTS} times`, async () => {
    const h = harness();
    await staged(h);
    h.behaviour = (version) => (version === "0.4.0" ? "crash-loop" : "online");
    activate();
    await rolledBack(h, "health_timeout");
  });

  it("does not take a forged status for the unit's process", async () => {
    const h = harness();
    await staged(h);
    h.behaviour = (version) => (version === "0.4.0" ? "impostor" : "online");
    activate();
    await rolledBack(h, "health_timeout");
  });

  it("cannot call a release healthy without systemd's word", async () => {
    const h = harness();
    await staged(h);
    h.serviceKnown = false;
    activate();
    await rolledBack(h, "health_timeout", "unhealthy_after_rollback");
  });

  it("rolls back when the restart itself fails, and says when the rollback's does too", async () => {
    const h = harness();
    await staged(h);
    h.restartError = () => new Error("Failed to restart volli-runner.service");
    activate();
    await rolledBack(h, "restart_failed", "unhealthy_after_rollback");
    expect(currentRelease(layout)?.version).toBe("0.3.0");
    expect(h.logs.filter((line) => line.startsWith("restarting on"))).toHaveLength(2);
  });

  it("forgets an owner's --to once that release fails again", async () => {
    const h = harness();
    await staged(h);
    writeNowRequest(layout.nowFile, "0.4.0", new Date(0));
    h.behaviour = (version) => (version === "0.4.0" ? "silent" : "online");
    activate();
    expect((await apply(h)).kind).toBe("rolled_back");
    expect(existsSync(layout.nowFile)).toBe(false);
  });

  it("keeps an owner's --to for another release through a rollback", async () => {
    const h = harness();
    await staged(h);
    writeNowRequest(layout.nowFile, "0.5.0", new Date(0));
    h.behaviour = (version) => (version === "0.4.0" ? "silent" : "online");
    activate();
    expect((await apply(h)).kind).toBe("rolled_back");
    expect(existsSync(layout.nowFile)).toBe(true);
  });

  it("does not hold one failed systemctl show against a healthy release", async () => {
    const h = harness();
    await staged(h);
    let calls = 0;
    const service = h.ports.service;
    h.ports = {
      ...h.ports,
      // The baseline and every third poll fail; the last one answers.
      service: async () => ((calls += 1) === 1 || calls % 3 === 0 ? null : service()),
    };
    activate();
    expect((await apply(h)).kind).toBe("applied");
  });

  it(`watches a new release for the whole ${HEALTH_TIMEOUT_MS / 1000} s`, async () => {
    const h = harness();
    await staged(h);
    let calls = 0;
    const service = h.ports.service;
    h.ports = {
      ...h.ports,
      service: async () => {
        calls += 1;
        return service();
      },
    };
    activate();
    expect((await apply(h)).kind).toBe("applied");
    expect(calls).toBeGreaterThan(HEALTH_TIMEOUT_MS / 2_000);
  });
});

describe("an interrupted activation", () => {
  function interrupted(switched: boolean): string {
    const target = installed();
    makeRelease(join(layout.releasesDir, STAGED), "0.4.0");
    writeUpdaterState(layout.stateFile, {
      ...EMPTY_STATE,
      activating: {
        version: "0.4.0",
        name: STAGED,
        fromTarget: target,
        fromVersion: "0.3.0",
        at: "1970-01-01T00:00:00.000Z",
      },
    });
    if (switched) pointCurrentAt(layout, join("releases", STAGED));
    return target;
  }

  it("keeps a release that came up healthy", async () => {
    interrupted(true);
    const h = harness();
    // The box rebooted onto the new release, which systemd started.
    await h.ports.restart();
    h.restarts = 0;
    expect(await apply(h)).toEqual({ kind: "applied", version: "0.4.0", from: "0.3.0" });
    expect(state().activating).toBeNull();
    expect(h.restarts).toBe(0);
  });

  it("rolls back one that did not", async () => {
    const target = interrupted(true);
    const h = harness();
    h.behaviour = (version) => (version === "0.4.0" ? "silent" : "online");
    await h.ports.restart();
    expect((await apply(h)).kind).toBe("rolled_back");
    expect(readlinkSync(layout.currentLink)).toBe(target);
  });

  it("rolls back when it cannot read the runner's status at all", async () => {
    interrupted(true);
    rmSync(layout.dataDir, { recursive: true });
    const h = harness();
    await h.ports.restart();
    expect((await apply(h)).kind).toBe("rolled_back");
  });

  it("restarts a release the switch reached but the restart never did", async () => {
    for (const before of [status({ state: "stopped" }), null]) {
      interrupted(true);
      const h = harness();
      h.before = before;
      expect(await apply(h)).toEqual({ kind: "applied", version: "0.4.0", from: "0.3.0" });
      expect(h.restarts).toBe(1);
      rmSync(layout.installRoot, { recursive: true });
    }
  });

  it("restarts onto the old release when a cut-short rollback left the new one running", async () => {
    const target = interrupted(false);
    const h = harness();
    h.before = status({ version: "0.4.0" });
    expect(await apply(h)).toMatchObject({ kind: "failed", code: "interrupted" });
    expect(h.restarts).toBe(1);
    expect(readlinkSync(layout.currentLink)).toBe(target);
  });

  it("settles when the daemon wakes it, and says what the settling did", async () => {
    interrupted(true);
    const h = harness();
    writeUpdateRequest(layout.requestFile, { phase: "settle", version: "0.4.0", urgent: true });
    expect((await apply(h)).kind).toBe("applied");
    const request = writeUpdateRequest(layout.requestFile, {
      phase: "settle",
      version: "0.4.0",
      urgent: true,
    });
    expect(await apply(h)).toEqual({ kind: "idle", why: "settled" });
    expect(state().handled).toContain(request.id);
  });

  it("puts current back when the switch never happened", async () => {
    const target = interrupted(false);
    const h = harness();
    expect(await apply(h)).toMatchObject({ kind: "failed", code: "interrupted" });
    expect(readlinkSync(layout.currentLink)).toBe(target);
    expect(state()).toMatchObject({ activating: null });
    expect(state().outcomes.at(-1)).toMatchObject({ kind: "update_failed", reason: "interrupted" });
  });

  it("then goes on to the request waiting", async () => {
    interrupted(false);
    const h = harness();
    h.documents.clear();
    publish(h.documents, "0.4.1");
    writeUpdateRequest(layout.requestFile, {
      phase: "stage",
      version: "0.4.1",
      manifestUrl: manifestUrl("0.4.1"),
      urgent: false,
    });
    expect(await apply(h)).toEqual({ kind: "staged", version: "0.4.1" });
  });
});

describe("the current release", () => {
  it("is read from the release's own manifest", () => {
    expect(currentRelease(layout)).toBeNull();
    mkdirSync(layout.installRoot, { recursive: true });
    symlinkSync("somewhere/else", layout.currentLink);
    expect(currentRelease(layout)).toBeNull();
    const target = installed("0.3.0");
    expect(currentRelease(layout)).toEqual({
      version: "0.3.0",
      name: "0.3.0-install",
      target,
    });
    writeFileSync(join(layout.releasesDir, "0.3.0-install", "MANIFEST.json"), "{");
    expect(currentRelease(layout)).toBeNull();
  });
});
