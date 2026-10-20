import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawn as nodeSpawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  acceptHostKeys,
  classifySshFailure,
  connectionOptions,
  discoverHostKeys,
  ensureControlDir,
  CANCELLED,
  exitsWithin,
  runProcess,
  shellQuote,
  systemSsh,
  TIMED_OUT,
  UnsafeControlDirError,
} from "./ssh";
import { fakeChild, recordingLogger, scriptedSpawn, type FakeChild } from "./testing/fake-process";

const TARGET = { destination: "deploy@box", port: null, label: "box" };
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "host-install-ssh-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const thrown = () => {
  throw new Error("no spawn");
};

const failure = (stderr: string, code = 255) => classifySshFailure({ code, stdout: "", stderr });

describe("what an ssh failure means", () => {
  it("tells each lab failure state apart from ssh's own words", () => {
    expect(failure("ssh: connect to host box port 22: Operation timed out")).toMatchObject({
      kind: "unreachable",
    });
    expect(failure("ssh: connect to host box port 22: Connection refused")).toMatchObject({
      kind: "unreachable",
    });
    expect(
      failure("ssh: Could not resolve hostname nope: nodename nor servname provided"),
    ).toMatchObject({
      kind: "unresolvable",
    });
    expect(
      failure(
        "No ED25519 host key is known for box and you have requested strict checking.\nHost key verification failed.",
      ),
    ).toMatchObject({
      kind: "host-key-unknown",
      detail: expect.stringContaining("Host key verification failed."),
    });
    expect(
      failure(
        "@@@\nWARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!\nHost key verification failed.",
      ),
    ).toMatchObject({
      kind: "host-key-changed",
    });
    expect(failure("deploy@box: Permission denied (publickey).")).toMatchObject({
      kind: "key-refused",
    });
    expect(failure("deploy@box: Permission denied (publickey,password).")).toMatchObject({
      kind: "key-refused",
    });
    expect(failure("deploy@box: Permission denied (password,keyboard-interactive).")).toMatchObject(
      {
        kind: "password-only",
      },
    );
    expect(failure("kex_exchange_identification: read: Connection reset by peer")).toMatchObject({
      kind: "unreachable",
    });
    expect(failure("something else")).toMatchObject({
      kind: "ssh-failed",
      detail: "something else",
    });
    expect(failure("spawn ssh ENOENT", 127)).toMatchObject({ kind: "ssh-missing" });
    expect(failure("sh: volli-hostd: not found", 127)).toBeNull();
    expect(failure("", 1)).toBeNull();
  });

  it("keeps the last meaningful lines, never the added-host warning", () => {
    expect(
      failure(
        "Warning: Permanently added 'box' (ED25519) to the list of known hosts.\n\na\nb\nc\nd",
      )?.detail,
    ).toBe("b c d");
  });
});

describe("the runner's options", () => {
  it("quotes for any remote shell", () => {
    expect(shellQuote("it's here")).toBe(`'it'\\''s here'`);
  });

  it("never prompts, never trusts an unknown key, and forwards nothing", () => {
    const options = connectionOptions("/tmp/v/%C");
    expect(options).toEqual(
      expect.arrayContaining([
        "BatchMode=yes",
        "StrictHostKeyChecking=yes",
        "ForwardAgent=no",
        "ClearAllForwardings=yes",
        "PermitLocalCommand=no",
        "ForkAfterAuthentication=no",
      ]),
    );
    expect(options).toContain("ControlPath=/tmp/v/%C");
    expect(connectionOptions(null)).toContain("ControlPath=none");
  });
});

describe("running a process", () => {
  it("feeds a string to stdin and collects both streams", async () => {
    const { spawn, children } = scriptedSpawn((child) => {
      void child.stdin.then((input) => {
        child.out(`got ${input}`);
        child.err("note");
        child.exit(0);
      });
    });
    expect(await runProcess(spawn, "ssh", ["x"], { stdin: "pw\n" })).toEqual({
      code: 0,
      stdout: "got pw\n",
      stderr: "note",
    });
    expect(children[0]!.args).toEqual(["x"]);
  });

  it("streams a file to stdin and reports the bytes as they go", async () => {
    const { spawn } = scriptedSpawn((child) => {
      void child.stdin.then(() => child.exit(0));
    });
    const seen: number[] = [];
    await runProcess(spawn, "ssh", [], {
      stdin: Readable.from([Buffer.from("abc"), Buffer.from("de")]),
      onProgress: (bytes) => seen.push(bytes),
    });
    expect(seen).toEqual([3, 5]);
  });

  it("answers ssh's failure code for a spawn error, a missing binary, a kill and a timeout", async () => {
    const missing = scriptedSpawn((child) =>
      child.fail(Object.assign(new Error("spawn ssh ENOENT"), { code: "ENOENT" })),
    );
    expect(await runProcess(missing.spawn, "ssh", [])).toMatchObject({
      code: 127,
      stderr: "spawn ssh ENOENT",
    });
    const broken = scriptedSpawn((child) =>
      child.fail(Object.assign(new Error("EACCES"), { code: "EACCES" })),
    );
    expect((await runProcess(broken.spawn, "ssh", [])).code).toBe(255);
    const killed = scriptedSpawn((child) => child.exit(null));
    expect((await runProcess(killed.spawn, "ssh", [])).code).toBe(255);
    expect(await runProcess(thrown, "ssh", [])).toEqual({
      code: 127,
      stdout: "",
      stderr: "no spawn",
    });
    const hung = scriptedSpawn(() => {});
    const result = await runProcess(hung.spawn, "ssh", [], { timeoutMs: 5, killAfterMs: 5 });
    expect(result).toMatchObject({ code: 255, stderr: TIMED_OUT });
    expect(classifySshFailure(result)?.kind).toBe("unreachable");
    // Ignored SIGTERM, then SIGKILL; answered once there was nothing left to wait on.
    expect(hung.children[0]!.killed).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("answers a command it ends only once its process has exited", async () => {
    let exited = false;
    const { spawn, children } = scriptedSpawn((child) => {
      child.err("partial");
      child.process.kill = ((signal: string) => {
        child.killed.push(signal);
        if (signal === "SIGKILL") {
          exited = true;
          child.exit(null);
        }
        return true;
      }) as never;
    });
    const controller = new AbortController();
    const running = runProcess(spawn, "ssh", [], {
      timeoutMs: 5,
      killAfterMs: 10,
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 8));
    // Already ending on its timeout: an abort now changes nothing.
    controller.abort();
    const result = await running;
    expect(exited).toBe(true);
    expect(children[0]!.killed).toEqual(["SIGTERM", "SIGKILL"]);
    expect(result).toEqual({ code: 255, stdout: "", stderr: `partial\n${TIMED_OUT}` });
  });

  it("ends a command when its signal aborts, and spawns nothing for one already aborted", async () => {
    const controller = new AbortController();
    const { spawn, children } = scriptedSpawn((child) => {
      child.process.kill = ((signal: string) => {
        child.killed.push(signal);
        child.exit(null);
        return true;
      }) as never;
    });
    const running = runProcess(spawn, "ssh", [], { signal: controller.signal });
    controller.abort();
    expect(await running).toMatchObject({ code: 255, stderr: CANCELLED });
    expect(children[0]!.killed).toEqual(["SIGTERM"]);
    expect(await runProcess(spawn, "ssh", [], { signal: controller.signal })).toEqual({
      code: 255,
      stdout: "",
      stderr: CANCELLED,
    });
    expect(children).toHaveLength(1);
  });

  it("answers at once when it ends a process that has exited but not yet closed", async () => {
    const controller = new AbortController();
    const { spawn, children } = scriptedSpawn((child) => {
      setImmediate(() => {
        child.process.emit("exit", 0);
        controller.abort();
      });
    });
    expect(await runProcess(spawn, "ssh", [], { signal: controller.signal })).toMatchObject({
      code: 255,
      stderr: CANCELLED,
    });
    expect(children[0]!.killed).toEqual([]);
  });

  it("settles once, whatever the child does after a timeout, and ignores a stdin that closed early", async () => {
    const late = scriptedSpawn((child) => {
      setImmediate(() =>
        (child.process.stdin as NodeJS.WritableStream).emit("error", new Error("EPIPE")),
      );
      setTimeout(() => child.exit(0), 20);
    });
    expect((await runProcess(late.spawn, "ssh", [], { timeoutMs: 1 })).code).toBe(255);
    await new Promise((resolve) => setTimeout(resolve, 40));
  });

  it("keeps no more than its cap of output", async () => {
    const big = "x".repeat(4 * 1024 * 1024);
    const { spawn } = scriptedSpawn((child) => {
      child.out(big);
      child.out("more");
      child.err(big);
      child.err("more");
      child.exit(0);
    });
    const result = await runProcess(spawn, "ssh", []);
    expect(result.stdout.length).toBe(big.length);
    expect(result.stderr.length).toBe(big.length);
  });
});

describe("the system ssh runner", () => {
  it("runs a script with sh on the box, through the person's own ssh, over one shared connection", async () => {
    // A stand-in `ssh`: runs the remote command it is given with the local sh.
    const fakeSsh = join(root, "ssh");
    writeFileSync(fakeSsh, '#!/bin/sh\nfor last; do :; done\nexec /bin/sh -c "$last"\n');
    chmodSync(fakeSsh, 0o755);
    const { lines, logger } = recordingLogger();
    const ssh = systemSsh({ target: TARGET, logger, sshPath: fakeSsh });
    const result = await ssh.exec(`printf '%s' "it's"; cat`, { stdin: " here", label: "quote" });
    expect(result).toEqual({ code: 0, stdout: "it's here", stderr: "" });
    expect(await ssh.exec("exit 3")).toMatchObject({ code: 3 });
    expect(
      lines.filter((line) => line.msg === "ssh exec finished").map((line) => line.fields["label"]),
    ).toEqual(["quote", "command"]);
    await ssh.close();
  });

  it("logs a connection failure as a warning, and closes the master it made", async () => {
    const { spawn, children } = scriptedSpawn((child) => {
      child.err(
        child.args.includes("exit") ? "" : "ssh: connect to host box port 22: Connection refused",
      );
      child.exit(255);
    });
    const { lines, logger } = recordingLogger();
    const controlDir = join(root, "control");
    const ssh = systemSsh({ target: TARGET, logger, spawn, controlDir });
    await ssh.exec("true");
    expect(lines.at(-1)).toMatchObject({ level: "warn", fields: { failure: "unreachable" } });
    expect(children[0]!.args).toEqual(
      expect.arrayContaining([
        "-T",
        `ControlPath=${join(controlDir, "%C")}`,
        "--",
        "deploy@box",
        "sh -c 'true'",
      ]),
    );
    await ssh.close();
    expect(children[1]!.args).toEqual(expect.arrayContaining(["-O", "exit", "deploy@box"]));
    const owned = systemSsh({ target: TARGET, logger, spawn });
    const dir = /ControlPath=(.*)\/%C/u.exec(
      (await owned.exec("true"), children[2]!.args.join("\n")),
    )![1]!;
    expect(existsSync(dir)).toBe(true);
    await owned.close();
    expect(existsSync(dir)).toBe(false);
  });
});

/** Each command's child exits only when SIGKILLed, as one ignoring SIGTERM does. */
const stubborn = () =>
  scriptedSpawn((child) => {
    if (child.args.includes("exit")) {
      child.exit(0);
      return;
    }
    child.process.kill = ((signal: string) => {
      child.killed.push(signal);
      if (signal === "SIGKILL") child.exit(null);
      return true;
    }) as never;
  });

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("the runner owns its ssh processes", () => {
  it("ends every running command at close, waits for it, then ends the master", async () => {
    const { spawn, children } = stubborn();
    const ssh = systemSsh({
      target: TARGET,
      logger: recordingLogger().logger,
      spawn,
      controlDir: join(root, "c"),
      killAfterMs: 5,
    });
    const running = [ssh.exec("sleep forever"), ssh.exec("sleep longer", { timeoutMs: 60_000 })];
    const closed = ssh.close();
    // Every call shares the one close.
    expect(ssh.close()).toBe(closed);
    await closed;
    for (const result of await Promise.all(running)) {
      expect(result).toMatchObject({ code: 255, stderr: CANCELLED });
    }
    expect(children.slice(0, 2).map((child) => child.killed)).toEqual([
      ["SIGTERM", "SIGKILL"],
      ["SIGTERM", "SIGKILL"],
    ]);
    expect(children[2]!.args).toEqual(expect.arrayContaining(["-O", "exit"]));
    // A command after close spawns nothing.
    expect(await ssh.exec("true")).toMatchObject({ code: 255, stderr: CANCELLED });
    expect(children).toHaveLength(3);
  });

  it("ends one command on its own signal, leaving the connection open", async () => {
    const { spawn, children } = stubborn();
    const ssh = systemSsh({
      target: TARGET,
      logger: recordingLogger().logger,
      spawn,
      controlDir: join(root, "c"),
      killAfterMs: 5,
    });
    const controller = new AbortController();
    const running = ssh.exec("sleep forever", { signal: controller.signal });
    controller.abort();
    expect(await running).toMatchObject({ code: 255, stderr: CANCELLED });
    expect(children[0]!.killed).toEqual(["SIGTERM", "SIGKILL"]);
    const next = ssh.exec("true");
    children[1]!.exit(0);
    expect(await next).toMatchObject({ code: 0 });
    await ssh.close();
  });

  it("leaves no live process behind when a real one ignores SIGTERM", async () => {
    // A stand-in `ssh` that ignores SIGTERM and never exits on its own; `-O exit` exits at once.
    const fakeSsh = join(root, "stubborn-ssh");
    writeFileSync(
      fakeSsh,
      `#!/usr/bin/env node
if (process.argv.includes("-O")) process.exit(0);
process.on("SIGTERM", () => {});
process.stderr.write("ready\n");
setInterval(() => {}, 1000);
`,
    );
    chmodSync(fakeSsh, 0o755);
    const pids: number[] = [];
    let ready!: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const ssh = systemSsh({
      target: TARGET,
      logger: recordingLogger().logger,
      sshPath: fakeSsh,
      controlDir: join(root, "c"),
      killAfterMs: 50,
      spawn: (command, args) => {
        const child = nodeSpawn(command, [...args], { stdio: ["pipe", "pipe", "pipe"] });
        pids.push(child.pid!);
        child.stderr!.once("data", () => ready());
        return child;
      },
    });

    try {
      const command = ssh.exec("pretend long install");
      await started;
      await ssh.close();
      expect(await command).toMatchObject({
        code: 255,
        stderr: expect.stringContaining(CANCELLED),
      });
      // Gone by the time close answers: no pause, no extra wait.
      expect(pids.map(alive)).toEqual([false, false]);
    } finally {
      for (const pid of pids) if (alive(pid)) process.kill(pid, "SIGKILL");
    }
  });
});

describe("waiting out SIGKILLed processes", () => {
  it("answers at once for one already gone, on exit or error, and after its bound for one that lingers", async () => {
    const gone = fakeChild("ssh", []);
    Object.assign(gone.process, { exitCode: 0, signalCode: null });
    await exitsWithin([gone.process], 60_000);
    const killed = fakeChild("ssh", []);
    Object.assign(killed.process, { exitCode: null, signalCode: "SIGKILL" });
    await exitsWithin([killed.process], 60_000);
    const exiting = fakeChild("ssh", []);
    const failing = fakeChild("ssh", []);
    const both = exitsWithin([exiting.process, failing.process], 60_000);
    exiting.exit(null);
    failing.fail(Object.assign(new Error("EPERM"), { code: "EPERM" }));
    await both;
    const stuck = fakeChild("ssh", []);
    const started = Date.now();
    await exitsWithin([stuck.process], 20);
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
  });

  it("leaves the master to ControlPersist when closing has no time left, and kills nothing it does not own", async () => {
    const { spawn, children } = scriptedSpawn(() => {});
    const { lines, logger } = recordingLogger();
    const ssh = systemSsh({ target: TARGET, logger, spawn, controlDir: join(root, "c") });
    await ssh.close({ deadline: Date.now() - 1 });
    expect(children).toHaveLength(0);
    expect(lines.map((line) => line.msg)).toContain(
      "ssh master left to its ControlPersist: no time to end it",
    );
    await ssh.kill!();
    expect(lines.map((line) => line.msg)).not.toContain(
      "ssh processes still running past the deadline; killing them",
    );
  });
});

describe("host keys", () => {
  it("offers the box's keys with no credential sent, and their fingerprints", async () => {
    const { spawn, children } = scriptedSpawn((child) => {
      if (child.command === "ssh") {
        const file = child.args
          .find((arg) => arg.startsWith("UserKnownHostsFile="))!
          .split("=")[1]!;
        writeFileSync(file, "box ssh-ed25519 AAAAC3Nza\n\nbox ecdsa-sha2-nistp256 AAAAE2Vj\n");
        child.err("deploy@box: Permission denied (publickey).");
        child.exit(255);
      } else {
        child.out("256 SHA256:abc box (ED25519)\n256 SHA256:def box (ECDSA)\nnoise\n");
        child.exit(0);
      }
    });
    const offer = await discoverHostKeys({
      target: TARGET,
      spawn,
      logger: recordingLogger().logger,
    });
    expect(offer).toEqual({
      entries: ["box ssh-ed25519 AAAAC3Nza", "box ecdsa-sha2-nistp256 AAAAE2Vj"],
      fingerprints: [
        { type: "ED25519", fingerprint: "SHA256:abc" },
        { type: "ECDSA", fingerprint: "SHA256:def" },
      ],
    });
    expect(children[0]!.args).toEqual(
      expect.arrayContaining([
        "PubkeyAuthentication=no",
        "IdentityAgent=none",
        "PasswordAuthentication=no",
      ]),
    );
    expect(children[1]!.command).toBe("ssh-keygen");
  });

  it("offers nothing when the box showed no key", async () => {
    const { spawn } = scriptedSpawn((child) => {
      child.err("ssh: connect to host box port 22: Connection refused");
      child.exit(255);
    });
    expect(
      await discoverHostKeys({ target: TARGET, spawn, logger: recordingLogger().logger }),
    ).toBeNull();
  });

  it("uses the system's ssh by default", async () => {
    const quiet = join(root, "quiet-ssh");
    writeFileSync(quiet, "#!/bin/sh\nexit 255\n");
    chmodSync(quiet, 0o755);
    const logger = recordingLogger().logger;
    expect(await discoverHostKeys({ target: TARGET, sshPath: quiet, logger })).toBeNull();
    const offer = { entries: ["box ssh-ed25519 AAAA"], fingerprints: [] };
    const home = join(root, "default-home");
    expect(await acceptHostKeys({ target: TARGET, offer, home, sshPath: quiet, logger })).toBe(
      join(home, ".ssh/known_hosts"),
    );
  });

  it("appends accepted keys where the person's ssh reads them", async () => {
    const offer = { entries: ["box ssh-ed25519 AAAA"], fingerprints: [] };
    const configured = join(root, "custom/known_hosts");
    const { spawn } = scriptedSpawn((child) => {
      child.out(`user deploy\nuserknownhostsfile ${configured} ~/.ssh/known_hosts2\n`);
      child.exit(0);
    });
    const logger = recordingLogger().logger;
    expect(await acceptHostKeys({ target: TARGET, offer, home: root, spawn, logger })).toBe(
      configured,
    );
    await acceptHostKeys({ target: TARGET, offer, home: root, spawn, logger });
    expect(readFileSync(configured, "utf8")).toBe("box ssh-ed25519 AAAA\nbox ssh-ed25519 AAAA\n");

    const defaults = scriptedSpawn((child) => child.exit(0));
    const home = join(root, "home");
    const file = await acceptHostKeys({
      target: TARGET,
      offer,
      home,
      spawn: defaults.spawn,
      logger,
    });
    expect(file).toBe(join(home, ".ssh/known_hosts"));
    writeFileSync(file, "other");
    await acceptHostKeys({ target: TARGET, offer, home, spawn: defaults.spawn, logger });
    expect(readFileSync(file, "utf8")).toBe("other\nbox ssh-ed25519 AAAA\n");
  });
});

/** ssh records `entries`; ssh-keygen answers as `keygen` says. */
const discovering = (entries: string, keygen: (child: FakeChild) => void) =>
  scriptedSpawn((child) => {
    if (child.command === "ssh") {
      const file = child.args
        .find((arg) => arg.startsWith("UserKnownHostsFile="))!
        .slice("UserKnownHostsFile=".length);
      writeFileSync(file, entries);
      child.exit(255);
    } else {
      keygen(child);
    }
  });

describe("host keys that cannot be fingerprinted", () => {
  it("discovery fails closed when fingerprints cannot be computed", async () => {
    const { spawn } = discovering("box ssh-ed25519 AAAA\n", (child) =>
      child.fail(Object.assign(new Error("spawn ssh-keygen ENOENT"), { code: "ENOENT" })),
    );
    const log = recordingLogger();
    expect(await discoverHostKeys({ target: TARGET, spawn, logger: log.logger })).toBeNull();
    expect(log.lines.at(-1)).toMatchObject({
      level: "warn",
      msg: "host key fingerprints unavailable",
      fields: { keys: 1, fingerprints: 0, code: 127 },
    });
  });

  it("offers nothing unless each key has exactly its own fingerprint", async () => {
    const two = "box ssh-ed25519 AAAA\nbox ecdsa-sha2-nistp256 BBBB\n";
    for (const [entries, code, out] of [
      // ssh-keygen failed, whatever it printed.
      [two, 1, "256 SHA256:abc box (ED25519)\n256 SHA256:def box (ECDSA)\n"],
      // One fingerprint short.
      [two, 0, "256 SHA256:abc box (ED25519)\n"],
      // Unparseable.
      [two, 0, "garbage\n"],
      // In the wrong order: not the entries' own.
      [two, 0, "256 SHA256:def box (ECDSA)\n256 SHA256:abc box (ED25519)\n"],
      // A line that names no key at all.
      ["box\n", 0, "256 SHA256:abc box (ED25519)\n"],
    ] as const) {
      const { spawn } = discovering(entries, (child) => {
        child.out(out);
        child.exit(code);
      });
      expect(
        await discoverHostKeys({ target: TARGET, spawn, logger: recordingLogger().logger }),
      ).toBeNull();
    }
    // A key type it does not know is matched by position alone.
    const { spawn } = discovering("|1|salt|hash ssh-new-kind CCCC\n", (child) => {
      child.out("512 SHA256:new |1|salt|hash (NEW)\n");
      child.exit(0);
    });
    expect(
      await discoverHostKeys({ target: TARGET, spawn, logger: recordingLogger().logger }),
    ).toEqual({
      entries: ["|1|salt|hash ssh-new-kind CCCC"],
      fingerprints: [{ type: "NEW", fingerprint: "SHA256:new" }],
    });
  });
});

describe("a ControlMaster directory the caller gives", () => {
  it("is made 0700 when missing", () => {
    const dir = join(root, "control");
    expect(ensureControlDir(dir)).toBe(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    // A private one already there is used as it is.
    expect(ensureControlDir(dir)).toBe(dir);
  });

  it("is refused unless it is a real, private directory of this user's", () => {
    const real = join(root, "real");
    mkdirSync(real, { mode: 0o700 });
    const link = join(root, "link");
    symlinkSync(real, link);
    const file = join(root, "file");
    writeFileSync(file, "");
    const shared = join(root, "shared");
    mkdirSync(shared);
    chmodSync(shared, 0o750);
    for (const [dir, uid, reason] of [
      [link, undefined, "it is a symbolic link"],
      [file, undefined, "it is not a directory"],
      [shared, undefined, "others can reach it (mode 750)"],
      [real, -1, "it is owned by uid"],
      [join(root, "missing/control"), undefined, "ENOENT"],
    ] as const) {
      let caught: unknown;
      try {
        ensureControlDir(dir, uid);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(UnsafeControlDirError);
      expect(caught).toMatchObject({ code: "unsafe-control-dir", path: dir });
      expect((caught as UnsafeControlDirError).reason).toContain(reason);
    }
    expect(() =>
      systemSsh({ target: TARGET, logger: recordingLogger().logger, controlDir: shared }),
    ).toThrow(UnsafeControlDirError);
  });
});

// CodeQL js/polynomial-redos: stderr is the remote's, so classifying it stays linear.
describe("classifying hostile stderr", () => {
  it("answers at once on long repetitions of the patterns it looks for", () => {
    const started = performance.now();
    expect(
      classifySshFailure({ code: 255, stdout: "", stderr: "Host key for ".repeat(50_000) }),
    ).toMatchObject({ kind: "ssh-failed" });
    expect(
      classifySshFailure({ code: 255, stdout: "", stderr: "Permission denied ((".repeat(50_000) }),
    ).toMatchObject({ kind: "ssh-failed" });
    expect(
      classifySshFailure({
        code: 255,
        stdout: "",
        stderr: "deploy@box: Permission denied (password,keyboard-interactive).",
      }),
    ).toMatchObject({ kind: "password-only" });
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
