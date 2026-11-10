import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildLogRecord } from "@volli/host-core/log";
import { runGitCapturingAsync } from "@volli/host-core/worktree";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  devBuildLabel,
  perfBuildFromEnv,
  startDesktopPerfStore,
  type DesktopPerfStore,
} from "./perf-store";

let userData = "";
let closers: (() => void)[] = [];

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), "volli-desktop-perf-"));
  closers = [];
});

afterEach(() => {
  for (const close of closers.splice(0)) close();
  rmSync(userData, { recursive: true, force: true });
});

function start(
  overrides: Partial<Parameters<typeof startDesktopPerfStore>[0]> = {},
): DesktopPerfStore | null {
  return startDesktopPerfStore({
    userData,
    version: "0.3.0",
    dev: true,
    env: {},
    appPath: "/checkout/apps/desktop",
    git: async () => "1a2b3c4d5e6f\n",
    onExit: (close) => closers.push(close),
    ...overrides,
  });
}

const mainStall = buildLogRecord({
  level: "warn",
  msg: "main stall",
  component: "main-stall",
  now: new Date(),
  fields: [
    { door: "ipc", operation: "volli:board-load" },
    { durationMs: 320, attribution: "door" },
  ],
});

describe("the desktop perf store", () => {
  it("records each stall line the log tees through it, under this build", async () => {
    const perf = start();
    if (perf === null) throw new Error("no store");
    await perf.labelled;
    perf.sink.write(mainStall, JSON.stringify(mainStall));
    expect(perf.store.stalls({})).toEqual([
      expect.objectContaining({
        door: "ipc",
        operation: "volli:board-load",
        durationMs: 320,
        version: "0.3.0",
        build: "1a2b3c4d5",
      }),
    ]);
  });

  it("labels a run from VOLLI_PERF_BUILD before asking git, and a packaged run not at all", async () => {
    const asked: string[] = [];
    const git = async (_args: readonly string[], cwd: string) => {
      asked.push(cwd);
      return "1a2b3c4";
    };
    const named = start({ env: { VOLLI_PERF_BUILD: "memo-roster" }, git });
    await named?.labelled;
    expect(named?.store.runs().at(-1)?.build).toBe("memo-roster");
    closers.splice(0).forEach((close) => close());
    const packaged = start({ dev: false, git });
    await packaged?.labelled;
    expect(packaged?.store.runs().at(-1)?.build).toBeNull();
    expect(asked).toEqual([]);
  });

  it("closes the store on exit, writing what is buffered", () => {
    const perf = start();
    perf?.sink.write(mainStall, "");
    closers.splice(0).forEach((close) => close());
    const reader = start({ dev: false });
    expect(reader?.store.stalls({})).toHaveLength(1);
  });

  it("is null when the file will not open: the app runs without it", () => {
    mkdirSync(join(userData, "perf.db"));
    expect(start()).toBeNull();
  });
});

describe("build labels", () => {
  it("takes VOLLI_PERF_BUILD only when it reads as a label", () => {
    expect(perfBuildFromEnv({ VOLLI_PERF_BUILD: " fix-1.2+b " })).toBe("fix-1.2+b");
    expect(perfBuildFromEnv({})).toBeNull();
    expect(perfBuildFromEnv({ VOLLI_PERF_BUILD: "" })).toBeNull();
    expect(perfBuildFromEnv({ VOLLI_PERF_BUILD: "two words" })).toBeNull();
    expect(perfBuildFromEnv({ VOLLI_PERF_BUILD: "x".repeat(65) })).toBeNull();
  });

  it("asks git for the checkout's short commit, and gives up quietly", async () => {
    const asked: (readonly string[])[] = [];
    expect(
      await devBuildLabel(async (args) => {
        asked.push(args);
        return "c134ff9de0123456789abcdef0123456789abcde\n";
      }, "/checkout"),
    ).toBe("c134ff9de");
    // The arguments the host's git runner admits: never `--short`.
    expect(asked).toEqual([["rev-parse", "--verify", "HEAD"]]);
    expect(await devBuildLabel(async () => "fatal: not a git repository", "/checkout")).toBeNull();
    expect(
      await devBuildLabel(async () => {
        throw new Error("git missing");
      }, "/checkout"),
    ).toBeNull();
  });

  it("is admitted by the host's real git runner, in this checkout", async () => {
    expect(await devBuildLabel(runGitCapturingAsync, process.cwd())).toMatch(/^[0-9a-f]{9}$/);
  });

  it("records nothing when a dev checkout has no commit", async () => {
    const perf = start({ git: async () => "" });
    await perf?.labelled;
    expect(perf?.store.runs().at(-1)?.build).toBeNull();
  });
});
