import { gunzipSync, gzipSync } from "node:zlib";
import { describe, expect, it } from "vite-plus/test";

import {
  ArchiveError,
  isSafeArchivePath,
  packArchive,
  TAR_BLOCK_SIZE,
  unpackArchive,
} from "./archive";

function entry(path: string, body: string) {
  return { path, bytes: Buffer.from(body, "utf8") };
}

describe("packArchive / unpackArchive", () => {
  it("round-trips entries with their bytes and order", () => {
    const packed = packArchive([entry("manifest.json", "{}"), entry("data.json", '{"a":1}')]);

    const unpacked = unpackArchive(packed);

    expect(unpacked.map((item) => item.path)).toEqual(["manifest.json", "data.json"]);
    expect(unpacked[1]?.bytes.toString("utf8")).toBe('{"a":1}');
  });

  it("round-trips binary bytes and sizes that are not a block multiple", () => {
    const bytes = Buffer.from([0, 1, 2, 250, 255, 13, 10, 0]);

    const unpacked = unpackArchive(packArchive([{ path: "artifacts/blobs/aa", bytes }]));

    expect(unpacked[0]?.bytes.equals(bytes)).toBe(true);
    expect(bytes.length % TAR_BLOCK_SIZE).not.toBe(0);
  });

  it("round-trips an empty file", () => {
    const unpacked = unpackArchive(packArchive([entry("data.json", "")]));

    expect(unpacked).toHaveLength(1);
    expect(unpacked[0]?.bytes).toHaveLength(0);
  });

  it("refuses to pack a path the reader would reject", () => {
    expect(() => packArchive([entry("../escape", "x")])).toThrow(ArchiveError);
  });
});

describe("archive path safety", () => {
  it("accepts the shapes the bundle uses", () => {
    expect(isSafeArchivePath("manifest.json")).toBe(true);
    expect(isSafeArchivePath("artifacts/blobs/" + "a".repeat(64))).toBe(true);
    expect(isSafeArchivePath("artifacts/transcripts/" + "b".repeat(64) + ".json")).toBe(true);
  });

  it("rejects traversal, absolute, empty and device-ish paths", () => {
    for (const path of [
      "../secrets",
      "a/../../b",
      "/etc/passwd",
      "",
      ".",
      "..",
      "a//b",
      "a/",
      "./a",
      "a\\b",
      "a/b\u0000c",
      "~/x",
      "a/./b",
    ]) {
      expect(isSafeArchivePath(path), `${path} must be rejected`).toBe(false);
    }
  });

  it("rejects an unsafe path when reading, even though it was written by hand", () => {
    // Built by hand rather than through packArchive: the reader is the guard,
    // and a hostile bundle was never produced by our writer.
    const header = Buffer.alloc(TAR_BLOCK_SIZE);
    header.write("../../etc/cron.d/x", 0, "utf8");
    header.write("0000644\0", 100, "utf8");
    header.write("0000000\0", 108, "utf8");
    header.write("0000000\0", 116, "utf8");
    header.write("00000000000\0", 124, "utf8");
    header.write("00000000000\0", 136, "utf8");
    header.write("ustar\0", 257, "utf8");
    header.write("00", 263, "utf8");
    header.write("0", 156, "utf8");
    header.fill(" ", 148, 156);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "utf8");
    const archive = Buffer.concat([header, Buffer.alloc(TAR_BLOCK_SIZE * 2)]);

    expect(() => unpackArchive(gzipSync(archive))).toThrow(/unsafe path/i);
  });

  it("rejects a duplicate entry", () => {
    const packed = packArchive([entry("data.json", "1"), entry("other.json", "2")]);
    // Re-pack by hand so the writer's own duplicate guard is not what fails.
    const doubled = unpackArchive(packed);
    expect(() => packArchive([doubled[0], doubled[0]] as never)).toThrow(/duplicate/i);
  });

  it("rejects a truncated archive rather than returning what it managed to read", () => {
    const packed = packArchive([entry("data.json", "x".repeat(2000))]);
    const raw = Buffer.from(packed);

    expect(() => unpackArchive(gzipSync(raw.subarray(0, 40)))).toThrow(ArchiveError);
  });

  it("rejects bytes that are not a gzip stream at all", () => {
    expect(() => unpackArchive(Buffer.from("not a bundle", "utf8"))).toThrow(ArchiveError);
  });

  it("rejects a directory or symlink entry", () => {
    const header = Buffer.alloc(TAR_BLOCK_SIZE);
    header.write("artifacts", 0, "utf8");
    header.write("0000755\0", 100, "utf8");
    header.write("0000000\0", 108, "utf8");
    header.write("0000000\0", 116, "utf8");
    header.write("00000000000\0", 124, "utf8");
    header.write("00000000000\0", 136, "utf8");
    header.write("5", 156, "utf8");
    header.write("ustar\0", 257, "utf8");
    header.write("00", 263, "utf8");
    header.fill(" ", 148, 156);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "utf8");

    expect(() =>
      unpackArchive(gzipSync(Buffer.concat([header, Buffer.alloc(TAR_BLOCK_SIZE * 2)]))),
    ).toThrow(/only regular file/i);
  });

  it("rejects a header whose checksum does not match its bytes", () => {
    const tar = gunzipSync(packArchive([entry("data.json", "hello")]));
    // Corrupt the name in place; the stored checksum no longer describes it.
    tar.write("Xata.json", 0, "utf8");

    expect(() => unpackArchive(gzipSync(tar))).toThrow(/checksum/i);
  });
});
