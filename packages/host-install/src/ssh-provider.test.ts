import { execFileSync, spawn as nodeSpawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  parseHostdReleasePin,
  resolveArtifact,
  supportedTargets,
  type HostdArtifact,
} from "./artifact";
import type { HostdManagedStatus } from "./contract";
import { describeFailure } from "./failures";
import { parseProbe, PROBE_SCRIPT } from "./probe";
import {
  advance,
  answer,
  initialProvisionState,
  nextStep,
  retry,
  type ProvisionRequest,
  type ProvisionSecrets,
  type ProvisionState,
} from "./provision";
import {
  modeOf,
  sshProvider,
  type SshProviderPorts,
  type SshStepResults,
  type UploadResult,
} from "./ssh-provider";
import {
  runProcess,
  shellQuote,
  type HostKeyOffer,
  type SshExecOptions,
  type SshExecResult,
  type SshTransport,
} from "./ssh";
import { recordingLogger } from "./testing/fake-process";

const HOST_ID = "0f6a3a8e-2b1c-4d5e-8f90-1a2b3c4d5e6f";
const DEVICE_ID = "1f6a3a8e-2b1c-4d5e-8f90-1a2b3c4d5e6f";
const BYTES = "pretend tarball";
const SHA = createHash("sha256").update(BYTES).digest("hex");
const FILE = "volli-hostd-1.1.0-linux-x64.tar.gz";
/** Where the fake box says deliver extracted the tarball afresh. */
const STAGED = "/home/deploy/.cache/volli-hostd/stage.Ab12Cd";
const CURRENT = "/opt/volli-hostd/current/bin/volli-hostd";

const FACTS: Record<string, string> = {
  kernel: "Linux",
  arch: "x86_64",
  os_id: "ubuntu",
  os_version: "24.04",
  os_name: "Ubuntu 24.04.1 LTS",
  user: "deploy",
  home: "/home/deploy",
  groups: "deploy sudo",
  systemd: "255",
  user_manager: "yes",
  linger: "no",
  glibc: "2.39",
  disk_home: "10000000",
  disk_system: "10000000",
  mem_kb: "8167236",
  sudo: "nopasswd",
};

function probeOutput(overrides: Record<string, string | null> = {}, extra = ""): string {
  const facts = { ...FACTS, ...overrides };
  const lines = Object.entries(facts)
    .filter(([, value]) => value !== null)
    .map(([key, value]) => `${key}=${value}`);
  return `${[...lines, ...(extra === "" ? [] : [extra]), "end=ok"].join("\n")}\n`;
}

function existing(
  version: string,
  mode: "system" | "user",
  status: Partial<HostdManagedStatus> | null,
): string {
  const binary =
    mode === "system" ? CURRENT : "/home/deploy/.local/share/volli-hostd/current/bin/volli-hostd";
  return [
    `hostd=${mode} managed ${version}`,
    `hostd_path=${binary}`,
    `status=${status === null ? "" : JSON.stringify({ v: 1, management: 1, ...status })}`,
  ].join("\n");
}

const LISTEN = { host: "127.0.0.1", port: 7420 };
const json = (value: unknown) => ({ stdout: `${JSON.stringify(value)}\n` });
const INSTALLED = (mode: "system" | "user") => ({
  v: 1,
  ok: true,
  mode,
  version: "1.1.0",
  previous: null,
  adopted: null,
  changed: true,
  actions: [],
  dataDir: "/var/lib/volli-hostd",
  binary:
    mode === "system" ? CURRENT : "/home/deploy/.local/share/volli-hostd/current/bin/volli-hostd",
  listen: LISTEN,
  serviceUser: mode === "system" ? "volli" : null,
});
const STARTED = (mode: "system" | "user") => ({
  v: 1,
  ok: true,
  mode,
  version: "1.1.0",
  restarted: true,
  hostId: HOST_ID,
  listen: LISTEN,
  linger: mode === "user" ? true : null,
});
const ENROLLED = {
  v: 1,
  ok: true,
  hostId: HOST_ID,
  deviceId: DEVICE_ID,
  fingerprint: "SHA256:mac",
  created: true,
  version: "1.1.0",
  listen: LISTEN,
};

type Handler = (script: string, options: SshExecOptions) => Partial<SshExecResult> | undefined;

/**
 * A fake box over a fake SSH connection. Each script is answered by the first
 * override that answers it, else by a fresh Ubuntu box with passwordless sudo.
 */
function fakeBox(...overrides: Handler[]) {
  const scripts: { script: string; stdin: string | null }[] = [];
  const defaults: Handler = (script, options) => {
    if (script === "echo volli-ok") return { stdout: "volli-ok\n" };
    if (script === PROBE_SCRIPT) return { stdout: probeOutput() };
    if (options.label === "upload: check") return { stdout: "\n" };
    if (script.includes("cat > ")) return {};
    if (script.includes(".part' 2>/dev/null; } | cut")) return { stdout: `${SHA}\n` };
    if (script.includes("tar -xzf")) return { stdout: `dir=${STAGED}\nversion=1.1.0\n` };
    if (script.includes(" install --"))
      return json(INSTALLED(script.includes("--user") ? "user" : "system"));
    if (script.includes(" start --"))
      return json(STARTED(script.includes("--user") ? "user" : "system"));
    if (script.includes(" enroll --")) return json(ENROLLED);
    return {};
  };
  const ssh: SshTransport = {
    target: { destination: "deploy@box", port: null, label: "box" },
    async exec(script, options = {}) {
      let stdin: string | null = null;
      if (typeof options.stdin === "string") stdin = options.stdin;
      else if (options.stdin !== undefined) {
        let sent = 0;
        for await (const chunk of options.stdin as Readable) {
          sent += (chunk as Buffer).length;
          options.onProgress?.(sent);
        }
        stdin = `<${sent} bytes>`;
      }
      scripts.push({ script, stdin });
      for (const handler of [...overrides, defaults]) {
        const result = handler(script, options);
        if (result !== undefined) return { code: 0, stdout: "", stderr: "", ...result };
      }
      throw new Error("unreachable");
    },
    close: async () => {},
  };
  return { ssh, scripts, ran: () => scripts.map((entry) => entry.script) };
}

let root: string;
let tarball: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "host-install-provision-"));
  tarball = join(root, FILE);
  writeFileSync(tarball, BYTES);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const OFFER: HostKeyOffer = {
  entries: ["box ssh-ed25519 AAAA"],
  fingerprints: [{ type: "ED25519", fingerprint: "SHA256:box" }],
};

function ports(box: ReturnType<typeof fakeBox>, overrides: Partial<SshProviderPorts> = {}) {
  const log = recordingLogger();
  const accepted: HostKeyOffer[] = [];
  const steps: string[] = [];
  const progress: number[] = [];
  const tunnels: unknown[] = [];
  const value: SshProviderPorts = {
    ssh: box.ssh,
    hostKeys: { discover: async () => OFFER, accept: async (offer) => void accepted.push(offer) },
    artifact: async (target): Promise<HostdArtifact> => ({
      version: "1.1.0",
      target,
      fileName: FILE,
      path: tarball,
      sha256: SHA,
      bytes: BYTES.length,
      source: "cache",
    }),
    openTunnel: async (remote) => {
      tunnels.push(remote);
      return { url: "ws://127.0.0.1:55000" };
    },
    onUploadProgress: (sent) => progress.push(sent),
    ...overrides,
  };
  return {
    value,
    log,
    accepted,
    steps,
    progress,
    tunnels,
    onStep: (step: string) => steps.push(step),
  };
}

type State = ProvisionState<SshStepResults>;

/** `advance` with the SSH provider over these ports. */
function advanceWith(
  state: State,
  p: ReturnType<typeof ports>,
  secrets?: ProvisionSecrets,
): Promise<State> {
  return advance(state, sshProvider(p.value), {
    logger: p.log.logger,
    onStep: p.onStep,
    ...(secrets === undefined ? {} : { secrets }),
  });
}

const REQUEST: ProvisionRequest = {
  host: "box",
  appVersion: "1.1.0",
  device: { publicKey: "SPKI", fingerprint: "SHA256:mac", name: "Alice's Mac" },
  pinnedHostId: null,
};

const start = (request: Partial<ProvisionRequest> = {}): State =>
  initialProvisionState<SshStepResults>({ ...REQUEST, ...request });

function stoppedWith(state: State) {
  expect(state.status).toBe("stopped");
  return state.stop!.kind === "failed" ? state.stop!.failure : state.stop!.question;
}

describe("adding a fresh box with passwordless sudo", () => {
  it("connects, probes, uploads, installs a system unit, starts, enrolls and tunnels", async () => {
    const box = fakeBox();
    const p = ports(box);
    const done = await advanceWith(start(), p);
    expect(done.status).toBe("done");
    expect(p.steps).toEqual(["connect", "probe", "deliver", "install", "start", "enroll", "link"]);
    expect(p.progress).toEqual([BYTES.length]);
    expect(p.tunnels).toEqual([LISTEN]);
    expect(modeOf(done)).toBe("system");
    expect(done.results.enroll).toMatchObject({ hostId: HOST_ID, deviceId: DEVICE_ID });
    expect(done.results.link).toEqual({ url: "ws://127.0.0.1:55000" });
    expect(done.results.deliver).toMatchObject({ releaseDir: STAGED, reused: false });
    // Every hostd command reads /dev/null; enroll on a system install runs as root (its store is root's).
    expect(box.ran().filter((script) => / (install|start|enroll) --/u.test(script))).toEqual([
      `sudo -n '${STAGED}/bin/volli-hostd' install --system --operator 'deploy' </dev/null`,
      `sudo -n '${CURRENT}' start --system </dev/null`,
      `sudo -n '${CURRENT}' enroll --system --public-key 'SPKI' --name 'Alice'\\''s Mac' </dev/null`,
    ]);
    expect(box.scripts.find((entry) => entry.script.includes("cat > "))?.stdin).toBe(
      `<${BYTES.length} bytes>`,
    );
    expect(
      p.log.lines.every(
        (line) => line.fields["component"] === "host-install" && line.fields["host"] === "box",
      ),
    ).toBe(true);
    expect(p.log.lines.map((line) => line.msg)).toContain("host added");
    // Plain JSON: a state survives a restart of whoever holds it.
    expect(JSON.parse(JSON.stringify(done))).toEqual(done);
    expect(nextStep(done)).toBeNull();
    expect(await advanceWith(done, p)).toMatchObject({ status: "done" });
  });

  it("does not send again a tarball the box already has, but still extracts it afresh", async () => {
    const box = fakeBox((_script, options) =>
      options.label === "upload: check" ? { stdout: `${SHA}\n` } : undefined,
    );
    const done = await advanceWith(start(), ports(box));
    expect(done.results.deliver).toMatchObject({ reused: true, releaseDir: STAGED });
    expect(box.ran().some((script) => script.includes("cat > "))).toBe(false);
    const unpack = box.ran().find((script) => script.includes("tar -xzf"))!;
    expect(unpack).toContain("mktemp -d");
    expect(unpack).not.toContain("mv -f");
    expect(box.ran()).toContain(
      `sudo -n '${STAGED}/bin/volli-hostd' install --system --operator 'deploy' </dev/null`,
    );
  });
});

describe("the operator token (VC-710)", () => {
  const TOKEN_SCRIPT = [
    "t=0",
    `[ -s '/home/deploy/.config/volli/operator-token' ] || '${CURRENT}' operator-token --for 'deploy' >/dev/null || t=$?`,
    '[ -e /srv/volli ] || install -d -o volli -g volli -m 750 /srv/volli || echo "could not make /srv/volli" >&2',
    'exit "$t"',
  ].join("\n");

  it("answers with the token's own outcome: a folder made after it never masks a failed issuance", () => {
    const home = mkdtempSync(join(tmpdir(), "vc710-operator-"));
    try {
      const run = (binary: string) =>
        spawnSync(
          "/bin/sh",
          [
            "-c",
            TOKEN_SCRIPT.replaceAll(`'${CURRENT}'`, binary).replaceAll(
              "/srv/volli",
              join(home, "srv"),
            ),
          ],
          { encoding: "utf8" },
        );
      expect(run("false").status).toBe(1);
      expect(run("true").status).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("makes the login an operator while the install holds root, unless it already is one", async () => {
    const box = fakeBox();
    const p = ports(box);
    const done = await advanceWith(start(), p);
    expect(done.status).toBe("done");
    const ran = box.scripts.find((entry) => entry.script.includes("operator-token"));
    expect(ran?.script).toBe(`sudo -n sh -c ${shellQuote(TOKEN_SCRIPT)} </dev/null`);
    // It runs after the install answered, and before start.
    const order = box
      .ran()
      .map((script) =>
        script.includes("operator-token")
          ? "operator"
          : script.includes(" start --")
            ? "start"
            : "",
      );
    expect(order.filter(Boolean)).toEqual(["operator", "start"]);
    expect(p.log.lines).toContainEqual(
      expect.objectContaining({
        msg: "made the login an operator",
        fields: expect.objectContaining({ login: "deploy" }),
      }),
    );
  });

  it("never fails the add when it could not: the app shows the command instead", async () => {
    const box = fakeBox((script) =>
      script.includes("operator-token")
        ? { code: 1, stderr: "volli-hostd operator-token: no user named deploy on this host.\n" }
        : undefined,
    );
    const p = ports(box);
    expect((await advanceWith(start(), p)).status).toBe("done");
    expect(p.log.lines).toContainEqual(
      expect.objectContaining({
        level: "warn",
        msg: "could not make the login an operator; the app shows the command instead",
        fields: expect.objectContaining({
          code: 1,
          stderr: "volli-hostd operator-token: no user named deploy on this host.",
        }),
      }),
    );
  });

  it("does without it when the password is gone by then, and says so", async () => {
    const secrets: ProvisionSecrets = { sudoPassword: null };
    const box = fakeBox(
      (script) => (script === PROBE_SCRIPT ? { stdout: probeOutput({ sudo: null }) } : undefined),
      (script) => {
        if (!script.includes(" install --system")) return undefined;
        secrets.sudoPassword = null;
        return json(INSTALLED("system"));
      },
    );
    const p = ports(box);
    const asked = await advanceWith(start(), p, secrets);
    secrets.sudoPassword = "hunter2";
    await advanceWith(answer(asked, { kind: "sudo-password", password: "hunter2" }), p, secrets);
    expect(box.ran().some((script) => script.includes("operator-token"))).toBe(false);
    expect(p.log.lines.map((line) => line.msg)).toContain(
      "no sudo to issue an operator token; the app shows the command instead",
    );
  });

  it("never fails the add when the operator step's transport throws, and never says the password", async () => {
    const secrets: ProvisionSecrets = { sudoPassword: "pw-in-a-throw" };
    const box = fakeBox(
      (script) => (script === PROBE_SCRIPT ? { stdout: probeOutput({ sudo: null }) } : undefined),
      (script) => {
        if (script.includes("operator-token")) throw new Error("ssh died holding pw-in-a-throw");
        return undefined;
      },
    );
    const p = ports(box);
    const asked = await advanceWith(start(), p, secrets);
    secrets.sudoPassword = "pw-in-a-throw";
    const done = await advanceWith(
      answer(asked, { kind: "sudo-password", password: "pw-in-a-throw" }),
      p,
      secrets,
    );
    expect(done.status).toBe("done");
    expect(p.log.lines).toContainEqual(
      expect.objectContaining({
        fields: expect.objectContaining({ error: "Error: ssh died holding [redacted]" }),
      }),
    );
    expect(JSON.stringify(p.log.lines)).not.toContain("pw-in-a-throw");
  });

  it("is never asked of a user install: its login is hostd's own account", async () => {
    const box = fakeBox((script) =>
      script === PROBE_SCRIPT ? { stdout: probeOutput(MAC) } : undefined,
    );
    const done = await advanceWith(start({ supportedTargets: ["darwin-arm64"] }), ports(box));
    expect(done.status).toBe("done");
    expect(box.ran().some((script) => script.includes("operator-token"))).toBe(false);
  });
});

describe("connect", () => {
  it("shows an unknown host key's fingerprint and connects only once it is accepted", async () => {
    let known = false;
    const box = fakeBox((script) =>
      script === "echo volli-ok" && !known
        ? {
            code: 255,
            stderr: "No ED25519 host key is known for box and you have requested strict checking.",
          }
        : undefined,
    );
    const p = ports(box, {
      hostKeys: {
        discover: async () => OFFER,
        accept: async () => {
          known = true;
        },
      },
    });
    const asked = await advanceWith(start(), p);
    expect(stoppedWith(asked)).toEqual({ kind: "host-key", step: "connect", offer: OFFER });
    const done = await advanceWith(answer(asked, { kind: "accept-host-key" }), p);
    expect(done.status).toBe("done");
    expect(done.decisions.acceptedHostKeys).toBeUndefined();
  });

  it("asks again when the box shows a key other than the one accepted", async () => {
    const box = fakeBox((script) =>
      script === "echo volli-ok"
        ? { code: 255, stderr: "Host key verification failed." }
        : undefined,
    );
    let offer = OFFER;
    const p = ports(box, { hostKeys: { discover: async () => offer, accept: async () => {} } });
    const asked = await advanceWith(start(), p);
    offer = { ...OFFER, fingerprints: [{ type: "ED25519", fingerprint: "SHA256:mitm" }] };
    const again = await advanceWith(answer(asked, { kind: "accept-host-key" }), p);
    expect(stoppedWith(again)).toMatchObject({ kind: "host-key", offer });
    // Accepted, but the box still fails strict checking: asked once more, never looped.
    offer = OFFER;
    const accepted = answer(asked, { kind: "accept-host-key" });
    expect(stoppedWith(await advanceWith(accepted, p))).toMatchObject({ kind: "host-key" });
    // An answer that is not to a host-key question records nothing.
    expect(answer(start(), { kind: "accept-host-key" }).decisions).toEqual({});
  });

  it("fails as the box is unreachable when it shows no key at all", async () => {
    const box = fakeBox((script) =>
      script === "echo volli-ok"
        ? { code: 255, stderr: "Host key verification failed." }
        : undefined,
    );
    const state = await advanceWith(
      start(),
      ports(box, { hostKeys: { discover: async () => null, accept: async () => {} } }),
    );
    expect(stoppedWith(state)).toMatchObject({ code: "unreachable", step: "connect" });
  });

  it("types every way ssh can fail, and a shell that answered nothing", async () => {
    for (const [stderr, code, expected] of [
      ["ssh: connect to host box port 22: Connection refused", 255, "unreachable"],
      ["ssh: Could not resolve hostname box: Name or service not known", 255, "unresolvable"],
      ["WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!", 255, "host-key-changed"],
      ["Permission denied (password).", 255, "password-only"],
      ["Permission denied (publickey).", 255, "key-refused"],
      ["spawn ssh ENOENT", 127, "ssh-missing"],
      ["mux_client_request_session: read from master failed", 255, "ssh-failed"],
      ["", 0, "ssh-failed"],
      ["broken shell", 1, "ssh-failed"],
    ] as const) {
      const box = fakeBox((script) => (script === "echo volli-ok" ? { code, stderr } : undefined));
      expect(stoppedWith(await advanceWith(start(), ports(box)))).toMatchObject({
        code: expected,
        step: "connect",
      });
    }
  });
});

describe("probe", () => {
  const probing = (output: string) =>
    fakeBox((script) => (script === PROBE_SCRIPT ? { stdout: output } : undefined));

  it("refuses a box Volli cannot run on, each for its own reason", async () => {
    for (const [overrides, expected] of [
      [{ kernel: "FreeBSD" }, { code: "unsupported-system", system: "FreeBSD" }],
      [{ kernel: "" }, { code: "unsupported-system", system: "this system" }],
      [{ arch: "riscv64" }, { code: "unsupported-arch", arch: "riscv64" }],
      [{ arch: "aarch64" }, { code: "target-unavailable", target: "linux-arm64" }],
      [
        { kernel: "Darwin", arch: "arm64" },
        { code: "target-unavailable", target: "darwin-arm64" },
      ],
      [{ systemd: null }, { code: "no-systemd" }],
      [{ glibc: "2.31" }, { code: "glibc-too-old", glibc: "2.31" }],
      [{ sudo: null, groups: "deploy", user_manager: null }, { code: "no-user-manager" }],
    ] as const) {
      const state = await advanceWith(
        start(),
        ports(probing(probeOutput(overrides as Record<string, string | null>))),
      );
      expect(stoppedWith(state)).toMatchObject({ step: "probe", ...expected });
    }
  });

  it("installs on arm64 once this build pins an arm64 hostd", async () => {
    const box = probing(probeOutput({ arch: "aarch64" }));
    const state = await advanceWith(
      start({ supportedTargets: ["linux-x64", "linux-arm64"] }),
      ports(box),
    );
    expect(state.status).toBe("done");
    expect(state.results.probe?.artifactTarget).toBe("linux-arm64");
  });

  it("says how much disk is missing, and checks again", async () => {
    let free = "98304";
    const box = fakeBox((script) =>
      script === PROBE_SCRIPT ? { stdout: probeOutput({ disk_system: free }) } : undefined,
    );
    const p = ports(box);
    const full = await advanceWith(start(), p);
    expect(stoppedWith(full)).toEqual({
      code: "disk-full",
      step: "probe",
      freeBytes: 98304 * 1024,
      needBytes: 420 * 1024 ** 2,
    });
    free = "10000000";
    expect((await advanceWith(retry(full), p)).status).toBe("done");
    // A user install is measured in the home directory.
    const home = probing(probeOutput({ sudo: null, groups: "deploy", disk_home: "1" }));
    expect(stoppedWith(await advanceWith(start(), ports(home)))).toMatchObject({
      code: "disk-full",
    });
  });

  it("reports a probe that could not run, and a connection that dropped during it", async () => {
    const failing = fakeBox((script) =>
      script === PROBE_SCRIPT ? { code: 2, stderr: "sh: syntax error" } : undefined,
    );
    expect(stoppedWith(await advanceWith(start(), ports(failing)))).toMatchObject({
      code: "probe-failed",
      detail: "sh: syntax error",
    });
    const dropped = fakeBox((script) =>
      script === PROBE_SCRIPT
        ? { code: 255, stderr: "Connection closed by 10.0.0.2 port 22" }
        : undefined,
    );
    expect(stoppedWith(await advanceWith(start(), ports(dropped)))).toMatchObject({
      code: "connection-lost",
      step: "probe",
    });
  });

  it("refuses a hostd newer than this app", async () => {
    const box = probing(probeOutput({}, existing("2.0.0", "system", { verdict: "serving" })));
    expect(stoppedWith(await advanceWith(start(), ports(box)))).toMatchObject({
      code: "host-newer",
      version: "2.0.0",
    });
  });

  it("needs sudo to touch a system install, whatever its version", async () => {
    const box = probing(
      probeOutput({ sudo: null, groups: "deploy" }, existing("1.0.0", "system", null)),
    );
    const asked = await advanceWith(start(), ports(box));
    expect(stoppedWith(asked)).toMatchObject({ kind: "existing-hostd", adoptable: false });
    expect(
      stoppedWith(await advanceWith(answer(asked, { kind: "update" }), ports(box))),
    ).toMatchObject({
      code: "needs-sudo",
      version: "1.0.0",
    });
  });
});

/** A Mac's probe answer (VC-700 PR 1c). */
const MAC = {
  kernel: "Darwin",
  arch: "arm64",
  os_id: "macos",
  os_version: "26.5.1",
  os_name: "macOS 26.5.1",
  groups: "staff admin",
  systemd: null,
  user_manager: null,
  linger: null,
  glibc: null,
  disk_system: "1",
  sudo: null,
  mem_kb: null,
  launchd: "yes",
  mem_bytes: "17179869184",
};

describe("a Mac", () => {
  it("installs a launchd agent as the person once this build carries a Mac host", async () => {
    const box = fakeBox((script) =>
      script === PROBE_SCRIPT ? { stdout: probeOutput(MAC) } : undefined,
    );
    const done = await advanceWith(start({ supportedTargets: ["darwin-arm64"] }), ports(box));
    expect(done.status).toBe("done");
    expect(modeOf(done)).toBe("user");
    expect(done.results.probe?.artifactTarget).toBe("darwin-arm64");
    expect(box.ran()).toContain(`'${STAGED}/bin/volli-hostd' install --user </dev/null`);
    expect(box.ran().some((script) => script.startsWith("sudo"))).toBe(false);
  });

  // VC-700 PR 1c: the release pin carries darwin, so a Mac is no longer target-unavailable.
  it("installs on a Mac end to end from a four-target VC-701 manifest, and dev defaults refuse it", async () => {
    const macName = "volli-hostd-1.1.0-darwin-arm64.tar.gz";
    const asset = (platform: string, arch: string) => ({
      platform,
      arch,
      name: `volli-hostd-1.1.0-${platform}-${arch}.tar.gz`,
      sha256: SHA,
    });
    const pin = parseHostdReleasePin({
      schemaVersion: 1,
      version: "1.1.0",
      releaseTag: "v1.1.0",
      assets: [
        asset("linux", "x64"),
        asset("linux", "arm64"),
        asset("darwin", "arm64"),
        asset("darwin", "x64"),
      ],
    });
    const box = fakeBox((script) =>
      script === PROBE_SCRIPT ? { stdout: probeOutput(MAC) } : undefined,
    );
    expect(stoppedWith(await advanceWith(start(), ports(box)))).toMatchObject({
      code: "target-unavailable",
      target: "darwin-arm64",
    });
    const fetched: string[] = [];
    const p = ports(box, {
      artifact: (target) =>
        resolveArtifact({
          version: "1.1.0",
          target,
          pin,
          cacheDir: join(root, "cache"),
          logger: recordingLogger().logger,
          fetch: async (url) => {
            fetched.push(String(url));
            return new Response(BYTES);
          },
        }),
    });
    const done = await advanceWith(start({ supportedTargets: supportedTargets(pin) }), p);
    expect(done.status).toBe("done");
    expect(done.results.probe?.artifactTarget).toBe("darwin-arm64");
    expect(fetched).toEqual([
      `https://github.com/hussainph/volli-code/releases/download/v1.1.0/${macName}`,
    ]);
    const ran = box.ran();
    expect(ran.some((script) => script.includes(macName))).toBe(true);
    for (const verb of ["install --user", "start --user", "enroll --user"]) {
      expect(
        ran.some((script) => script.includes(` ${verb} `) || script.includes(` ${verb}`)),
      ).toBe(true);
    }
    expect(
      ran.some((script) => /\bsudo\b|loginctl|systemctl/u.test(script) && script !== PROBE_SCRIPT),
    ).toBe(false);
  });

  it("checks a Mac's disk in the home directory, whatever sudo allows", async () => {
    const box = fakeBox((script) =>
      script === PROBE_SCRIPT
        ? { stdout: probeOutput({ ...MAC, disk_home: "1", sudo: "nopasswd" }) }
        : undefined,
    );
    expect(
      stoppedWith(await advanceWith(start({ supportedTargets: ["darwin-arm64"] }), ports(box))),
    ).toMatchObject({ code: "disk-full" });
  });
});

describe("an existing hostd", () => {
  const serving: Partial<HostdManagedStatus> = {
    verdict: "serving",
    running: { state: "serving", version: "1.0.0", pid: 1, hostId: HOST_ID, listen: LISTEN },
    devices: [],
  };

  it("updates an older one, keeping its mode", async () => {
    const box = fakeBox((script) =>
      script === PROBE_SCRIPT
        ? { stdout: probeOutput({}, existing("1.0.0", "user", serving)) }
        : undefined,
    );
    const asked = await advanceWith(start(), ports(box));
    expect(stoppedWith(asked)).toEqual({
      kind: "existing-hostd",
      step: "probe",
      version: "1.0.0",
      mode: "user",
      adoptable: true,
    });
    const done = await advanceWith(answer(asked, { kind: "update" }), ports(box));
    expect(done.status).toBe("done");
    expect(modeOf(done)).toBe("user");
    expect(box.ran()).toContain(`'${STAGED}/bin/volli-hostd' install --user </dev/null`);
  });

  it("adopts an older one as it stands: no upload, no install, no restart while it serves", async () => {
    const box = fakeBox((script) =>
      script === PROBE_SCRIPT
        ? { stdout: probeOutput({}, existing("1.0.0", "system", serving)) }
        : undefined,
    );
    const asked = await advanceWith(start(), ports(box));
    const done = await advanceWith(answer(asked, { kind: "adopt" }), ports(box));
    expect(done.status).toBe("done");
    expect(done.results.deliver).toEqual({ skipped: true });
    expect(done.results.install).toEqual({ skipped: true, binary: CURRENT, mode: "system" });
    expect(done.results.start).toEqual({ skipped: true });
    expect(
      box.ran().filter((script) => script !== PROBE_SCRIPT && script.includes(CURRENT)),
    ).toEqual([
      `sudo -n '${CURRENT}' enroll --system --public-key 'SPKI' --name 'Alice'\\''s Mac' </dev/null`,
    ]);
  });

  it("starts an adopted one that is not serving", async () => {
    const box = fakeBox((script) =>
      script === PROBE_SCRIPT
        ? {
            stdout: probeOutput(
              {},
              existing("1.0.0", "system", { verdict: "not-serving", running: null, devices: [] }),
            ),
          }
        : undefined,
    );
    const done = await advanceWith(
      answer(await advanceWith(start(), ports(box)), { kind: "adopt" }),
      ports(box),
    );
    expect(done.results.start).toMatchObject({ ok: true });
  });

  it("always updates one from before VC-700, which cannot be enrolled with", async () => {
    const box = fakeBox((script) =>
      script === PROBE_SCRIPT
        ? { stdout: probeOutput({}, existing("0.2.4", "system", null)) }
        : undefined,
    );
    const asked = await advanceWith(start(), ports(box));
    const done = await advanceWith(answer(asked, { kind: "adopt" }), ports(box));
    expect(done.results.deliver).toMatchObject({ reused: false });
  });

  it("goes straight to the tunnel for a box this Mac is already enrolled with", async () => {
    const paired = existing("1.1.0", "system", {
      ...serving,
      running: { ...serving.running!, version: "1.1.0" },
      devices: [
        {
          deviceId: DEVICE_ID,
          name: "Mac",
          fingerprint: "SHA256:mac",
          enrolledAt: "t",
          via: "ssh",
          revokedAt: null,
        },
      ],
    });
    const box = fakeBox((script) =>
      script === PROBE_SCRIPT ? { stdout: probeOutput({}, paired) } : undefined,
    );
    const asked = await advanceWith(start({ pinnedHostId: HOST_ID }), ports(box));
    expect(stoppedWith(asked)).toEqual({ kind: "already-paired", step: "probe", hostId: HOST_ID });
    const p = ports(box);
    const done = await advanceWith(answer(asked, { kind: "open" }), p);
    expect(done.status).toBe("done");
    expect(done.results.enroll).toMatchObject({
      hostId: HOST_ID,
      deviceId: DEVICE_ID,
      created: false,
    });
    expect(p.tunnels).toEqual([LISTEN]);
    expect(
      box.ran().some((script) => script.includes(" install ") || script.includes(" enroll ")),
    ).toBe(false);
    // Enrolled with a host that has since been replaced: not "already paired".
    const replaced = await advanceWith(start({ pinnedHostId: DEVICE_ID }), ports(box));
    expect(replaced.status).toBe("stopped");
    expect(replaced.stop?.kind === "question" && replaced.stop.question.kind).not.toBe(
      "already-paired",
    );
  });
});

describe("upload", () => {
  it("says when there is no tarball for this version", async () => {
    const box = fakeBox();
    const state = await advanceWith(
      start(),
      ports(box, {
        artifact: async () => ({ kind: "artifact-unavailable", detail: "not published" }),
      }),
    );
    expect(stoppedWith(state)).toEqual({
      code: "artifact-unavailable",
      step: "deliver",
      detail: "not published",
    });
  });

  it("refuses what arrived different from what was sent, and discards it", async () => {
    const box = fakeBox((script) =>
      script.includes(".part' 2>/dev/null; } | cut") ? { stdout: "deadbeef\n" } : undefined,
    );
    expect(stoppedWith(await advanceWith(start(), ports(box)))).toMatchObject({
      code: "remote-checksum",
    });
    expect(box.ran().some((script) => script.startsWith("rm -f "))).toBe(true);
    const empty = fakeBox((script) =>
      script.includes(".part' 2>/dev/null; } | cut") ? { stdout: "" } : undefined,
    );
    expect(stoppedWith(await advanceWith(start(), ports(empty)))).toMatchObject({
      detail: expect.stringContaining("arrived as nothing"),
    });
  });

  it("types a copy that failed, an unpack that failed, and a connection that dropped", async () => {
    const lostAt = (marker: string) =>
      fakeBox((script) =>
        script.includes(marker) ? { code: 255, stderr: "Connection reset by peer" } : undefined,
      );
    // At the check, the copy, the verification and the extraction alike.
    for (const marker of [
      ".tar.gz' 2>/dev/null; } | cut",
      "cat > ",
      ".part' 2>/dev/null; } | cut",
      "tar -xzf",
    ]) {
      const state = await advanceWith(start(), ports(lostAt(marker)));
      expect(stoppedWith(state)).toMatchObject({ code: "connection-lost", step: "deliver" });
    }
    const full = fakeBox((script) =>
      script.includes("cat > ") ? { code: 1, stderr: "No space left on device" } : undefined,
    );
    expect(stoppedWith(await advanceWith(start(), ports(full)))).toEqual({
      code: "upload-failed",
      step: "deliver",
      detail: "No space left on device",
    });
    for (const [result, detail] of [
      [{ code: 2, stderr: "tar: corrupt" }, "tar: corrupt"],
      [{ code: 1 }, "exit 1"],
      [{ stdout: `dir=${STAGED}\nversion=1.0.0\n` }, "it reports 1.0.0"],
      [{ stdout: `dir=${STAGED}\nversion=\n` }, "it reports no version"],
      [{ stdout: "dir=/tmp/elsewhere\nversion=1.1.0\n" }, "it unpacked to /tmp/elsewhere"],
      [{ stdout: "" }, "it unpacked to nowhere"],
    ] as const) {
      const box = fakeBox((script) => (script.includes("tar -xzf") ? result : undefined));
      expect(stoppedWith(await advanceWith(start(), ports(box)))).toEqual({
        code: "unpack-failed",
        step: "deliver",
        detail,
      });
    }
  });

  it("classifies a disconnect during upload verification as connection-lost", async () => {
    const box = fakeBox((script) =>
      script.includes(".part' 2>/dev/null; } | cut")
        ? { code: 255, stdout: "", stderr: "Connection reset by peer" }
        : undefined,
    );
    const state = await advanceWith(start(), ports(box));
    expect(stoppedWith(state)).toMatchObject({ code: "connection-lost", step: "deliver" });
    expect(box.ran().some((script) => script.startsWith("rm -f "))).toBe(false);
  });

  it("refuses a tarball that changed on the box between its check and its extraction", async () => {
    for (const [sum, said] of [
      ["deadbeef", "is deadbeef"],
      ["", "is unreadable"],
    ] as const) {
      const box = fakeBox((script) =>
        script.includes("tar -xzf") ? { code: 3, stdout: `checksum=${sum}\n` } : undefined,
      );
      expect(stoppedWith(await advanceWith(start(), ports(box)))).toEqual({
        code: "remote-checksum",
        step: "deliver",
        detail: `${FILE} on the box ${said}, not ${SHA}`,
      });
    }
  });
});

describe("sudo with a password", () => {
  const passworded = (...overrides: Handler[]) =>
    fakeBox(...overrides, (script) =>
      script === PROBE_SCRIPT ? { stdout: probeOutput({ sudo: null }) } : undefined,
    );

  it("asks for it, sends it only on sudo's stdin, and never keeps it in state or a log", async () => {
    const box = passworded();
    const p = ports(box);
    const asked = await advanceWith(start(), p);
    expect(stoppedWith(asked)).toMatchObject({
      kind: "sudo-password",
      step: "install",
      reason: "install",
      retry: false,
    });
    const secrets: ProvisionSecrets = { sudoPassword: "hunter2" };
    const done = await advanceWith(
      answer(asked, { kind: "sudo-password", password: "hunter2" }),
      p,
      secrets,
    );
    expect(done.status).toBe("done");
    const sudoed = box.scripts.filter((entry) => entry.script.startsWith("sudo -S -p '' "));
    // One sudo each, the command under `exec … </dev/null` so it never inherits the password.
    expect(sudoed.map((entry) => entry.script)).toEqual([
      `sudo -S -p '' sh -c 'exec '\\''${STAGED}/bin/volli-hostd'\\'' install --system --operator '\\''deploy'\\'' </dev/null'`,
      expect.stringMatching(
        /^sudo -S -p '' sh -c 'exec sh -c .*operator-token --for .* <\/dev\/null'$/su,
      ),
      `sudo -S -p '' sh -c 'exec '\\''${CURRENT}'\\'' start --system </dev/null'`,
      expect.stringMatching(/^sudo -S -p '' sh -c 'exec .* enroll --system .* <\/dev\/null'$/u),
    ]);
    expect(sudoed.map((entry) => entry.stdin)).toEqual([
      "hunter2\n",
      "hunter2\n",
      "hunter2\n",
      "hunter2\n",
    ]);
    expect(box.ran().join("\n")).not.toContain("hunter2");
    expect(JSON.stringify(done)).not.toContain("hunter2");
    expect(JSON.stringify(p.log.lines)).not.toContain("hunter2");
  });

  it("asks again after a wrong one, and forgets it", async () => {
    const box = passworded((script, options) =>
      script.startsWith("sudo -S") && options.stdin === "wrong\n"
        ? { code: 1, stderr: "Sorry, try again.\nsudo: 1 incorrect password attempt" }
        : undefined,
    );
    const secrets: ProvisionSecrets = { sudoPassword: "wrong" };
    const asked = await advanceWith(start(), ports(box), secrets);
    expect(stoppedWith(asked)).toMatchObject({ kind: "sudo-password", retry: true });
    expect(secrets.sudoPassword).toBeNull();
  });

  it("settles for a user unit, which shares the person's account", async () => {
    const box = passworded();
    const asked = await advanceWith(start(), ports(box));
    const done = await advanceWith(answer(asked, { kind: "user-install" }), ports(box));
    expect(done.status).toBe("done");
    expect(modeOf(done)).toBe("user");
    expect(box.ran()).toContain(
      `'/home/deploy/.local/share/volli-hostd/current/bin/volli-hostd' enroll --user --public-key 'SPKI' --name 'Alice'\\''s Mac' </dev/null`,
    );
    // …but not on a box with no user session to run it in.
    const sessionless = fakeBox((script) =>
      script === PROBE_SCRIPT
        ? { stdout: probeOutput({ sudo: null, user_manager: null }) }
        : undefined,
    );
    const again = await advanceWith(start(), ports(sessionless));
    expect(
      stoppedWith(await advanceWith(answer(again, { kind: "user-install" }), ports(sessionless))),
    ).toMatchObject({
      code: "no-user-manager",
    });
  });
});

describe("install, start and enroll on the box", () => {
  it("reports what hostd refused, with its reason and detail", async () => {
    const box = fakeBox((script) =>
      script.includes(" install --")
        ? json({ v: 1, ok: false, code: "bad-release", message: "Not a release.", detail: ["x"] })
        : undefined,
    );
    expect(stoppedWith(await advanceWith(start(), ports(box)))).toEqual({
      code: "hostd-refused",
      step: "install",
      hostd: "bad-release",
      message: "Not a release.",
      detail: ["x"],
    });
    const quiet = fakeBox((script) =>
      script.includes(" start --")
        ? json({ v: 1, ok: false, code: "start-failed", message: "Did not start." })
        : undefined,
    );
    expect(stoppedWith(await advanceWith(start(), ports(quiet)))).toMatchObject({
      step: "start",
      detail: [],
    });
  });

  it("reports a command that printed no answer, naming the likely cause and the next step, and one whose connection dropped", async () => {
    const missing = fakeBox((script) =>
      script.includes(" enroll --") ? { code: 127, stderr: "volli-hostd: not found\n" } : undefined,
    );
    expect(stoppedWith(await advanceWith(start(), ports(missing)))).toEqual({
      code: "hostd-refused",
      step: "enroll",
      hostd: "no-answer",
      message: "Volli host is missing on box. Try again to put it back.",
      detail: ["volli-hostd: not found"],
    });
    const unrunnable = fakeBox((script) =>
      script.includes(" enroll --")
        ? {
            code: 126,
            stderr: "sh: 1: /opt/volli-hostd/current/bin/volli-hostd: Permission denied",
          }
        : undefined,
    );
    expect(stoppedWith(await advanceWith(start(), ports(unrunnable)))).toMatchObject({
      message:
        "Volli host on box can’t run; its permissions or runtime may be wrong. Fix the error in Details, then try again.",
    });
    // The probe believed sudo needed no password; it does.
    const sudoed = fakeBox((script) =>
      script.includes(" install --")
        ? { code: 1, stderr: "sudo: a password is required" }
        : undefined,
    );
    expect(stoppedWith(await advanceWith(start(), ports(sudoed)))).toMatchObject({
      message: "sudo on box wants a password after all. Check the box’s sudo, then try again.",
    });
    const quiet = fakeBox((script) =>
      script.includes(" start --") ? { stdout: "volli-hostd: starting\n" } : undefined,
    );
    expect(stoppedWith(await advanceWith(start(), ports(quiet)))).toMatchObject({
      message:
        "Volli host on box may have crashed or returned an incompatible start answer. Try again to re-check it and install a matching copy.",
    });
    const diagnostic = fakeBox((script) =>
      script.includes(" start --") ? { code: 1, stderr: "hostd crashed" } : undefined,
    );
    expect(stoppedWith(await advanceWith(start(), ports(diagnostic)))).toMatchObject({
      message:
        "Volli host on box may have crashed or returned an incompatible start answer. Fix the error in Details, then try again.",
      detail: ["hostd crashed"],
    });
    const silentUnrunnable = fakeBox((script) =>
      script.includes(" enroll --") ? { code: 126 } : undefined,
    );
    expect(stoppedWith(await advanceWith(start(), ports(silentUnrunnable)))).toMatchObject({
      message:
        "Volli host on box can’t run; its permissions or runtime may be wrong. Try again to re-check it and install a matching copy.",
      detail: [],
    });
    const dropped = fakeBox((script) =>
      script.includes(" install --")
        ? { code: 255, stderr: "Connection closed by host" }
        : undefined,
    );
    expect(stoppedWith(await advanceWith(start(), ports(dropped)))).toMatchObject({
      code: "connection-lost",
      step: "install",
    });
  });

  it("puts a missing Volli host back: its silence is retried from a fresh probe, never into the same wall", async () => {
    let missing = true;
    const box = fakeBox((script) =>
      script.includes(" install --") && missing
        ? {
            code: 127,
            stderr:
              "sh: 1: /home/deploy/.cache/volli-hostd/stage.Ab12Cd/bin/volli-hostd: not found",
          }
        : undefined,
    );
    const p = ports(box);
    const stopped = await advanceWith(start(), p);
    const failure = stoppedWith(stopped);
    expect(failure).toMatchObject({
      code: "hostd-refused",
      step: "install",
      hostd: "no-answer",
      message: "Volli host is missing on box. Try again to put it back.",
    });
    // The recovery the person is shown, and the step it retries from.
    if (!("code" in failure)) throw new Error("expected a failure");
    expect(describeFailure(failure, "box").recovery).toEqual({
      action: "retry",
      label: "Try again",
      from: "probe",
    });
    missing = false;
    expect((await advanceWith(retry(stopped, "probe"), p)).status).toBe("done");
  });

  it("re-probes changed sudo rights rather than repeating an outdated passwordless install", async () => {
    let needsPassword = false;
    const box = fakeBox((script) => {
      if (script === PROBE_SCRIPT)
        return { stdout: probeOutput({ sudo: needsPassword ? "password" : "nopasswd" }) };
      if (script.includes(" install --")) {
        needsPassword = true;
        return { code: 1, stderr: "sudo: a password is required" };
      }
      return undefined;
    });
    const p = ports(box);
    const stopped = await advanceWith(start(), p);
    const failure = stoppedWith(stopped);
    if (!("code" in failure)) throw new Error("expected a failure");
    const recovery = describeFailure(failure, "box").recovery;
    if (recovery.action !== "retry") throw new Error("expected a retry");
    const asked = await advanceWith(retry(stopped, recovery.from), p);
    expect(stoppedWith(asked)).toMatchObject({ kind: "sudo-password", step: "install" });
    expect(box.ran().filter((script) => script.includes(" install --"))).toHaveLength(1);
  });

  it("a fresh probe drops an adopt decision when the adopted binary stops answering", async () => {
    let broken = false;
    const box = fakeBox((script) => {
      if (script === PROBE_SCRIPT)
        return {
          stdout: probeOutput(
            {},
            existing(
              "1.0.0",
              "system",
              broken ? null : { verdict: "serving", running: null, devices: [] },
            ),
          ),
        };
      if (script.includes(" start --")) {
        broken = true;
        return { code: 127, stderr: "volli-hostd: not found" };
      }
      return undefined;
    });
    const p = ports(box);
    const existingHost = await advanceWith(start(), p);
    const stopped = await advanceWith(answer(existingHost, { kind: "adopt" }), p);
    const failure = stoppedWith(stopped);
    if (!("code" in failure)) throw new Error("expected a failure");
    const recovery = describeFailure(failure, "box").recovery;
    if (recovery.action !== "retry") throw new Error("expected a retry");
    const asked = await advanceWith(retry(stopped, recovery.from), p);
    expect(stoppedWith(asked)).toMatchObject({ kind: "existing-hostd", adoptable: false });
    expect(asked.decisions.existing).toBeUndefined();
  });

  it("retries from the step that broke, never redoing the ones before", async () => {
    let fail = true;
    const box = fakeBox((script) =>
      script.includes(" start --") && fail
        ? json({ v: 1, ok: false, code: "start-timeout", message: "Did not serve within 60 s." })
        : undefined,
    );
    const p = ports(box);
    const stopped = await advanceWith(start(), p);
    fail = false;
    const before = box.ran().length;
    const done = await advanceWith(retry(stopped), p);
    expect(done.status).toBe("done");
    expect(box.ran().slice(before)).toEqual([
      `sudo -n '${CURRENT}' start --system </dev/null`,
      expect.stringContaining(" enroll --system"),
    ]);
    // Or from an earlier step, by name.
    expect(nextStep(retry(done, "deliver"))).toBe("deliver");
    expect(retry(initialProvisionState<SshStepResults>(REQUEST))).toMatchObject({
      status: "ready",
    });
    expect(nextStep(retry({ ...done, status: "stopped", stop: null }))).toBeNull();
    // A stopped state does not run until it is answered or retried.
    expect(await advanceWith(stopped, p)).toBe(stopped);
  });

  it("asks before trusting a host that is not the one this Mac pinned", async () => {
    const box = fakeBox();
    const asked = await advanceWith(start({ pinnedHostId: DEVICE_ID }), ports(box));
    expect(stoppedWith(asked)).toEqual({
      kind: "identity-changed",
      step: "enroll",
      pinned: DEVICE_ID,
      hostId: HOST_ID,
    });
    const done = await advanceWith(answer(asked, { kind: "repair" }), ports(box));
    expect(done.status).toBe("done");
    expect(done.decisions.repin).toBe(true);
    expect((await advanceWith(start({ pinnedHostId: HOST_ID }), ports(fakeBox()))).status).toBe(
      "done",
    );
  });
});

describe("a user unit's lingering", () => {
  /** A box whose `start --user` wants lingering until `loginctl enable-linger` ran. */
  const userBox = (facts: Record<string, string | null>, ...overrides: Handler[]) => {
    let lingering = false;
    return fakeBox(...overrides, (script) => {
      if (script.includes("loginctl enable-linger")) {
        lingering = true;
        return {};
      }
      if (script.includes(" start --user") && !lingering) {
        return json({
          v: 1,
          ok: false,
          code: "linger-required",
          message: "Run: sudo loginctl enable-linger deploy",
        });
      }
      return script === PROBE_SCRIPT ? { stdout: probeOutput(facts) } : undefined;
    });
  };
  /** sudo with a password: the person settles for a user unit, which then needs lingering. */
  const PASSWORD = { sudo: null };
  const asUser = async (box: ReturnType<typeof fakeBox>, secrets?: ProvisionSecrets) => {
    const asked = await advanceWith(start(), ports(box));
    expect(stoppedWith(asked)).toMatchObject({ kind: "sudo-password", reason: "install" });
    return advanceWith(answer(asked, { kind: "user-install" }), ports(box), secrets);
  };

  it("asks for sudo's password to turn it on, and sends it only to sudo", async () => {
    const box = userBox(PASSWORD);
    const asked = await asUser(box);
    expect(stoppedWith(asked)).toEqual({
      kind: "sudo-password",
      step: "start",
      reason: "linger",
      command: "sudo loginctl enable-linger 'deploy'",
      retry: false,
    });
    const secrets = { sudoPassword: "pw" };
    const done = await advanceWith(
      answer(asked, { kind: "sudo-password", password: "pw" }),
      ports(box),
      secrets,
    );
    expect(done.status).toBe("done");
    expect(box.scripts.find((entry) => entry.script.includes("enable-linger"))).toEqual({
      script: `sudo -S -p '' sh -c 'exec loginctl enable-linger '\\''deploy'\\'' </dev/null'`,
      stdin: "pw\n",
    });
  });

  it("asks again when sudo refused, and forgets a password it refused", async () => {
    const box = userBox(PASSWORD, (script) =>
      script.includes("enable-linger") ? { code: 1, stderr: "Sorry" } : undefined,
    );
    const secrets = { sudoPassword: "pw" };
    const asked = await asUser(box, secrets);
    expect(stoppedWith(asked)).toMatchObject({
      kind: "sudo-password",
      reason: "linger",
      retry: true,
    });
    expect(secrets.sudoPassword).toBeNull();
  });

  it("stops for an administrator when this login has no sudo, and asks for no password", async () => {
    const box = userBox({ sudo: null, groups: "deploy" });
    const stopped = await advanceWith(start(), ports(box), { sudoPassword: "never-used" });
    expect(stoppedWith(stopped)).toEqual({
      code: "linger-needs-admin",
      step: "start",
      user: "deploy",
      command: "sudo loginctl enable-linger 'deploy'",
    });
    expect(box.ran().some((script) => script.startsWith("sudo"))).toBe(false);
    // Once an administrator turned it on, checking again carries on from start.
    expect(nextStep(retry(stopped))).toBe("start");
    const lingering = fakeBox((script) =>
      script === PROBE_SCRIPT
        ? { stdout: probeOutput({ sudo: null, groups: "deploy" }) }
        : undefined,
    );
    expect((await advanceWith(retry(stopped), ports(lingering))).status).toBe("done");
  });

  it("runs the linger command with sudo -n when that works, for an adopted user unit", async () => {
    const serving: Partial<HostdManagedStatus> = {
      verdict: "not-serving",
      running: null,
      devices: [],
    };
    const box = userBox({}, (script) =>
      script === PROBE_SCRIPT
        ? { stdout: probeOutput({}, existing("1.0.0", "user", serving)) }
        : undefined,
    );
    const asked = await advanceWith(start(), ports(box));
    const done = await advanceWith(answer(asked, { kind: "adopt" }), ports(box));
    expect(done.status).toBe("done");
    expect(box.ran()).toContain("sudo -n loginctl enable-linger 'deploy' </dev/null");
  });

  it("keeps a sudo -n refusal from looping", async () => {
    const box = userBox({}, (script) =>
      script.includes("enable-linger")
        ? { code: 1 }
        : script === PROBE_SCRIPT
          ? {
              stdout: probeOutput(
                {},
                existing("1.0.0", "user", { verdict: "not-serving", running: null, devices: [] }),
              ),
            }
          : undefined,
    );
    const secrets = { sudoPassword: "kept" };
    const asked = await advanceWith(
      answer(await advanceWith(start(), ports(box)), { kind: "adopt" }),
      ports(box),
      secrets,
    );
    expect(stoppedWith(asked)).toMatchObject({ kind: "sudo-password", retry: true });
    expect(secrets.sudoPassword).toBe("kept");
  });

  it("says the connection dropped while turning it on", async () => {
    const box = userBox(PASSWORD, (script) =>
      script.includes("enable-linger")
        ? { code: 255, stderr: "Connection closed by 10.0.0.2 port 22" }
        : undefined,
    );
    const stopped = await asUser(box, { sudoPassword: "pw" });
    expect(stoppedWith(stopped)).toMatchObject({ code: "connection-lost", step: "start" });
  });
});

describe("the tunnel", () => {
  it("fails when the host listens nowhere, or the tunnel would not open", async () => {
    const deaf = fakeBox(
      (script) =>
        script.includes(" start --") ? json({ ...STARTED("system"), listen: null }) : undefined,
      (script) => (script.includes(" enroll --") ? json({ ...ENROLLED, listen: null }) : undefined),
    );
    expect(stoppedWith(await advanceWith(start(), ports(deaf)))).toMatchObject({
      code: "tunnel-failed",
    });
    const refused = ports(fakeBox(), {
      openTunnel: async () => ({ error: "bind: Address already in use" }),
    });
    expect(stoppedWith(await advanceWith(start(), refused))).toEqual({
      code: "tunnel-failed",
      step: "link",
      detail: "bind: Address already in use",
    });
    // The start answer's listener wins; the enroll answer is the fallback.
    const fromEnroll = ports(
      fakeBox((script) =>
        script.includes(" start --") ? json({ ...STARTED("system"), listen: null }) : undefined,
      ),
    );
    expect((await advanceWith(start(), fromEnroll)).status).toBe("done");
    expect(fromEnroll.tunnels).toEqual([LISTEN]);
  });
});

describe("the state's mode", () => {
  it("is unknown before the probe", () => {
    expect(modeOf(initialProvisionState<SshStepResults>(REQUEST))).toBeNull();
  });
});

describe("retrying after the box changed", () => {
  const PAIRED = existing("1.1.0", "system", {
    verdict: "serving",
    running: { state: "serving", version: "1.1.0", pid: 42, hostId: HOST_ID, listen: LISTEN },
    devices: [
      {
        deviceId: DEVICE_ID,
        name: "mac",
        fingerprint: REQUEST.device.fingerprint,
        enrolledAt: "t",
        via: "ssh",
        revokedAt: null,
      },
    ],
  });

  it("retry after host reinstall discards prior already-paired decision", async () => {
    let reinstalled = false;
    const box = fakeBox((script) =>
      script === PROBE_SCRIPT ? { stdout: probeOutput({}, reinstalled ? "" : PAIRED) } : undefined,
    );
    const p = ports(box, { openTunnel: async () => ({ error: "connection lost" }) });
    const question = await advanceWith(start(), p);
    const failed = await advanceWith(answer(question, { kind: "open" }), p);
    expect(failed.stop).toMatchObject({ kind: "failed", failure: { step: "link" } });
    // The box was wiped and set up again: no hostd, no pairing.
    reinstalled = true;
    const retried = retry(failed, "probe");
    expect(retried.decisions.alreadyPaired).toBeUndefined();
    const done = await advanceWith(retried, ports(box));
    expect(done).toMatchObject({ status: "done", results: { deliver: { reused: false } } });
    expect(done.results.enroll).toMatchObject({ created: true });
  });

  it("asks again whether to update or use an older hostd once the box was checked again", async () => {
    let version = "1.0.0";
    const box = fakeBox((script) =>
      script === PROBE_SCRIPT
        ? {
            stdout: probeOutput(
              {},
              existing(version, "system", { verdict: "serving", running: null, devices: [] }),
            ),
          }
        : undefined,
    );
    const p = ports(box, { openTunnel: async () => ({ error: "no route" }) });
    const adopted = await advanceWith(answer(await advanceWith(start(), p), { kind: "adopt" }), p);
    expect(adopted.stop).toMatchObject({ kind: "failed", failure: { step: "link" } });
    version = "0.9.0";
    const asked = await advanceWith(retry(adopted, "probe"), p);
    expect(stoppedWith(asked)).toMatchObject({ kind: "existing-hostd", version: "0.9.0" });
  });
});

describe("a state it did not expect", () => {
  /** A state as a damaged store might hand it back: some results null, decisions at odds. */
  const damaged = (results: Record<string, unknown>, decisions = {}): State => ({
    ...start(),
    results: results as SshStepResults,
    decisions,
  });
  const probed = (overrides: Record<string, string | null> = {}, extra = "") => {
    const facts = parseProbe(probeOutput(overrides, extra));
    return { ...facts, artifactTarget: "linux-x64" };
  };

  it("stops with a typed failure, retried from the probe, never an exception", async () => {
    const p = ports(fakeBox());
    for (const [state, step, detail] of [
      [damaged({ connect: { ok: true }, probe: null }), "deliver", "no probe facts"],
      [
        // Already paired, says the decision; no hostd at all, says the probe.
        damaged({ connect: { ok: true }, probe: probed() }, { alreadyPaired: true }),
        "install",
        "no existing hostd to use",
      ],
      [
        damaged({ connect: { ok: true }, probe: probed(), deliver: { skipped: true } }),
        "install",
        "no delivered release to install",
      ],
      [
        damaged({ connect: { ok: true }, probe: probed(), deliver: null }),
        "install",
        "no delivered release to install",
      ],
      [
        damaged({ connect: { ok: true }, probe: probed(), deliver: {}, install: null }),
        "start",
        "no install result",
      ],
      [
        damaged(
          {
            connect: { ok: true },
            probe: probed(),
            deliver: {},
            install: INSTALLED("system"),
            start: null,
          },
          { alreadyPaired: true },
        ),
        "enroll",
        "no status of the paired host",
      ],
      [
        damaged({
          connect: { ok: true },
          probe: probed(),
          deliver: {},
          install: INSTALLED("system"),
          start: {},
          enroll: null,
        }),
        "link",
        "no enrollment",
      ],
    ] as const) {
      const stopped = await advanceWith(state, p);
      expect(stoppedWith(stopped)).toEqual({ code: "unexpected-state", step, detail });
    }
  });

  it("names what an already-paired host's status lacks", async () => {
    const results = (status: Partial<HostdManagedStatus>) => ({
      connect: { ok: true },
      probe: probed({}, existing("1.1.0", "system", status)),
      deliver: { skipped: true },
      install: { skipped: true, binary: CURRENT, mode: "system" },
      start: { skipped: true },
    });
    const running = { state: "serving", version: "1.1.0", pid: 1, listen: LISTEN } as const;
    const device = {
      deviceId: DEVICE_ID,
      name: "mac",
      fingerprint: "SHA256:mac",
      enrolledAt: "t",
      via: "ssh",
      revokedAt: null,
    } as const;
    for (const [status, detail] of [
      [{ running: null, devices: [device] }, "no running paired host"],
      [{ running: { ...running, hostId: HOST_ID } }, "no enrollment of this device"],
      [
        { running: { ...running, hostId: HOST_ID }, devices: [{ ...device, revokedAt: "t" }] },
        "no enrollment of this device",
      ],
      [
        { running: { ...running, hostId: null }, devices: [device] },
        "no host id of the paired host",
      ],
    ] as const) {
      const stopped = await advanceWith(
        damaged(results(status as Partial<HostdManagedStatus>), { alreadyPaired: true }),
        ports(fakeBox()),
      );
      expect(stoppedWith(stopped)).toEqual({ code: "unexpected-state", step: "enroll", detail });
    }
  });

  it("types a port that threw, too", async () => {
    const p = ports(fakeBox(), {
      artifact: async () => {
        throw new TypeError("Cannot read properties of null (reading 'binary')");
      },
    });
    expect(stoppedWith(await advanceWith(start(), p))).toEqual({
      code: "unexpected-state",
      step: "deliver",
      detail: "Cannot read properties of null (reading 'binary')",
    });
  });
});

describe("host keys that cannot be checked", () => {
  it("refuses an offer without a fingerprint for each key, and asks nothing", async () => {
    const box = fakeBox((script) =>
      script === "echo volli-ok"
        ? { code: 255, stderr: "Host key verification failed." }
        : undefined,
    );
    for (const [offer, detail] of [
      [{ entries: ["box ssh-ed25519 AAAA"], fingerprints: [] }, "1 keys, 0 fingerprints"],
      [
        {
          entries: ["box ssh-ed25519 AAAA", "box ssh-rsa BBBB"],
          fingerprints: OFFER.fingerprints,
        },
        "2 keys, 1 fingerprints",
      ],
    ] as const) {
      const p = ports(box, { hostKeys: { discover: async () => offer, accept: async () => {} } });
      // Even with an empty acceptance on record from before.
      const state = { ...start(), decisions: { acceptedHostKeys: [] } };
      expect(stoppedWith(await advanceWith(state, p))).toEqual({
        code: "host-key-unverifiable",
        step: "connect",
        detail,
      });
      expect(p.accepted).toEqual([]);
    }
  });
});

describe("a probe cut short", () => {
  it("fails closed rather than act on part of the facts", async () => {
    const whole = probeOutput({}, existing("1.0.0", "system", null));
    const cut = whole.slice(0, whole.indexOf("hostd_path="));
    for (const [result, expected] of [
      [{ stdout: cut }, { code: "probe-failed", detail: "The check's answer was incomplete" }],
      [{ stdout: cut, code: 255, stderr: "Connection reset by peer" }, { code: "connection-lost" }],
      [
        { stdout: whole, code: 1, stderr: "killed" },
        { code: "probe-failed", detail: "killed" },
      ],
    ] as const) {
      const box = fakeBox((script) => (script === PROBE_SCRIPT ? result : undefined));
      const state = await advanceWith(start(), ports(box));
      expect(stoppedWith(state)).toMatchObject({ step: "probe", ...expected });
      expect(state.results.probe).toBeUndefined();
    }
  });
});

/** Runs scripts with this machine's own `/bin/sh`, as the box would, in `cwd`. */
function localShell(cwd: string, path = process.env["PATH"] ?? "") {
  return (script: string, options: SshExecOptions = {}) =>
    runProcess(
      (command, args) =>
        nodeSpawn(command, [...args], {
          cwd,
          env: { ...process.env, PATH: path },
          stdio: ["pipe", "pipe", "pipe"],
        }),
      "/bin/sh",
      ["-c", script],
      options,
    );
}

/** The fake box's transport with the scripts `real` picks run on a real local shell. */
function partlyReal(
  box: ReturnType<typeof fakeBox>,
  real: (script: string, options: SshExecOptions) => boolean,
  shell: ReturnType<typeof localShell>,
): SshTransport {
  return {
    ...box.ssh,
    async exec(script, options = {}) {
      if (!real(script, options)) return box.ssh.exec(script, options);
      box.scripts.push({ script, stdin: typeof options.stdin === "string" ? options.stdin : null });
      return shell(script, options);
    },
  };
}

/** Only deliver's own commands. */
const deliverOnly = (_script: string, options: SshExecOptions) =>
  options.label?.startsWith("upload") === true;

/** A hostd management command. */
const hostdVerb = (script: string) => / (install|start|enroll) --/u.test(script);

describe("delivering the pinned release, on a real local shell", { timeout: 30_000 }, () => {
  /** A real release tarball: `bin/volli-hostd` prints its version. */
  function buildRelease(file = FILE) {
    const name = file.replace(/\.tar\.gz$/u, "");
    const build = join(root, "build");
    mkdirSync(join(build, name, "bin"), { recursive: true });
    writeFileSync(join(build, name, "bin/volli-hostd"), "#!/bin/sh\nprintf '1.1.0\\n'\n", {
      mode: 0o755,
    });
    writeFileSync(join(build, name, "MANIFEST.json"), '{"version":"1.1.0"}\n');
    const path = join(root, "release", file);
    mkdirSync(join(root, "release"), { recursive: true });
    execFileSync("tar", ["-czf", path, "-C", build, name], {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    const bytes = readFileSync(path);
    const artifact: HostdArtifact = {
      version: "1.1.0",
      target: "linux-x64",
      fileName: file,
      path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
      source: "cache",
    };
    return { artifact, bytes, binary: readFileSync(join(build, name, "bin/volli-hostd"), "utf8") };
  }

  /** An unpacked executable that says the right version, and leaves a mark when run. */
  const tampered = (dir: string) => {
    mkdirSync(join(dir, "bin"), { recursive: true });
    writeFileSync(
      join(dir, "bin/volli-hostd"),
      `#!/bin/sh\nprintf '1.1.0\\n'\ntouch '${join(root, "untrusted-executed")}'\n`,
      { mode: 0o755 },
    );
  };

  it("never runs or installs an unpacked tree it finds, though the pinned tarball is reused", async () => {
    const { artifact, bytes, binary } = buildRelease();
    const home = join(root, "remote");
    const cache = join(home, ".cache/volli-hostd");
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, FILE), bytes);
    // The tree an earlier version unpacked in place, and a staging tree left half-done.
    const legacy = join(cache, FILE.replace(/\.tar\.gz$/u, ""));
    tampered(legacy);
    tampered(join(cache, "stage.OLD123"));
    // Abandoned: older than an hour.
    const old = new Date(Date.now() - 2 * 3_600_000);
    utimesSync(join(cache, "stage.OLD123"), old, old);
    const box = fakeBox((script) =>
      script === PROBE_SCRIPT ? { stdout: probeOutput({ home }) } : undefined,
    );
    const ssh = partlyReal(box, deliverOnly, localShell(root));
    const done = await advanceWith(start(), ports(box, { ssh, artifact: async () => artifact }));
    expect(done.status).toBe("done");
    expect(existsSync(join(root, "untrusted-executed"))).toBe(false);
    const deliver = done.results.deliver as UploadResult;
    // Reused means the tarball was not sent again, and nothing more.
    expect(deliver.reused).toBe(true);
    expect(box.ran().some((script) => script.includes("cat > "))).toBe(false);
    expect(deliver.releaseDir.startsWith(join(cache, "stage."))).toBe(true);
    expect(deliver.releaseDir).not.toBe(join(cache, "stage.OLD123"));
    expect(readFileSync(join(deliver.releaseDir, "bin/volli-hostd"), "utf8")).toBe(binary);
    expect(statSync(deliver.releaseDir).mode & 0o777).toBe(0o755);
    expect(existsSync(legacy)).toBe(false);
    expect(existsSync(join(cache, "stage.OLD123"))).toBe(false);
    expect(box.ran()).toContain(
      `sudo -n '${deliver.releaseDir}/bin/volli-hostd' install --system --operator 'deploy' </dev/null`,
    );
  });

  // VC-700 PR 1c: a Mac's shell has shasum, not GNU sha256sum.
  it("delivers to a Mac, whose shell has no sha256sum, and installs the launchd agent", async () => {
    const file = "volli-hostd-1.1.0-darwin-arm64.tar.gz";
    const { artifact, binary } = buildRelease(file);
    const home = join(root, "Users/alice");
    mkdirSync(home, { recursive: true });
    const stubs = join(root, "stubs");
    mkdirSync(stubs);
    writeFileSync(join(stubs, "sha256sum"), "#!/bin/sh\nexit 127\n", { mode: 0o755 });
    const box = fakeBox((script) =>
      script === PROBE_SCRIPT ? { stdout: probeOutput({ ...MAC, home }) } : undefined,
    );
    const ssh = partlyReal(
      box,
      deliverOnly,
      localShell(root, `${stubs}:${process.env["PATH"] ?? ""}`),
    );
    const done = await advanceWith(
      start({ supportedTargets: ["darwin-arm64"] }),
      ports(box, { ssh, artifact: async () => ({ ...artifact, target: "darwin-arm64" }) }),
    );
    expect(done.status).toBe("done");
    const deliver = done.results.deliver as UploadResult;
    expect(deliver).toMatchObject({ reused: false, sha256: artifact.sha256 });
    expect(readFileSync(join(deliver.releaseDir, "bin/volli-hostd"), "utf8")).toBe(binary);
    expect(box.ran()).toContain(
      `'${deliver.releaseDir}/bin/volli-hostd' install --user </dev/null`,
    );
  });

  it("sends a tarball that differs from the pin, verifies it, and extracts it afresh", async () => {
    const { artifact, binary } = buildRelease();
    const home = join(root, "remote");
    const cache = join(home, ".cache/volli-hostd");
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, FILE), "not the pinned bytes");
    const box = fakeBox((script) =>
      script === PROBE_SCRIPT ? { stdout: probeOutput({ home }) } : undefined,
    );
    const ssh = partlyReal(box, deliverOnly, localShell(root));
    const p = ports(box, { ssh, artifact: async () => artifact });
    const done = await advanceWith(start(), p);
    expect(done.status).toBe("done");
    const deliver = done.results.deliver as UploadResult;
    expect(deliver).toMatchObject({ reused: false, sha256: artifact.sha256 });
    expect(p.progress.at(-1)).toBe(artifact.bytes);
    expect(
      createHash("sha256")
        .update(readFileSync(join(cache, FILE)))
        .digest("hex"),
    ).toBe(artifact.sha256);
    expect(existsSync(join(cache, `${FILE}.part`))).toBe(false);
    expect(readFileSync(join(deliver.releaseDir, "bin/volli-hostd"), "utf8")).toBe(binary);
    // Delivering again reuses the tarball, and still extracts it into a new tree.
    const again = await advanceWith(retry(done, "deliver"), p);
    const second = again.results.deliver as UploadResult;
    expect(second.reused).toBe(true);
    expect(second.releaseDir).not.toBe(deliver.releaseDir);
    // The first tree is young, so it stays (it could be another delivery's)
    // until it is abandoned: older than an hour, the next delivery removes it.
    expect(existsSync(deliver.releaseDir)).toBe(true);
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000);
    utimesSync(deliver.releaseDir, twoHoursAgo, twoHoursAgo);
    const third = (await advanceWith(retry(again, "deliver"), p)).results.deliver as UploadResult;
    expect(existsSync(deliver.releaseDir)).toBe(false);
    expect(existsSync(second.releaseDir)).toBe(true);
    expect(existsSync(third.releaseDir)).toBe(true);
  });

  // The recheck's N-B1: two desktops delivering to one account's cache.
  it("never removes another delivery's young tree, which may be awaiting its sudo password", async () => {
    const { artifact, bytes } = buildRelease();
    const home = join(root, "shared-remote");
    const cache = join(home, ".cache/volli-hostd");
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, FILE), bytes);
    const make = () => {
      const box = fakeBox((script) =>
        script === PROBE_SCRIPT ? { stdout: probeOutput({ home, sudo: null }) } : undefined,
      );
      return ports(box, {
        ssh: partlyReal(box, deliverOnly, localShell(root)),
        artifact: async () => artifact,
      });
    };
    const a = await advanceWith(start(), make());
    expect(stoppedWith(a)).toMatchObject({ kind: "sudo-password", step: "install" });
    const deliveredA = a.results.deliver as UploadResult;
    const b = await advanceWith(start(), make());
    expect(stoppedWith(b)).toMatchObject({ kind: "sudo-password", step: "install" });
    expect((b.results.deliver as UploadResult).releaseDir).not.toBe(deliveredA.releaseDir);
    // The exact executable A will hand sudo once the person answers is still there, and runs.
    const attempt = await localShell(root)(
      `exec ${shellQuote(join(deliveredA.releaseDir, "bin/volli-hostd"))} --version </dev/null`,
    );
    expect(attempt).toMatchObject({ code: 0, stdout: "1.1.0\n" });
  });

  it("keeps shell metacharacters in a remote home literal, never injected", async () => {
    const { artifact, bytes } = buildRelease();
    const home = join(root, "home with space'; touch INJECTED; #");
    const cache = join(home, ".cache/volli-hostd");
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, FILE), bytes);
    const box = fakeBox((script) =>
      script === PROBE_SCRIPT ? { stdout: probeOutput({ home }) } : undefined,
    );
    const ssh = partlyReal(box, deliverOnly, localShell(root));
    const done = await advanceWith(start(), ports(box, { ssh, artifact: async () => artifact }));
    expect(done.status).toBe("done");
    expect(existsSync(join(root, "INJECTED"))).toBe(false);
    expect(existsSync(join(cache, "INJECTED"))).toBe(false);
    expect(
      (done.results.deliver as UploadResult).releaseDir.startsWith(join(cache, "stage.")),
    ).toBe(true);
  });

  it("enables linux-arm64 end to end from a VC-701 release manifest, but dev defaults refuse it", async () => {
    const armName = "volli-hostd-1.1.0-linux-arm64.tar.gz";
    const pin = parseHostdReleasePin({
      schemaVersion: 1,
      version: "1.1.0",
      releaseTag: "v1.1.0",
      assets: [
        { platform: "linux", arch: "x64", name: FILE, sha256: SHA },
        { platform: "linux", arch: "arm64", name: armName, sha256: SHA },
      ],
    });
    expect(pin).not.toBeNull();
    const box = fakeBox((script) =>
      script === PROBE_SCRIPT ? { stdout: probeOutput({ arch: "aarch64" }) } : undefined,
    );
    const dev = await advanceWith(start(), ports(box));
    expect(stoppedWith(dev)).toMatchObject({ code: "target-unavailable", target: "linux-arm64" });
    const p = ports(box, {
      artifact: (target) =>
        resolveArtifact({
          version: "1.1.0",
          target,
          pin,
          cacheDir: join(root, "cache"),
          logger: recordingLogger().logger,
          fetch: async () => new Response(BYTES),
        }),
    });
    const release = await advanceWith(start({ supportedTargets: supportedTargets(pin) }), p);
    expect(release.status).toBe("done");
    expect(release.results.probe?.artifactTarget).toBe("linux-arm64");
    expect(box.ran().some((script) => script.includes(armName))).toBe(true);
  });
});

describe(
  "sudo's password and the command's stdin, on real local processes",
  { timeout: 30_000 },
  () => {
    const PASSWORD = "hunter2-real";

    /**
     * A stand-in `sudo` with sudo's own stdin semantics: `-S` reads a password
     * line only when it must authenticate (no NOPASSWD, no cached timestamp);
     * `-n` fails instead. A stand-in hostd records what its stdin held.
     */
    function standIns() {
      const bin = join(root, "bin");
      const release = join(root, "release-tree");
      const binary = join(release, "bin/volli-hostd");
      mkdirSync(bin, { recursive: true });
      mkdirSync(join(release, "bin"), { recursive: true });
      writeFileSync(
        join(bin, "sudo"),
        [
          "#!/bin/sh",
          "s=no; n=no",
          'while [ "$#" -gt 0 ]; do case "$1" in',
          "  -S) s=yes; shift ;; -n) n=yes; shift ;; -p|-u) shift 2 ;; *) break ;;",
          "esac; done",
          `printf '%s\\n' "$*" >> '${root}/sudo.argv'`,
          `if [ -e '${root}/nopasswd' ] || [ -e '${root}/stamp' ]; then :`,
          `elif [ "$n" = yes ]; then echo "sudo: a password is required" >&2; exit 1`,
          `elif [ "$s" = yes ] && IFS= read -r pw && [ "$pw" = '${PASSWORD}' ]; then touch '${root}/stamp'`,
          'else echo "Sorry, try again." >&2; echo "sudo: 1 incorrect password attempt" >&2; exit 1',
          "fi",
          'exec "$@"',
        ].join("\n"),
        { mode: 0o755 },
      );
      const answers = {
        install: JSON.stringify({ ...INSTALLED("system"), binary }),
        start: JSON.stringify(STARTED("system")),
        enroll: JSON.stringify(ENROLLED),
      };
      writeFileSync(
        binary,
        [
          "#!/bin/sh",
          `cat > '${root}/'"$1"'.stdin'`,
          'case "$1" in',
          ...Object.entries(answers).map(([verb, line]) => `${verb}) printf '%s\\n' '${line}' ;;`),
          "esac",
        ].join("\n"),
        { mode: 0o755 },
      );
      return { bin, release };
    }

    async function run(sudo: "password" | "nopasswd", secrets: ProvisionSecrets) {
      const { bin, release } = standIns();
      const box = fakeBox(
        (script) =>
          script === PROBE_SCRIPT
            ? { stdout: probeOutput(sudo === "nopasswd" ? {} : { sudo: null }) }
            : undefined,
        (script) =>
          script.includes("tar -xzf")
            ? { stdout: `dir=/home/deploy/.cache/volli-hostd/stage.x\nversion=1.1.0\n` }
            : undefined,
      );
      // The staged tree the fake deliver names is the stand-in release here.
      const shell = localShell(root, `${bin}:${process.env["PATH"] ?? ""}`);
      const ssh = partlyReal(box, hostdVerb, (script, options) =>
        shell(script.replaceAll("/home/deploy/.cache/volli-hostd/stage.x", release), options),
      );
      const p = ports(box, { ssh });
      const state = await advanceWith(start(), p, secrets);
      const read = (name: string) =>
        existsSync(join(root, name)) ? readFileSync(join(root, name), "utf8") : null;
      const everything = [
        box.ran().join("\n"),
        JSON.stringify(state),
        JSON.stringify(p.log.lines),
        read("sudo.argv") ?? "",
      ].join("\n");
      return {
        state,
        box,
        stdin: ["install", "start", "enroll"].map((verb) => read(`${verb}.stdin`)),
        leaked: everything.includes(PASSWORD),
      };
    }

    it("password required on first use: sudo takes it, the commands after read nothing", async () => {
      const result = await run("password", { sudoPassword: PASSWORD });
      expect(result.state.status).toBe("done");
      expect(result.stdin).toEqual(["", "", ""]);
      expect(result.leaked).toBe(false);
      expect(existsSync(join(root, "stamp"))).toBe(true);
    });

    it("cached timestamp: sudo reads nothing, and the command still never sees the password", async () => {
      writeFileSync(join(root, "stamp"), "");
      const result = await run("password", { sudoPassword: PASSWORD });
      expect(result.state.status).toBe("done");
      expect(result.stdin).toEqual(["", "", ""]);
      expect(result.leaked).toBe(false);
      // Each command was still given the password on the script's stdin, for sudo only.
      expect(result.box.scripts.filter((entry) => hostdVerb(entry.script))).toHaveLength(3);
    });

    it("NOPASSWD: sudo -n, no password anywhere, stdin empty", async () => {
      writeFileSync(join(root, "nopasswd"), "");
      const result = await run("nopasswd", { sudoPassword: PASSWORD });
      expect(result.state.status).toBe("done");
      expect(result.stdin).toEqual(["", "", ""]);
      expect(result.leaked).toBe(false);
      expect(
        result.box
          .ran()
          .filter(hostdVerb)
          .every((script) => script.startsWith("sudo -n ")),
      ).toBe(true);
    });

    it("a wrong password is asked for again, and nothing ran", async () => {
      const secrets: ProvisionSecrets = { sudoPassword: "wrong" };
      const result = await run("password", secrets);
      expect(stoppedWith(result.state)).toMatchObject({
        kind: "sudo-password",
        step: "install",
        retry: true,
      });
      expect(secrets.sudoPassword).toBeNull();
      expect(result.stdin).toEqual([null, null, null]);
    });
  },
);
