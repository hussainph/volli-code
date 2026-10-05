import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { SecretKeyUnavailableError, type SecretKeyRefusal } from "../ports/secret-key";
import {
  archiveSealedStore,
  CREDENTIALS_EMPTY,
  CREDENTIALS_READY,
  credentialStatusFor,
  credentialsUnavailable,
  SealedStoreUnreadableError,
} from "./credential-state";

const faults = vi.hoisted(() => ({
  link: null as (() => void) | null,
  openDirectory: null as (() => number) | null,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    linkSync: (from: string, to: string) =>
      faults.link === null ? actual.linkSync(from, to) : faults.link(),
    openSync: (...args: Parameters<typeof actual.openSync>) =>
      faults.openDirectory !== null && args[1] === "r"
        ? faults.openDirectory()
        : actual.openSync(...args),
  };
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "volli-credential-state-"));
});
afterEach(() => {
  faults.link = null;
  faults.openDirectory = null;
  rmSync(dir, { recursive: true, force: true });
});

describe("credential status", () => {
  it.each<[SecretKeyRefusal, "locked" | "refused"]>([
    ["missing", "locked"],
    ["wrong-key", "locked"],
    ["malformed", "locked"],
    ["unreadable", "locked"],
    ["other-adapter", "locked"],
    ["no-hard-links", "locked"],
    ["unavailable", "locked"],
    ["too-open", "refused"],
    ["wrong-owner", "refused"],
    ["not-a-file", "refused"],
    ["relative-path", "refused"],
  ])("classifies a %s key as %s", (reason, state) => {
    const status = credentialStatusFor(new SecretKeyUnavailableError(reason, "/etc/key fix it"));
    expect(status).toEqual({ state, reason, unavailable: ["session-env"] });
    // A status carries no sentence, and so no path.
    expect(JSON.stringify(status)).not.toContain("/etc/key");
    expect(credentialsUnavailable(status)).toBe(true);
  });

  it("tells an unreadable sealed file from a corrupt one", () => {
    expect(credentialStatusFor(new SealedStoreUnreadableError())).toEqual({
      state: "locked",
      reason: "store-unreadable",
      unavailable: ["session-env"],
    });
    expect(new SealedStoreUnreadableError().message).toBe("Could not read secret storage.");
    expect(credentialStatusFor(new Error("bad tag"))).toEqual({
      state: "corrupt",
      reason: null,
      unavailable: ["session-env"],
    });
  });

  it("treats ready and empty as usable", () => {
    expect(credentialsUnavailable(CREDENTIALS_READY)).toBe(false);
    expect(credentialsUnavailable(CREDENTIALS_EMPTY)).toBe(false);
  });
});

describe("archiving a sealed file", () => {
  it("moves it aside under a fresh name, byte for byte, synced", () => {
    const path = join(dir, "session-secrets.enc");
    writeFileSync(path, "sealed bytes");
    const archived = archiveSealedStore(path, new Date("2026-10-05T12:34:56.789Z"))!;
    expect(archived.name).toMatch(/^session-secrets\.enc\.locked-20261005T123456Z-[0-9a-f]{8}$/);
    expect(archived.synced).toBe(true);
    expect(readdirSync(dir)).toEqual([archived.name]);
    expect(readFileSync(join(dir, archived.name), "utf8")).toBe("sealed bytes");
  });

  it("makes the new name durable before it removes the old one", () => {
    const path = join(dir, "session-secrets.enc");
    writeFileSync(path, "sealed bytes");
    const seen: string[][] = [];
    // Each directory sync records which names exist at that moment.
    faults.openDirectory = () => {
      seen.push(readdirSync(dir).toSorted());
      throw Object.assign(new Error("probe only"), { code: "EINVAL" });
    };
    const archived = archiveSealedStore(path, new Date())!;
    expect(seen).toEqual([[archived.name, "session-secrets.enc"].toSorted(), [archived.name]]);
  });

  it("answers null when there is nothing to move", () => {
    expect(archiveSealedStore(join(dir, "absent.enc"), new Date())).toBeNull();
  });

  it("leaves the file where it was when it cannot be linked", () => {
    const path = join(dir, "session-secrets.enc");
    writeFileSync(path, "sealed bytes");
    faults.link = () => {
      throw Object.assign(new Error("exists"), { code: "EEXIST" });
    };
    expect(() => archiveSealedStore(path, new Date())).toThrow("exists");
    expect(readdirSync(dir)).toEqual(["session-secrets.enc"]);
  });

  it("keeps the move, and says so, when the directory cannot be synced", () => {
    const path = join(dir, "session-secrets.enc");
    writeFileSync(path, "sealed bytes");
    faults.openDirectory = () => {
      throw Object.assign(new Error("unsupported"), { code: "EINVAL" });
    };
    const archived = archiveSealedStore(path, new Date())!;
    expect(archived.synced).toBe(false);
    expect(readdirSync(dir)).toEqual([archived.name]);
  });
});
