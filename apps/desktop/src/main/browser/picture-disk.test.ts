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
  it("writes a picture beside a record that says what it is, and reads the bytes back with their type", () => {
    const diskSink = browserPictureDisk(root);

    diskSink.write(Buffer.from("png"), record());

    expect(readdirSync(root).toSorted()).toEqual([`${ID}.json`, `${ID}.png`]);
    expect(diskSink.read(ID)).toEqual({ bytes: Buffer.from("png"), mime: "image/png" });
    expect(diskSink.list()).toEqual([record()]);
  });

  it("lists what survives a relaunch, so a new store can rehydrate and sweep", () => {
    const diskSink = browserPictureDisk(root);
    diskSink.write(Buffer.from("one"), record());
    diskSink.write(Buffer.from("two"), record({ id: OTHER, mime: "image/jpeg", generation: 9 }));

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

  it("removes both halves of a picture the sweep let go of", () => {
    const diskSink = browserPictureDisk(root);
    diskSink.write(Buffer.from("png"), record());

    diskSink.remove(ID);

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
});
