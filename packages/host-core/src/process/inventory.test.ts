import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vite-plus/test";

import {
  LSOF_ARGS,
  parseLsofCwd,
  parsePsLine,
  parsePsTable,
  PS_ARGS,
  readProcessInventory,
  runInventoryTool,
} from "./inventory";

const PS_FIXTURE = [
  "    1     0     1  10672 ??       Tue Jul 21 01:41:03 2026     /sbin/launchd",
  " 4242  4200  4242 512000 s003     Wed Sep  9 12:03:41 2026     node dev-server.js --port 3000",
  " 9001     1  9001  16384 ??       Mon Aug 31 08:00:00 2026     sleep 9999",
].join("\n");

describe("parsePsLine", () => {
  it("reads the fixed columns and leaves the whole command intact", () => {
    expect(parsePsLine(PS_FIXTURE.split("\n")[1]!)).toEqual({
      pid: 4242,
      ppid: 4200,
      pgid: 4242,
      rssBytes: 512_000 * 1024,
      tty: "s003",
      startedAt: Date.parse("Wed Sep 9 12:03:41 2026"),
      command: "node dev-server.js --port 3000",
      cwd: null,
    });
  });

  it("reads `??` as no controlling terminal, which is what tells a daemon from a shell", () => {
    expect(parsePsLine(PS_FIXTURE.split("\n")[0]!)?.tty).toBeNull();
    expect(
      parsePsLine("    1     0     1  10672 ?        Tue Jul 21 01:41:03 2026     /sbin/launchd")
        ?.tty,
    ).toBeNull();
    expect(
      parsePsLine("    1     0     1  10672 -        Tue Jul 21 01:41:03 2026     /sbin/launchd")
        ?.tty,
    ).toBeNull();
  });

  it("drops a line it cannot read rather than guessing at it", () => {
    expect(parsePsLine("")).toBeNull();
    expect(parsePsLine("1 0 1 100 ?? too few")).toBeNull();
    expect(parsePsLine("x 0 1 100 ?? Tue Jul 21 01:41:03 2026 /sbin/launchd")).toBeNull();
    expect(parsePsLine("1 0 1 -5 ?? Tue Jul 21 01:41:03 2026 /sbin/launchd")).toBeNull();
    expect(parsePsLine("1 0 1 100 ?? Not A Real Date Here /sbin/launchd")).toBeNull();
    // Eleven words, five of them a legible date, and nothing left for a command.
    expect(parsePsLine("1 0 1 100 ?? Tue Jul 21 01:41:03 2026")).toBeNull();
  });
});

describe("parsePsTable", () => {
  it("keeps every readable row, skipping blank lines and rows it cannot read", () => {
    expect(parsePsTable(`${PS_FIXTURE}\n\nnot a ps row at all\n`).map((fact) => fact.pid)).toEqual([
      1, 4242, 9001,
    ]);
  });
});

describe("parseLsofCwd", () => {
  it("pairs each process with its working directory", () => {
    const cwds = parseLsofCwd(
      ["p1", "fcwd", "n/", "p4242", "fcwd", "n/work/VC-341", ""].join("\n"),
    );
    expect([...cwds]).toEqual([
      [1, "/"],
      [4242, "/work/VC-341"],
    ]);
  });

  it("ignores an unreadable pid, a name before any pid, and a relative name", () => {
    const cwds = parseLsofCwd(
      ["n/orphan-name", "pnot-a-pid", "n/ignored", "p0", "n/ignored", "p7", "nrelative"].join("\n"),
    );
    expect([...cwds]).toEqual([]);
  });

  it.each([
    ["/work/café/東京/😀", "/work/café/東京/😀"],
    [String.raw`/work/caf\xc3\xa9`, "/work/café"],
    [String.raw`/work/\xe6\x9d\xb1\xe4\xba\xac/\xf0\x9f\x98\x80`, "/work/東京/😀"],
    [String.raw`/work/café/\xe6\x9d\xb1`, "/work/café/東"],
    [String.raw`/work/\xe2\x80\x8b`, "/work/\u200b"],
    [String.raw`/work/\xef\xbf\xbd`, "/work/\ufffd"],
    [String.raw`/work/\x7f`, "/work/\x7f"],
    [String.raw`/work/caf\\xc3\\xa9`, String.raw`/work/caf\xc3\xa9`],
    [String.raw`/work/back\\slash`, String.raw`/work/back\slash`],
    [String.raw`/work/end\\`, "/work/end\\"],
    [String.raw`/work/\\n`, String.raw`/work/\n`],
    [String.raw`/work/\b\f\r\n\t`, "/work/\b\f\r\n\t"],
    ["/work/100%/^literal", "/work/100%/^literal"],
  ])("reads lsof name %j exactly", (name, expected) => {
    expect(parseLsofCwd(`p7\nn${name}\n`).get(7)).toBe(expected);
  });

  it.each([
    String.raw`/work/unknown\q`,
    "/work/trailing\\",
    String.raw`/work/\x`,
    String.raw`/work/\xc`,
    String.raw`/work/\xgg`,
    String.raw`/work/\xff`,
    String.raw`/work/\xc3`,
    String.raw`/work/\xc0\xaf`,
    String.raw`/work/\xed\xa0\x80`,
    String.raw`/work/\x00`,
    "/work/raw\tcontrol",
    "/work/raw\0nul",
    "/work/invalid�utf8",
    "/work/\ud800",
    "/work/\udfff",
    // lsof does not quote literal carets: each is also a control byte's spelling.
    "/work/^A",
    "/work/^@",
    "/work/^?",
    "/work/^_",
    "/work/^\\\\",
  ])("drops unreadable or ambiguous name %j without guessing", (name) => {
    expect([...parseLsofCwd(`p7\nn${name}\np8\nn/readable\n`)]).toEqual([[8, "/readable"]]);
  });

  it.each(["/work/^A", "relative", ""])(
    "does not replace unreadable first name %j with a later name under the same pid",
    (name) => {
      expect([...parseLsofCwd(`p7\nn${name}\nn/second\np8\nn/other`)]).toEqual([[8, "/other"]]);
    },
  );

  it("keeps the first name under a pid — a process has one working directory", () => {
    expect(parseLsofCwd(["p7", "n/first", "n/second"].join("\n")).get(7)).toBe("/first");
  });
});

describe.skipIf(process.platform !== "darwin")("parseLsofCwd with real macOS lsof", () => {
  it.each(["en_US.UTF-8", "C", "missing"])("preserves cwd identity with locale %s", (locale) => {
    const tempRoot = fileURLToPath(new URL("../../../../.tmp/", import.meta.url));
    mkdirSync(tempRoot, { recursive: true });
    const root = mkdtempSync(join(tempRoot, "lsof-cwd-"));
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key === "LANG" || key.startsWith("LC_")) delete env[key];
    }
    if (locale !== "missing") env["LC_ALL"] = locale;
    // The child stands in each test directory and asks lsof about itself. No
    // race waiting for a background process to chdir, and no survivor to reap.
    const probe = `
      const { execFileSync } = require('node:child_process');
      process.stdout.write(execFileSync('/usr/sbin/lsof',
        ['-a', '-p', String(process.pid), ...${JSON.stringify(LSOF_ARGS)}],
        { timeout: 5000 }));
    `;
    try {
      for (const name of [
        "café-東京-😀",
        String.raw`caf\xc3\xa9`,
        String.raw`back\slash`,
        String.raw`literal\n`,
        "line\nbreak",
        "control\u0001",
        "control^A",
      ]) {
        const cwd = join(root, name);
        mkdirSync(cwd);
        const stdout = execFileSync(process.execPath, ["-e", probe], {
          cwd,
          env,
          encoding: "utf8",
          timeout: 10_000,
        });
        const cwds = [...parseLsofCwd(stdout).values()];
        if (name.startsWith("control")) {
          // A real control byte and its literal caret spelling collide.
          expect(stdout).toContain("control^A\n");
          expect(cwds).toEqual([]);
        } else {
          expect(cwds).toEqual([realpathSync(cwd)]);
          if (name === "café-東京-😀") {
            expect(stdout).toContain(locale === "en_US.UTF-8" ? name : String.raw`caf\xc3\xa9`);
          }
          if (name === String.raw`caf\xc3\xa9`) {
            expect(stdout).toContain(String.raw`caf\\xc3\\xa9`);
          }
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("readProcessInventory", () => {
  it("merges the working directories into the process table", async () => {
    const run = vi.fn(async (file: string) =>
      file === "ps" ? PS_FIXTURE : ["p4242", "n/work/VC-341"].join("\n"),
    );

    const facts = await readProcessInventory(run);

    expect(run.mock.calls).toEqual([
      ["ps", PS_ARGS],
      ["lsof", LSOF_ARGS],
    ]);
    expect(facts.map((fact) => [fact.pid, fact.cwd])).toEqual([
      [1, null],
      [4242, "/work/VC-341"],
      [9001, null],
    ]);
  });

  it("does not conflate escaped UTF-8, literal escapes, or an unreadable cwd", async () => {
    const lsof = [
      "p1",
      String.raw`n/work/caf\xc3\xa9`,
      "p4242",
      String.raw`n/work/caf\\xc3\\xa9`,
      "p9001",
      "n/work/^A",
    ].join("\n");
    const facts = await readProcessInventory(async (file) => (file === "ps" ? PS_FIXTURE : lsof));
    expect(facts.map((fact) => [fact.pid, fact.cwd])).toEqual([
      [1, "/work/café"],
      [4242, String.raw`/work/caf\xc3\xa9`],
      [9001, null],
    ]);
  });

  it("answers nothing when ps could not run — with no evidence, nothing is a candidate", async () => {
    expect(await readProcessInventory(async (file) => (file === "ps" ? null : ""))).toEqual([]);
  });

  it("still reports the process table when lsof could not run", async () => {
    const facts = await readProcessInventory(async (file) => (file === "ps" ? PS_FIXTURE : null));
    expect(facts.every((fact) => fact.cwd === null)).toBe(true);
    expect(facts).toHaveLength(3);
  });
});

describe("runInventoryTool", () => {
  it("runs a real tool and hands back its output", async () => {
    await expect(runInventoryTool("echo", ["hello"])).resolves.toBe("hello\n");
  });

  it("answers null when the tool is not there at all", async () => {
    await expect(runInventoryTool("volli-no-such-tool", [])).resolves.toBeNull();
  });
});
