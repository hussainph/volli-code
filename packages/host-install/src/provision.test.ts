import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import type { HostdArtifact } from "./artifact";
import type { HostdManagedStatus } from "./contract";
import { PROBE_SCRIPT } from "./probe";
import {
  advance,
  answer,
  initialProvisionState,
  modeOf,
  nextStep,
  retry,
  type ProvisionPorts,
  type ProvisionRequest,
  type ProvisionSecrets,
  type ProvisionState,
} from "./provision";
import type { HostKeyOffer, SshExecOptions, SshExecResult, SshTransport } from "./ssh";
import { recordingLogger } from "./testing/fake-process";

const HOST_ID = "0f6a3a8e-2b1c-4d5e-8f90-1a2b3c4d5e6f";
const DEVICE_ID = "1f6a3a8e-2b1c-4d5e-8f90-1a2b3c4d5e6f";
const BYTES = "pretend tarball";
const SHA = createHash("sha256").update(BYTES).digest("hex");
const FILE = "volli-hostd-1.1.0-linux-x64.tar.gz";
const RELEASE = "/home/deploy/.cache/volli-hostd/volli-hostd-1.1.0-linux-x64";
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
  return `${Object.entries(facts)
    .filter(([, value]) => value !== null)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")}\n${extra}`;
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
  const defaults: Handler = (script) => {
    if (script === "echo volli-ok") return { stdout: "volli-ok\n" };
    if (script === PROBE_SCRIPT) return { stdout: probeOutput() };
    if (script.startsWith("sha256sum ") && script.includes("--version")) return { stdout: "\n" };
    if (script.includes("cat > ")) return {};
    if (script.includes(".part' | cut")) return { stdout: `${SHA}\n` };
    if (script.includes("tar -xzf")) return { stdout: "1.1.0\n" };
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

function ports(box: ReturnType<typeof fakeBox>, overrides: Partial<ProvisionPorts> = {}) {
  const log = recordingLogger();
  const accepted: HostKeyOffer[] = [];
  const steps: string[] = [];
  const progress: number[] = [];
  const tunnels: unknown[] = [];
  const value: ProvisionPorts = {
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
    logger: log.logger,
    onStep: (step) => steps.push(step),
    onUploadProgress: (sent) => progress.push(sent),
    ...overrides,
  };
  return { value, log, accepted, steps, progress, tunnels };
}

const REQUEST: ProvisionRequest = {
  target: { destination: "deploy@box", port: null, label: "box" },
  appVersion: "1.1.0",
  device: { publicKey: "SPKI", fingerprint: "SHA256:mac", name: "Alice's Mac" },
  pinnedHostId: null,
};

const start = (request: Partial<ProvisionRequest> = {}) =>
  initialProvisionState({ ...REQUEST, ...request });

function stoppedWith(state: ProvisionState) {
  expect(state.status).toBe("stopped");
  return state.stop!.kind === "failed" ? state.stop!.failure : state.stop!.question;
}

describe("adding a fresh box with passwordless sudo", () => {
  it("connects, probes, uploads, installs a system unit, starts, enrolls and tunnels", async () => {
    const box = fakeBox();
    const p = ports(box);
    const done = await advance(start(), p.value);
    expect(done.status).toBe("done");
    expect(p.steps).toEqual(["connect", "probe", "upload", "install", "start", "enroll", "tunnel"]);
    expect(p.progress).toEqual([BYTES.length]);
    expect(p.tunnels).toEqual([LISTEN]);
    expect(modeOf(done)).toBe("system");
    expect(done.results.enroll).toMatchObject({ hostId: HOST_ID, deviceId: DEVICE_ID });
    expect(done.results.tunnel).toEqual({ url: "ws://127.0.0.1:55000" });
    expect(done.results.upload).toMatchObject({ releaseDir: RELEASE, reused: false });
    expect(box.ran().filter((script) => / (install|start|enroll) --/u.test(script))).toEqual([
      `sudo -n '${RELEASE}/bin/volli-hostd' install --system --operator 'deploy'`,
      `sudo -n '${CURRENT}' start --system`,
      `sudo -n -u volli '${CURRENT}' enroll --system --public-key 'SPKI' --name 'Alice'\\''s Mac'`,
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
    expect(await advance(done, p.value)).toMatchObject({ status: "done" });
  });

  it("does not send a tarball the box already has unpacked", async () => {
    const box = fakeBox((script) =>
      script.startsWith("sha256sum ") && script.includes("--version")
        ? { stdout: `${SHA}\n1.1.0\n` }
        : undefined,
    );
    const done = await advance(start(), ports(box).value);
    expect(done.results.upload).toMatchObject({ reused: true });
    expect(box.ran().some((script) => script.includes("cat > "))).toBe(false);
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
    const asked = await advance(start(), p.value);
    expect(stoppedWith(asked)).toEqual({ kind: "host-key", step: "connect", offer: OFFER });
    const done = await advance(answer(asked, { kind: "accept-host-key" }), p.value);
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
    const asked = await advance(start(), p.value);
    offer = { ...OFFER, fingerprints: [{ type: "ED25519", fingerprint: "SHA256:mitm" }] };
    const again = await advance(answer(asked, { kind: "accept-host-key" }), p.value);
    expect(stoppedWith(again)).toMatchObject({ kind: "host-key", offer });
    // Accepted, but the box still fails strict checking: asked once more, never looped.
    offer = OFFER;
    const accepted = answer(asked, { kind: "accept-host-key" });
    expect(stoppedWith(await advance(accepted, p.value))).toMatchObject({ kind: "host-key" });
    // An answer that is not to a host-key question records nothing.
    expect(answer(start(), { kind: "accept-host-key" }).decisions).toEqual({});
  });

  it("fails as the box is unreachable when it shows no key at all", async () => {
    const box = fakeBox((script) =>
      script === "echo volli-ok"
        ? { code: 255, stderr: "Host key verification failed." }
        : undefined,
    );
    const state = await advance(
      start(),
      ports(box, { hostKeys: { discover: async () => null, accept: async () => {} } }).value,
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
      expect(stoppedWith(await advance(start(), ports(box).value))).toMatchObject({
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
      [
        { kernel: "Darwin", arch: "arm64" },
        { code: "unsupported-system", system: "Darwin" },
      ],
      [{ kernel: "" }, { code: "unsupported-system", system: "this system" }],
      [{ arch: "aarch64" }, { code: "unsupported-arch", arch: "aarch64" }],
      [{ systemd: null }, { code: "no-systemd" }],
      [{ glibc: "2.31" }, { code: "glibc-too-old", glibc: "2.31" }],
      [{ sudo: null, groups: "deploy", user_manager: null }, { code: "no-user-manager" }],
    ] as const) {
      const state = await advance(
        start(),
        ports(probing(probeOutput(overrides as Record<string, string | null>))).value,
      );
      expect(stoppedWith(state)).toMatchObject({ step: "probe", ...expected });
    }
  });

  it("installs on arm64 once this build pins an arm64 hostd", async () => {
    const box = probing(probeOutput({ arch: "aarch64" }));
    const state = await advance(
      start({ supportedTargets: ["linux-x64", "linux-arm64"] }),
      ports(box).value,
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
    const full = await advance(start(), p.value);
    expect(stoppedWith(full)).toEqual({
      code: "disk-full",
      step: "probe",
      freeBytes: 98304 * 1024,
      needBytes: 420 * 1024 ** 2,
    });
    free = "10000000";
    expect((await advance(retry(full), p.value)).status).toBe("done");
    // A user install is measured in the home directory.
    const home = probing(probeOutput({ sudo: null, groups: "deploy", disk_home: "1" }));
    expect(stoppedWith(await advance(start(), ports(home).value))).toMatchObject({
      code: "disk-full",
    });
  });

  it("reports a probe that could not run, and a connection that dropped during it", async () => {
    const failing = fakeBox((script) =>
      script === PROBE_SCRIPT ? { code: 2, stderr: "sh: syntax error" } : undefined,
    );
    expect(stoppedWith(await advance(start(), ports(failing).value))).toMatchObject({
      code: "probe-failed",
      detail: "sh: syntax error",
    });
    const dropped = fakeBox((script) =>
      script === PROBE_SCRIPT
        ? { code: 255, stderr: "Connection closed by 10.0.0.2 port 22" }
        : undefined,
    );
    expect(stoppedWith(await advance(start(), ports(dropped).value))).toMatchObject({
      code: "connection-lost",
      step: "probe",
    });
  });

  it("refuses a hostd newer than this app", async () => {
    const box = probing(probeOutput({}, existing("2.0.0", "system", { verdict: "serving" })));
    expect(stoppedWith(await advance(start(), ports(box).value))).toMatchObject({
      code: "host-newer",
      version: "2.0.0",
    });
  });

  it("needs sudo to touch a system install, whatever its version", async () => {
    const box = probing(
      probeOutput({ sudo: null, groups: "deploy" }, existing("1.0.0", "system", null)),
    );
    const asked = await advance(start(), ports(box).value);
    expect(stoppedWith(asked)).toMatchObject({ kind: "existing-hostd", adoptable: false });
    expect(
      stoppedWith(await advance(answer(asked, { kind: "update" }), ports(box).value)),
    ).toMatchObject({
      code: "needs-sudo",
      version: "1.0.0",
    });
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
    const asked = await advance(start(), ports(box).value);
    expect(stoppedWith(asked)).toEqual({
      kind: "existing-hostd",
      step: "probe",
      version: "1.0.0",
      mode: "user",
      adoptable: true,
    });
    const done = await advance(answer(asked, { kind: "update" }), ports(box).value);
    expect(done.status).toBe("done");
    expect(modeOf(done)).toBe("user");
    expect(box.ran()).toContain(`'${RELEASE}/bin/volli-hostd' install --user`);
  });

  it("adopts an older one as it stands: no upload, no install, no restart while it serves", async () => {
    const box = fakeBox((script) =>
      script === PROBE_SCRIPT
        ? { stdout: probeOutput({}, existing("1.0.0", "system", serving)) }
        : undefined,
    );
    const asked = await advance(start(), ports(box).value);
    const done = await advance(answer(asked, { kind: "adopt" }), ports(box).value);
    expect(done.status).toBe("done");
    expect(done.results.upload).toEqual({ skipped: true });
    expect(done.results.install).toEqual({ skipped: true, binary: CURRENT, mode: "system" });
    expect(done.results.start).toEqual({ skipped: true });
    expect(
      box.ran().filter((script) => script !== PROBE_SCRIPT && script.includes(CURRENT)),
    ).toEqual([
      `sudo -n -u volli '${CURRENT}' enroll --system --public-key 'SPKI' --name 'Alice'\\''s Mac'`,
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
    const done = await advance(
      answer(await advance(start(), ports(box).value), { kind: "adopt" }),
      ports(box).value,
    );
    expect(done.results.start).toMatchObject({ ok: true });
  });

  it("always updates one from before VC-700, which cannot be enrolled with", async () => {
    const box = fakeBox((script) =>
      script === PROBE_SCRIPT
        ? { stdout: probeOutput({}, existing("0.2.4", "system", null)) }
        : undefined,
    );
    const asked = await advance(start(), ports(box).value);
    const done = await advance(answer(asked, { kind: "adopt" }), ports(box).value);
    expect(done.results.upload).toMatchObject({ reused: false });
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
    const asked = await advance(start({ pinnedHostId: HOST_ID }), ports(box).value);
    expect(stoppedWith(asked)).toEqual({ kind: "already-paired", step: "probe", hostId: HOST_ID });
    const p = ports(box);
    const done = await advance(answer(asked, { kind: "open" }), p.value);
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
    const replaced = await advance(start({ pinnedHostId: DEVICE_ID }), ports(box).value);
    expect(replaced.status).toBe("stopped");
    expect(replaced.stop?.kind === "question" && replaced.stop.question.kind).not.toBe(
      "already-paired",
    );
  });
});

describe("upload", () => {
  it("says when there is no tarball for this version", async () => {
    const box = fakeBox();
    const state = await advance(
      start(),
      ports(box, {
        artifact: async () => ({ kind: "artifact-unavailable", detail: "not published" }),
      }).value,
    );
    expect(stoppedWith(state)).toEqual({
      code: "artifact-unavailable",
      step: "upload",
      detail: "not published",
    });
  });

  it("refuses what arrived different from what was sent, and discards it", async () => {
    const box = fakeBox((script) =>
      script.includes(".part' | cut") ? { stdout: "deadbeef\n" } : undefined,
    );
    expect(stoppedWith(await advance(start(), ports(box).value))).toMatchObject({
      code: "remote-checksum",
    });
    expect(box.ran().some((script) => script.startsWith("rm -f "))).toBe(true);
    const empty = fakeBox((script) =>
      script.includes(".part' | cut") ? { stdout: "" } : undefined,
    );
    expect(stoppedWith(await advance(start(), ports(empty).value))).toMatchObject({
      detail: expect.stringContaining("arrived as nothing"),
    });
  });

  it("types a copy that failed, an unpack that failed, and a connection that dropped", async () => {
    const lostAt = (marker: string) =>
      fakeBox((script) =>
        script.includes(marker) ? { code: 255, stderr: "Connection reset by peer" } : undefined,
      );
    for (const marker of ["sha256sum '", "cat > ", "tar -xzf"]) {
      expect(stoppedWith(await advance(start(), ports(lostAt(marker)).value))).toMatchObject({
        code: "connection-lost",
        step: "upload",
      });
    }
    const full = fakeBox((script) =>
      script.includes("cat > ") ? { code: 1, stderr: "No space left on device" } : undefined,
    );
    expect(stoppedWith(await advance(start(), ports(full).value))).toEqual({
      code: "upload-failed",
      step: "upload",
      detail: "No space left on device",
    });
    for (const [result, detail] of [
      [{ code: 2, stderr: "tar: corrupt" }, "tar: corrupt"],
      [{ stdout: "1.0.0\n" }, "it reports 1.0.0"],
      [{ stdout: "" }, "it reports no version"],
    ] as const) {
      const box = fakeBox((script) => (script.includes("tar -xzf") ? result : undefined));
      expect(stoppedWith(await advance(start(), ports(box).value))).toEqual({
        code: "unpack-failed",
        step: "upload",
        detail,
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
    const asked = await advance(start(), p.value);
    expect(stoppedWith(asked)).toMatchObject({
      kind: "sudo-password",
      step: "install",
      reason: "install",
      retry: false,
    });
    const secrets: ProvisionSecrets = { sudoPassword: "hunter2" };
    const done = await advance(
      answer(asked, { kind: "sudo-password", password: "hunter2" }),
      p.value,
      secrets,
    );
    expect(done.status).toBe("done");
    const sudoed = box.scripts.filter((entry) => entry.script.startsWith("sudo -S -p '' "));
    expect(sudoed.map((entry) => entry.stdin)).toEqual(["hunter2\n", "hunter2\n", "hunter2\n"]);
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
    const asked = await advance(start(), ports(box).value, secrets);
    expect(stoppedWith(asked)).toMatchObject({ kind: "sudo-password", retry: true });
    expect(secrets.sudoPassword).toBeNull();
  });

  it("settles for a user unit, which shares the person's account", async () => {
    const box = passworded();
    const asked = await advance(start(), ports(box).value);
    const done = await advance(answer(asked, { kind: "user-install" }), ports(box).value);
    expect(done.status).toBe("done");
    expect(modeOf(done)).toBe("user");
    expect(box.ran()).toContain(
      `'${RELEASE}/bin/volli-hostd' enroll --user --public-key 'SPKI' --name 'Alice'\\''s Mac'`.replace(
        `'${RELEASE}/bin/volli-hostd'`,
        "'/home/deploy/.local/share/volli-hostd/current/bin/volli-hostd'",
      ),
    );
    // …but not on a box with no user session to run it in.
    const sessionless = fakeBox((script) =>
      script === PROBE_SCRIPT
        ? { stdout: probeOutput({ sudo: null, user_manager: null }) }
        : undefined,
    );
    const again = await advance(start(), ports(sessionless).value);
    expect(
      stoppedWith(await advance(answer(again, { kind: "user-install" }), ports(sessionless).value)),
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
    expect(stoppedWith(await advance(start(), ports(box).value))).toEqual({
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
    expect(stoppedWith(await advance(start(), ports(quiet).value))).toMatchObject({
      step: "start",
      detail: [],
    });
  });

  it("reports a command that printed no answer, and one whose connection dropped", async () => {
    const box = fakeBox((script) =>
      script.includes(" enroll --") ? { code: 127, stderr: "volli-hostd: not found\n" } : undefined,
    );
    expect(stoppedWith(await advance(start(), ports(box).value))).toEqual({
      code: "hostd-refused",
      step: "enroll",
      hostd: "no-answer",
      message: "volli-hostd enroll gave no answer",
      detail: ["volli-hostd: not found"],
    });
    const dropped = fakeBox((script) =>
      script.includes(" install --")
        ? { code: 255, stderr: "Connection closed by host" }
        : undefined,
    );
    expect(stoppedWith(await advance(start(), ports(dropped).value))).toMatchObject({
      code: "connection-lost",
      step: "install",
    });
  });

  it("retries from the step that broke, never redoing the ones before", async () => {
    let fail = true;
    const box = fakeBox((script) =>
      script.includes(" start --") && fail
        ? json({ v: 1, ok: false, code: "start-timeout", message: "Did not serve within 60 s." })
        : undefined,
    );
    const p = ports(box);
    const stopped = await advance(start(), p.value);
    fail = false;
    const before = box.ran().length;
    const done = await advance(retry(stopped), p.value);
    expect(done.status).toBe("done");
    expect(box.ran().slice(before)).toEqual([
      `sudo -n '${CURRENT}' start --system`,
      expect.stringContaining(" enroll --system"),
    ]);
    // Or from an earlier step, by name.
    expect(nextStep(retry(done, "upload"))).toBe("upload");
    expect(retry(initialProvisionState(REQUEST))).toMatchObject({ status: "ready" });
    expect(nextStep(retry({ ...done, status: "stopped", stop: null }))).toBeNull();
    // A stopped state does not run until it is answered or retried.
    expect(await advance(stopped, p.value)).toBe(stopped);
  });

  it("asks before trusting a host that is not the one this Mac pinned", async () => {
    const box = fakeBox();
    const asked = await advance(start({ pinnedHostId: DEVICE_ID }), ports(box).value);
    expect(stoppedWith(asked)).toEqual({
      kind: "identity-changed",
      step: "enroll",
      pinned: DEVICE_ID,
      hostId: HOST_ID,
    });
    const done = await advance(answer(asked, { kind: "repair" }), ports(box).value);
    expect(done.status).toBe("done");
    expect(done.decisions.repin).toBe(true);
    expect((await advance(start({ pinnedHostId: HOST_ID }), ports(fakeBox()).value)).status).toBe(
      "done",
    );
  });
});

describe("a user unit's lingering", () => {
  const userBox = (sudo: string | null, ...overrides: Handler[]) => {
    let lingering = false;
    const box = fakeBox(...overrides, (script) => {
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
      return script === PROBE_SCRIPT
        ? { stdout: probeOutput({ sudo, ...(sudo === null ? { groups: "deploy" } : {}) }) }
        : undefined;
    });
    return box;
  };

  it("turns it on with sudo when sudo needs no password", async () => {
    const box = userBox(null);
    // No sudo at all: the person is asked, since only they can.
    const asked = await advance(start(), ports(box).value);
    expect(stoppedWith(asked)).toEqual({
      kind: "sudo-password",
      step: "start",
      reason: "linger",
      command: "sudo loginctl enable-linger 'deploy'",
      retry: false,
    });
    const secrets = { sudoPassword: "pw" };
    const done = await advance(
      answer(asked, { kind: "sudo-password", password: "pw" }),
      ports(box).value,
      secrets,
    );
    expect(done.status).toBe("done");
    expect(box.scripts.find((entry) => entry.script.includes("enable-linger"))).toEqual({
      script: "sudo -S -p '' loginctl enable-linger 'deploy'",
      stdin: "pw\n",
    });
  });

  it("asks again when sudo refused, and forgets a password it refused", async () => {
    const box = userBox(null, (script) =>
      script.includes("enable-linger") ? { code: 1, stderr: "Sorry" } : undefined,
    );
    const secrets = { sudoPassword: "pw" };
    const asked = await advance(start(), ports(box).value, secrets);
    expect(stoppedWith(asked)).toMatchObject({
      kind: "sudo-password",
      reason: "linger",
      retry: true,
    });
    expect(secrets.sudoPassword).toBeNull();
  });

  it("runs the linger command with sudo -n when that works, for an adopted user unit", async () => {
    const serving: Partial<HostdManagedStatus> = {
      verdict: "not-serving",
      running: null,
      devices: [],
    };
    const box = userBox("nopasswd", (script) =>
      script === PROBE_SCRIPT
        ? { stdout: probeOutput({}, existing("1.0.0", "user", serving)) }
        : undefined,
    );
    const asked = await advance(start(), ports(box).value);
    const done = await advance(answer(asked, { kind: "adopt" }), ports(box).value);
    expect(done.status).toBe("done");
    expect(box.ran()).toContain("sudo -n loginctl enable-linger 'deploy'");
  });

  it("keeps a sudo -n refusal from looping", async () => {
    const box = userBox("nopasswd", (script) =>
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
    const asked = await advance(
      answer(await advance(start(), ports(box).value), { kind: "adopt" }),
      ports(box).value,
      secrets,
    );
    expect(stoppedWith(asked)).toMatchObject({ kind: "sudo-password", retry: true });
    expect(secrets.sudoPassword).toBe("kept");
  });
});

describe("the tunnel", () => {
  it("fails when the host listens nowhere, or the tunnel would not open", async () => {
    const deaf = fakeBox(
      (script) =>
        script.includes(" start --") ? json({ ...STARTED("system"), listen: null }) : undefined,
      (script) => (script.includes(" enroll --") ? json({ ...ENROLLED, listen: null }) : undefined),
    );
    expect(stoppedWith(await advance(start(), ports(deaf).value))).toMatchObject({
      code: "tunnel-failed",
    });
    const refused = ports(fakeBox(), {
      openTunnel: async () => ({ error: "bind: Address already in use" }),
    });
    expect(stoppedWith(await advance(start(), refused.value))).toEqual({
      code: "tunnel-failed",
      step: "tunnel",
      detail: "bind: Address already in use",
    });
    // The start answer's listener wins; the enroll answer is the fallback.
    const fromEnroll = ports(
      fakeBox((script) =>
        script.includes(" start --") ? json({ ...STARTED("system"), listen: null }) : undefined,
      ),
    );
    expect((await advance(start(), fromEnroll.value)).status).toBe("done");
    expect(fromEnroll.tunnels).toEqual([LISTEN]);
  });
});

describe("the state's mode", () => {
  it("is unknown before the probe", () => {
    expect(modeOf(initialProvisionState(REQUEST))).toBeNull();
  });
});
