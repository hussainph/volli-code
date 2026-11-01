/** The live ports against a loopback server, real `tar` and real processes. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  liveDownload,
  liveExtract,
  liveFetchText,
  liveProbe,
  liveRestart,
  liveService,
  runProgram,
} from "./live";
import { UpdateRefusal } from "./manifest";

let server: Server;
let base: string;
const BIG = Buffer.alloc(200_000, 7);

beforeAll(async () => {
  server = createServer((request, response) => {
    if (request.url === "/small") return void response.end("hello");
    if (request.url === "/big") return void response.end(BIG);
    response.statusCode = 404;
    response.end("missing");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "runner-live-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function refusal(promise: Promise<unknown>): Promise<UpdateRefusal> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(UpdateRefusal);
  return error as UpdateRefusal;
}

describe("fetching", () => {
  it("reads a small document and refuses an error or an oversized one", async () => {
    const fetchText = liveFetchText();
    expect(await fetchText(`${base}/small`, 10)).toBe("hello");
    expect((await refusal(fetchText(`${base}/small`, 2))).message).toMatch(/larger than expected/u);
    expect((await refusal(fetchText(`${base}/nope`, 10))).message).toMatch(/answered 404/u);
  });

  it("refuses a response without a body", async () => {
    const fetchText = liveFetchText(async () => new Response(null, { status: 200 }));
    expect((await refusal(fetchText("https://example.test/x", 10))).code).toBe("download");
  });

  it("downloads to a file with its digest and size, within the cap", async () => {
    const download = liveDownload();
    const path = join(root, "big.tar.gz");
    expect(await download(`${base}/big`, path, BIG.length)).toEqual({
      sha256: createHash("sha256").update(BIG).digest("hex"),
      size: BIG.length,
    });
    expect(readFileSync(path).equals(BIG)).toBe(true);
    await refusal(download(`${base}/big`, path, BIG.length - 1));
  });
});

describe("processes", () => {
  it("runs a program and names a failure with its stderr", async () => {
    await expect(runProgram(process.execPath, ["-e", "process.stdout.write('out')"])).resolves.toBe(
      "out",
    );
    await expect(
      runProgram(process.execPath, ["-e", "process.stderr.write('boom'); process.exit(3)"], {
        timeoutMs: 10_000,
      }),
    ).rejects.toThrow(/exited 3: boom/u);
    await expect(
      runProgram(process.execPath, ["-e", "process.exit(4)"], { timeoutMs: 10_000, cwd: root }),
    ).rejects.toThrow(/exited 4$/u);
    await expect(
      runProgram(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { timeoutMs: 50 }),
    ).rejects.toThrow(/was killed \(SIGTERM\)/u);
    await expect(runProgram(join(root, "missing"), [])).rejects.toThrow(/ENOENT/u);
  });

  it("extracts a tarball, and refuses one that is not", async () => {
    const source = join(root, "src", "volli-runner-0.4.0-linux-x64", "bin");
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "node"), "#!/bin/sh\n");
    const tarball = join(root, "r.tar.gz");
    execFileSync("tar", ["-czf", tarball, "-C", join(root, "src"), "volli-runner-0.4.0-linux-x64"]);
    mkdirSync(join(root, "out"));
    await liveExtract(tarball, join(root, "out"));
    expect(existsSync(join(root, "out", "volli-runner-0.4.0-linux-x64", "bin", "node"))).toBe(true);
    writeFileSync(join(root, "bad.tar.gz"), "not a tarball");
    expect((await refusal(liveExtract(join(root, "bad.tar.gz"), join(root, "out")))).code).toBe(
      "bad_tarball",
    );
  });

  it("probes a release with its own node", async () => {
    const release = join(root, "release");
    mkdirSync(join(release, "bin"), { recursive: true });
    mkdirSync(join(release, "lib"), { recursive: true });
    writeFileSync(join(release, "bin", "node"), `#!/bin/sh\nexec "${process.execPath}" "$@"\n`);
    chmodSync(join(release, "bin", "node"), 0o755);
    writeFileSync(join(release, "lib", "probe-natives.cjs"), "");
    writeFileSync(join(release, "lib", "probe-codemode.mjs"), "");
    await expect(liveProbe(release)).resolves.toBeUndefined();
    writeFileSync(
      join(release, "lib", "probe-codemode.mjs"),
      "process.stderr.write('no quickjs'); process.exit(1);",
    );
    const error = await refusal(liveProbe(release));
    expect(error.code).toBe("probe");
    expect(error.message).toMatch(/probe-codemode\.mjs: .*no quickjs/u);
  });

  it("restarts the runner's unit through systemctl, as the install's manager", async () => {
    const log = join(root, "calls");
    const systemctl = join(root, "systemctl");
    writeFileSync(systemctl, `#!/bin/sh\necho "$@" >> "${log}"\n`);
    chmodSync(systemctl, 0o755);
    await liveRestart("system", "volli-runner.service", systemctl);
    await liveRestart("user", "volli-runner.service", systemctl);
    expect(readFileSync(log, "utf8")).toBe(
      "restart volli-runner.service\n--user restart volli-runner.service\n",
    );
    await expect(liveRestart("system", "x", join(root, "missing"))).rejects.toThrow(/ENOENT/u);
  });
});

describe("the runner's unit", () => {
  it("reads MainPID and NRestarts from systemctl show, as the install's manager", async () => {
    const systemctl = join(root, "systemctl");
    const log = join(root, "calls");
    writeFileSync(
      systemctl,
      `#!/bin/sh\necho "$@" >> "${log}"\nprintf 'NRestarts=2\\nMainPID=4321\\n'\n`,
    );
    chmodSync(systemctl, 0o755);
    expect(await liveService("system", "volli-runner.service", systemctl)).toEqual({
      mainPid: 4321,
      restarts: 2,
    });
    expect(await liveService("user", "volli-runner.service", systemctl)).not.toBeNull();
    expect(readFileSync(log, "utf8")).toBe(
      "show -p MainPID -p NRestarts volli-runner.service\n" +
        "--user show -p MainPID -p NRestarts volli-runner.service\n",
    );
  });

  it("cannot say without systemctl, or without both fields", async () => {
    expect(await liveService("system", "x", join(root, "missing"))).toBeNull();
    const systemctl = join(root, "systemctl");
    writeFileSync(systemctl, "#!/bin/sh\necho MainPID=1\n");
    chmodSync(systemctl, 0o755);
    expect(await liveService("system", "x", systemctl)).toBeNull();
  });
});
