import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { browserPictureDisk, browserPicturesRoot } from "./picture-disk";
import type { BrowserPictureRecord } from "./picture-store";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "volli-pictures-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const ID = "3f9c1a2e-5b6d-4c7e-8f90-1a2b3c4d5e6f";
const OTHER = "8a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d";

const record = (over: Partial<BrowserPictureRecord> = {}): BrowserPictureRecord => ({
  id: ID,
  tabId: "tab-1",
  generation: 2,
  capturedAt: 1_700_000_000_000,
  ownerSessionId: "session-1",
  mime: "image/png",
  ...over,
});

describe("browserPictureDisk", () => {
  it("round-trips every Code Mode image MIME through the same disk sink", async () => {
    for (const mime of ["image/gif", "image/webp", "image/bmp"] as const) {
      const disk = browserPictureDisk(root);
      disk.write(Buffer.from(mime), record({ mime }));
      await disk.settled();
      expect(browserPictureDisk(root).read(ID)).toEqual({ bytes: Buffer.from(mime), mime });
      expect(browserPictureDisk(root).list()).toEqual([record({ mime })]);
      disk.remove(ID);
      await disk.settled();
    }
    const valid = record();
    for (const mime of [3, "text/html", "__proto__"]) {
      writeFileSync(join(root, `${ID}.json`), JSON.stringify({ ...valid, mime }));
      expect(browserPictureDisk(root).list()).toEqual([]);
    }
  });

  it("writes a picture beside a record that says what it is, and reads the bytes back with their type", async () => {
    const diskSink = browserPictureDisk(root);

    diskSink.write(Buffer.from("png"), record());
    await diskSink.settled();

    expect(readdirSync(root).toSorted()).toEqual([`${ID}.json`, `${ID}.png`]);
    expect(diskSink.read(ID)).toEqual({ bytes: Buffer.from("png"), mime: "image/png" });
    expect(diskSink.list()).toEqual([record()]);
  });

  it("lists what survives a relaunch, so a new store can rehydrate and sweep", async () => {
    const diskSink = browserPictureDisk(root);
    diskSink.write(Buffer.from("one"), record());
    diskSink.write(Buffer.from("two"), record({ id: OTHER, mime: "image/jpeg", generation: 9 }));
    await diskSink.settled();

    const listed = browserPictureDisk(root)
      .list()
      .toSorted((left, right) => left.id.localeCompare(right.id));

    expect(listed.map((one) => [one.id, one.mime, one.generation])).toEqual([
      [ID, "image/png", 2],
      [OTHER, "image/jpeg", 9],
    ]);
  });

  it("skips a sidecar it cannot read rather than failing every other picture with it", () => {
    const diskSink = browserPictureDisk(root);
    diskSink.write(Buffer.from("png"), record());
    writeFileSync(join(root, "not-json.json"), "{ broken");
    writeFileSync(join(root, `${OTHER}.json`), JSON.stringify({ id: OTHER, tabId: 7 }));

    expect(diskSink.list().map((one) => one.id)).toEqual([ID]);
  });

  it("skips non-record JSON and keeps a null owner on an otherwise valid sidecar", async () => {
    for (const value of [null, 1, "string"]) {
      writeFileSync(join(root, `${ID}.json`), JSON.stringify(value));
      expect(browserPictureDisk(root).list()).toEqual([]);
    }
    const diskSink = browserPictureDisk(root);
    diskSink.write(Buffer.from("png"), record({ ownerSessionId: null }));
    await diskSink.settled();
    expect(browserPictureDisk(root).list()).toEqual([record({ ownerSessionId: null })]);
  });

  it("removes both halves of a picture the sweep let go of", async () => {
    const diskSink = browserPictureDisk(root);
    diskSink.write(Buffer.from("png"), record());
    await diskSink.settled();

    diskSink.remove(ID);
    await diskSink.settled();

    expect(readdirSync(root)).toEqual([]);
    expect(diskSink.read(ID)).toBeNull();
    expect(diskSink.list()).toEqual([]);
  });

  it("answers an empty listing before anything was ever written", () => {
    expect(browserPictureDisk(join(root, "never-created")).list()).toEqual([]);
  });

  it("answers null for a picture that was never written, and refuses an id that is not a UUID", () => {
    const diskSink = browserPictureDisk(root);

    expect(diskSink.read(ID)).toBeNull();
    expect(() => diskSink.write(Buffer.from("x"), record({ id: "../escape" }))).toThrow(
      "Browser picture ids are UUIDs",
    );
    expect(diskSink.read("../escape")).toBeNull();
    diskSink.remove("../escape");
    expect(readdirSync(root)).toEqual([]);
  });

  it("puts the directory under userData, beside the app's own data and outside any worktree", () => {
    expect(browserPicturesRoot("/tmp/user-data")).toBe("/tmp/user-data/browser-pictures");
  });

  it("writes off the caller's turn, answering every read from memory until the bytes land (VC-1082)", async () => {
    const diskSink = browserPictureDisk(root);
    const bytes = Buffer.from("pixels!");

    diskSink.write(bytes, record());

    expect(readdirSync(root)).toEqual([]);
    expect(diskSink.read(ID)).toEqual({ bytes, mime: "image/png" });
    expect(diskSink.readChunk!(ID, 3)).toEqual({ bytes: bytes.subarray(3), byteLength: 7 });
    expect(diskSink.readChunk!(ID, 9)).toBeNull();
    expect(diskSink.list()).toEqual([record()]);

    await diskSink.settled();
    expect(readdirSync(root).toSorted()).toEqual([`${ID}.json`, `${ID}.png`]);
    expect(browserPictureDisk(root).read(ID)).toEqual({ bytes, mime: "image/png" });
  });

  it("drops a write its removal overtook, so nothing reaches the disk", async () => {
    const diskSink = browserPictureDisk(root);
    diskSink.write(Buffer.from("png"), record());
    diskSink.remove(ID);

    expect(diskSink.read(ID)).toBeNull();
    expect(diskSink.list()).toEqual([]);
    await diskSink.settled();
    expect(readdirSync(root)).toEqual([]);
  });

  it("hides a picture whose removal has not landed yet", async () => {
    const diskSink = browserPictureDisk(root);
    diskSink.write(Buffer.from("png"), record());
    await diskSink.settled();

    diskSink.remove(ID);

    expect(diskSink.read(ID)).toBeNull();
    expect(diskSink.readChunk!(ID, 0)).toBeNull();
    expect(diskSink.list()).toEqual([]);
    await diskSink.settled();
    expect(readdirSync(root)).toEqual([]);
  });

  it("logs a write the disk refused rather than throwing at the caller", async () => {
    const blocked = join(root, "blocked");
    writeFileSync(blocked, "a file where the directory should be");
    const diskSink = browserPictureDisk(blocked);

    expect(() => diskSink.write(Buffer.from("png"), record())).not.toThrow();
    await diskSink.settled();

    expect(diskSink.read(ID)).toBeNull();
  });
});
