import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  fileSecretKey,
  SECRET_KEY_FILE_ENV,
  SECRET_KEY_FILE_NAME,
  SECRET_STORE_FILE_NAME,
  SecretStore,
} from "@volli/host-core/secrets";

import { runCredentialsReset, type CredentialsResetCommand } from "./credentials";
import { acquireInstanceLock } from "./instance-lock";

let base: string;
let dataDir: string;
let out: string;
let err: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "hostd-credentials-"));
  dataDir = base;
  out = "";
  err = "";
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(base, { recursive: true, force: true });
});

const storePath = () => join(dataDir, SECRET_STORE_FILE_NAME);
const keyPath = () => join(dataDir, SECRET_KEY_FILE_NAME);

function seal(): Buffer {
  new SecretStore(storePath(), fileSecretKey({ path: keyPath() })).put({
    name: "DEPLOY_TOKEN",
    value: "token-sentinel-value",
    scope: "always",
  });
  return readFileSync(storePath());
}

function reset(confirmed: boolean, env: Record<string, string> = {}): number {
  const command: CredentialsResetCommand = { kind: "credentials-reset", dataDir, confirmed };
  return runCredentialsReset(command, {
    env,
    now: () => new Date("2026-10-05T08:00:00.000Z"),
    out: (text) => {
      out += text;
    },
    err: (text) => {
      err += text;
    },
  });
}

describe("volli-hostd credentials reset", () => {
  it("refuses while a host holds the data directory", () => {
    const lock = acquireInstanceLock(dataDir);
    try {
      expect(reset(true)).toBe(1);
    } finally {
      lock.release();
    }
    expect(err).toMatch(
      /^volli-hostd: Another volli-hostd is serving .* Stop it before a reset\.\n$/,
    );
  });

  it("does nothing when saved credentials open, or there are none", () => {
    expect(reset(true)).toBe(0);
    expect(out).toBe("Saved credentials are empty; there is nothing to reset.\n");
    const sealed = seal();
    out = "";
    expect(reset(true)).toBe(0);
    expect(out).toBe("Saved credentials are ready; there is nothing to reset.\n");
    expect(readFileSync(storePath()).equals(sealed)).toBe(true);
  });

  it("says what it found and stops without --yes", () => {
    const sealed = seal();
    rmSync(keyPath());
    expect(reset(false)).toBe(1);
    expect(out).toMatch(/^Saved credentials are locked \(missing\)\.\nSaved secrets exist, but/);
    expect(err).toContain("To reset, run again with --yes.");
    expect(readdirSync(dataDir)).toContain(SECRET_STORE_FILE_NAME);
    expect(readFileSync(storePath()).equals(sealed)).toBe(true);
    expect(`${out}${err}`).not.toContain("token-sentinel-value");
  });

  it("sets a store it cannot open aside with --yes, keeps it, and says how to undo", () => {
    const sealed = seal();
    rmSync(keyPath());
    expect(reset(true)).toBe(0);
    const archive = readdirSync(dataDir).find((name) => name.includes(".locked-"))!;
    expect(archive).toMatch(/^session-secrets\.enc\.locked-20261005T080000Z-[0-9a-f]{8}$/);
    expect(readFileSync(join(dataDir, archive)).equals(sealed)).toBe(true);
    expect(out).toContain(
      `Set ${storePath()} aside as ${join(dataDir, archive)}.\nTo undo, with hostd stopped and before any secret is saved again: mv '${join(dataDir, archive)}' '${storePath()}'\n`,
    );
    expect(out).toMatch(/Saved credentials are now empty\.\n$/);
    // The instance lock was let go.
    acquireInstanceLock(dataDir).release();
  });

  it("uses the key file the service names, as boot does", () => {
    const elsewhere = join(dataDir, "elsewhere.key");
    new SecretStore(storePath(), fileSecretKey({ path: elsewhere })).put({
      name: "DEPLOY_TOKEN",
      value: "v",
      scope: "always",
    });
    expect(reset(true, { [SECRET_KEY_FILE_ENV]: elsewhere })).toBe(0);
    expect(out).toBe("Saved credentials are ready; there is nothing to reset.\n");
  });

  it("refuses to move a store while the key configuration is refused, whatever --yes says", () => {
    const sealed = seal();
    const configs: Record<string, string>[] = [{ [SECRET_KEY_FILE_ENV]: "relative.key" }, {}];
    for (const env of configs) {
      if (Object.keys(env).length === 0) chmodSync(keyPath(), 0o640);
      out = "";
      err = "";
      expect(reset(true, env)).toBe(1);
      expect(out).toMatch(/^Saved credentials are refused \((relative-path|too-open)\)\./);
      expect(err).toBe(
        "A reset cannot fix a refused key configuration, so nothing was moved. Fix it, then restart hostd.\n",
      );
      expect(readFileSync(storePath()).equals(sealed)).toBe(true);
    }
  });

  it("names a corrupt store, and resets a lock with nothing sealed", () => {
    writeFileSync(storePath(), "garbage");
    expect(reset(false)).toBe(1);
    expect(out).toMatch(
      /^Saved credentials are corrupt\.\nThe secret store .* could not be opened/,
    );
    out = "";
    rmSync(storePath());
    writeFileSync(keyPath(), "not a key\n", { mode: 0o600 });
    expect(reset(true)).toBe(0);
    expect(out).not.toContain("aside as");
    expect(out).toMatch(/Saved credentials are now locked\.\n.*does not hold a key/);
  });

  it("prints an undo that /bin/sh runs as written, whatever the data directory is called", () => {
    dataDir = join(dataDir, "it's a $(dir) `with` spaces");
    mkdirSync(dataDir, { mode: 0o700 });
    const sealed = seal();
    rmSync(keyPath());
    expect(reset(true)).toBe(0);
    const undo = /^To undo, with hostd stopped and before any secret is saved again: (.*)$/m.exec(
      out,
    )![1]!;
    expect(existsSync(storePath())).toBe(false);
    execFileSync("/bin/sh", ["-c", undo]);
    expect(readFileSync(storePath()).equals(sealed)).toBe(true);
    expect(readdirSync(dataDir).filter((name) => name.includes(".locked-"))).toEqual([]);
  });

  it("warns when the move could not be synced to disk", () => {
    seal();
    rmSync(keyPath());
    vi.spyOn(SecretStore.prototype, "reset").mockReturnValue({
      archive: "session-secrets.enc.locked-x",
      synced: false,
      status: { state: "empty", reason: null, unavailable: [] },
    });
    expect(reset(true)).toBe(0);
    expect(err).toMatch(/^volli-hostd: warning: the data directory could not be synced/);
  });

  it("refuses a data directory boot would refuse", () => {
    const missing = join(dataDir, "missing");
    const file = join(dataDir, "file");
    writeFileSync(file, "");
    const open = join(dataDir, "open");
    mkdirSync(open);
    chmodSync(open, 0o777);
    const cases: [string, RegExp][] = [
      [missing, /does not exist, so there is nothing to reset\.$/],
      [file, /is not a directory\.$/],
      [open, /^volli-hostd: Permissions 0777 on the data directory .* Run: chmod 700 /],
    ];
    for (const [dir, says] of cases) {
      err = "";
      dataDir = dir;
      expect(reset(true)).toBe(1);
      expect(err.trim()).toMatch(says);
    }
    // Nothing was created in any of them, not even the lock.
    expect(existsSync(join(open, "hostd.lock"))).toBe(false);
  });

  it("refuses a data directory another user owns", () => {
    vi.spyOn(process, "getuid").mockReturnValue(process.getuid!() + 1);
    expect(reset(true)).toBe(1);
    expect(err).toMatch(
      /belongs to uid \d+, not to this user \(uid \d+\)\. Run the reset as the user volli-hostd runs as\./,
    );
  });

  it("reports a reset that could not finish", () => {
    seal();
    rmSync(keyPath());
    vi.spyOn(SecretStore.prototype, "reset").mockImplementation(() => {
      throw new Error("Could not set the saved secrets aside.");
    });
    expect(reset(true)).toBe(1);
    expect(err).toBe("volli-hostd: Could not set the saved secrets aside.\n");
  });
});
