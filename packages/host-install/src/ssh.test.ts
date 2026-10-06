import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  acceptHostKeys,
  classifySshFailure,
  connectionOptions,
  discoverHostKeys,
  runProcess,
  shellQuote,
  systemSsh,
} from "./ssh";
import { recordingLogger, scriptedSpawn } from "./testing/fake-process";

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
    const result = await runProcess(hung.spawn, "ssh", [], { timeoutMs: 5 });
    expect(result).toMatchObject({ code: 255 });
    expect(classifySshFailure(result)?.kind).toBe("unreachable");
    expect(hung.children[0]!.killed).toEqual(["SIGTERM"]);
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
