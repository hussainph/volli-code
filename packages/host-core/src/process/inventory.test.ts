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

  it("keeps the first name under a pid — a process has one working directory", () => {
    expect(parseLsofCwd(["p7", "n/first", "n/second"].join("\n")).get(7)).toBe("/first");
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
