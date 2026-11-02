import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { BootError } from "./boot-error";
import { prepareDataDir, warnOfSharedSocketDir } from "./data-dir";
import type { ShellLogger } from "./log";
import { EXAMPLE } from "../testing/identity";

type LogFn = ShellLogger["warn"];

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "example-data-dir-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

function logger() {
  return {
    debug: vi.fn<LogFn>(),
    info: vi.fn<LogFn>(),
    warn: vi.fn<LogFn>(),
    error: vi.fn<LogFn>(),
  };
}

function refusal(dataDir: string): BootError {
  try {
    prepareDataDir(EXAMPLE, dataDir, logger());
  } catch (error) {
    expect(error).toBeInstanceOf(BootError);
    expect((error as BootError).reason).toBe("data-dir");
    return error as BootError;
  }
  throw new Error("expected a refusal");
}

describe("preparing the data directory", () => {
  it("creates a missing directory 0700, parents included, and says nothing", () => {
    const dataDir = join(root, "a", "data");
    const log = logger();
    prepareDataDir(EXAMPLE, dataDir, log);
    expect(statSync(dataDir).mode & 0o777).toBe(0o700);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("refuses a path it cannot create", () => {
    writeFileSync(join(root, "file"), "");
    expect(refusal(join(root, "file", "data")).message).toMatch(
      /^Could not create the data directory /,
    );
  });

  it("refuses a directory another user owns, naming the program", () => {
    const dataDir = join(root, "data");
    mkdirSync(dataDir, { mode: 0o700 });
    const uid = statSync(dataDir).uid;
    vi.spyOn(process, "getuid").mockReturnValue(uid + 1);
    expect(refusal(dataDir).message).toBe(
      `The data directory ${dataDir} belongs to uid ${uid}, not to the user volli-example ` +
        `runs as (uid ${uid + 1}), so it will not use it. Run: chown ${uid + 1} ${dataDir}`,
    );
  });

  it("refuses a world-writable directory", () => {
    const dataDir = join(root, "data");
    mkdirSync(dataDir);
    chmodSync(dataDir, 0o777);
    expect(refusal(dataDir).message).toMatch(/^Permissions 0777 on the data directory /);
  });

  it("warns of a group-writable directory and uses it", () => {
    const dataDir = join(root, "data");
    mkdirSync(dataDir);
    chmodSync(dataDir, 0o770);
    const log = logger();
    prepareDataDir(EXAMPLE, dataDir, log);
    expect(log.warn).toHaveBeenCalledWith(
      "the data directory is group-writable; its group could replace the database or key",
      { dataDir, mode: "0770", fix: `chmod 700 ${dataDir}` },
    );
  });
});

describe("the socket's directory", () => {
  it("says nothing of the data directory itself, a private one, or a missing one", () => {
    const log = logger();
    warnOfSharedSocketDir(join(root, "volli.sock"), root, log);
    chmodSync(root, 0o777);
    warnOfSharedSocketDir(join(root, "volli.sock"), root, log);
    const privateDir = join(root, "private");
    mkdirSync(privateDir, { mode: 0o700 });
    warnOfSharedSocketDir(join(privateDir, "volli.sock"), join(root, "data"), log);
    warnOfSharedSocketDir(join(root, "missing", "volli.sock"), join(root, "data"), log);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("warns of a world-writable one elsewhere", () => {
    const shared = join(root, "shared");
    mkdirSync(shared);
    chmodSync(shared, 0o777);
    const log = logger();
    warnOfSharedSocketDir(join(shared, "volli.sock"), join(root, "data"), log);
    expect(log.warn).toHaveBeenCalledWith(
      "the socket's directory is world-writable; another user could unlink or squat on it",
      { socketPath: join(shared, "volli.sock"), mode: "0777" },
    );
  });
});
