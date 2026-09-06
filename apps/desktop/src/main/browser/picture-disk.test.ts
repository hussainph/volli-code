import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { browserPictureDisk, browserPicturesRoot } from "./picture-disk";

let root: string;

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("browserPictureDisk", () => {
  it("writes a picture under the browser-pictures directory by its id and reads it back with its type", () => {
    root = mkdtempSync(join(tmpdir(), "volli-pictures-"));
    const disk = browserPictureDisk(root);
    const id = "3f9c1a2e-5b6d-4c7e-8f90-1a2b3c4d5e6f";

    disk.write(id, Buffer.from("png"), "image/png");

    expect(readdirSync(root)).toEqual([`${id}.png`]);
    expect(disk.read(id)).toEqual({ bytes: Buffer.from("png"), mime: "image/png" });
  });

  it("answers null for a picture that was never written, and refuses an id that is not a UUID", () => {
    root = mkdtempSync(join(tmpdir(), "volli-pictures-"));
    const disk = browserPictureDisk(root);

    expect(disk.read("3f9c1a2e-5b6d-4c7e-8f90-1a2b3c4d5e6f")).toBeNull();
    expect(() => disk.write("../escape", Buffer.from("x"), "image/jpeg")).toThrow(
      "Browser picture ids are UUIDs",
    );
    expect(disk.read("../escape")).toBeNull();
    expect(readdirSync(root)).toEqual([]);
  });

  it("names the directory under userData", () => {
    root = mkdtempSync(join(tmpdir(), "volli-pictures-"));
    expect(browserPicturesRoot("/tmp/user-data")).toBe("/tmp/user-data/browser-pictures");
  });
});
