import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vite-plus/test";

import { SecretKeyUnavailableError } from "../ports/secret-key";
import { SealedStoreNewerError, SealedStoreUnreadableError } from "./credential-state";
import { CredentialLock, CredentialLockBusyError } from "./credential-lock";
import { SealedFileChangedError } from "./durable-file";
import { SealedDocument, SealedStoreCorruptError, type SealedCodec } from "./sealed-document";

let dir: string;
let path: string;
let lock: CredentialLock;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "volli-sealed-document-"));
  path = join(dir, "doc.enc");
  lock = new CredentialLock(join(dir, "host-credentials.lock"));
});
afterEach(() => {
  lock.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A toy codec: `sealed:` + JSON. Counts opens, so reuse is visible. */
function codec(): SealedCodec<string[]> & { opens: number; probe: Mock<() => void> } {
  const result = {
    opens: 0,
    probe: vi.fn<() => void>(),
    open(bytes: Buffer) {
      result.opens += 1;
      const text = bytes.toString();
      if (!text.startsWith("sealed:")) throw new Error(`bad bytes at ${path}`);
      return JSON.parse(text.slice(7)) as string[];
    },
    seal: (document: string[]) => Buffer.from(`sealed:${JSON.stringify(document)}`),
  };
  return result;
}

describe("SealedDocument", () => {
  it("reads null with no file, then merges each update into what is on disk now", () => {
    const toy = codec();
    const mine = new SealedDocument(path, toy, lock);
    const theirs = new SealedDocument(path, codec(), lock);
    expect(mine.read()).toBeNull();
    expect(mine.update((current) => [...(current ?? []), "a"])).toEqual({
      document: ["a"],
      written: true,
      synced: true,
    });
    // Another process's document, opened before mine changed it, still merges.
    theirs.update((current) => [...(current ?? []), "b"]);
    expect(mine.update((current) => [...current!, "c"]).document).toEqual(["a", "b", "c"]);
    expect(readFileSync(path, "utf8")).toBe('sealed:["a","b","c"]');
    // One probe per locked read or update: a key lost mid-run is noticed at the next.
    expect(toy.probe).toHaveBeenCalledTimes(3);
  });

  it("opens the file again on every read, so a key gone since is asked about", () => {
    const toy = codec();
    const document = new SealedDocument(path, toy, lock);
    writeFileSync(path, 'sealed:["x"]');
    expect(document.read()).toEqual(["x"]);
    expect(document.read()).toEqual(["x"]);
    expect(toy.opens).toBe(2);
    writeFileSync(path, 'sealed:["y"]');
    expect(document.read()).toEqual(["y"]);
    rmSync(path);
    expect(document.read()).toBeNull();
  });

  it("writes nothing when the change answers null", () => {
    const document = new SealedDocument(path, codec(), lock);
    expect(document.update(() => null)).toEqual({ document: null, written: false, synced: true });
    expect(() => readFileSync(path)).toThrow();
  });

  it("keeps a key refusal, and turns every other open failure into one corrupt sentence", () => {
    const toy = codec();
    const document = new SealedDocument(path, toy, lock);
    writeFileSync(path, "garbage");
    const corrupt = (() => {
      try {
        document.read();
      } catch (error) {
        return error as Error;
      }
      return undefined;
    })();
    expect(corrupt).toBeInstanceOf(SealedStoreCorruptError);
    expect(corrupt!.message).toBe("Could not decrypt secret storage.");
    expect(corrupt!.message).not.toContain(dir);
    const refusal = new SecretKeyUnavailableError("missing", "Put the key back.");
    toy.probe.mockImplementation(() => {
      throw refusal;
    });
    expect(() => document.read()).toThrow(refusal);
    toy.probe.mockImplementation(() => {
      throw new SealedStoreNewerError();
    });
    expect(() => document.read()).toThrow(SealedStoreNewerError);
    toy.probe.mockImplementation(() => {
      throw new SealedStoreUnreadableError();
    });
    expect(() => document.read()).toThrow(SealedStoreUnreadableError);
  });

  it("refuses a seal that fails or makes nothing, with a generic sentence", () => {
    const toy = codec();
    const document = new SealedDocument(path, { ...toy, seal: () => Buffer.alloc(0) }, lock);
    expect(() => document.update(() => ["a"])).toThrow("Could not persist encrypted secrets.");
    const throwing = new SealedDocument(
      path,
      {
        ...toy,
        seal: () => {
          throw new Error(`secret ${path}`);
        },
      },
      lock,
    );
    expect(() => throwing.update(() => ["a"])).toThrow(/^Could not persist encrypted secrets\.$/);
  });

  it("refuses to publish over a file changed outside the lock, and reads again after", () => {
    const toy = codec();
    const document = new SealedDocument(path, toy, lock);
    document.update(() => ["a"]);
    expect(() =>
      document.update((current) => {
        // A writer that ignores the lock, between this read and this write.
        writeFileSync(path, 'sealed:["intruder"]');
        return [...current!, "b"];
      }),
    ).toThrow(SealedFileChangedError);
    expect(document.read()).toEqual(["intruder"]);
  });

  it("sanitizes a publish failure, and forgets so the next read looks at disk", () => {
    const document = new SealedDocument(path, codec(), lock, {
      step: (at) => {
        if (at === "renamed") throw new Error(`fault at ${dir}`);
      },
    });
    expect(() => document.update(() => ["a"])).toThrow(/^Could not persist encrypted secrets\.$/);
    expect(readFileSync(path, "utf8")).toBe('sealed:["a"]');
    expect(new SealedDocument(path, codec(), lock).read()).toEqual(["a"]);
  });

  it("fails a read while this process already holds the lock", () => {
    const document = new SealedDocument(path, codec(), lock);
    lock.withSync(() => {
      expect(() => document.read()).toThrow(CredentialLockBusyError);
      expect(() => document.update(() => ["a"])).toThrow(CredentialLockBusyError);
    });
  });
});
