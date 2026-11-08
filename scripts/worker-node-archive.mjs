// The symbolizer's cache is untrusted. Hash and copy the same open descriptor
// into its uniquely owned work directory before tar ever sees any bytes.
import { createHash } from "node:crypto";
import {
  closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync,
  mkdtempSync, openSync, readSync, rmSync, writeSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const limit = 134217728;
const failure = (reason) => new Error(reason);

// Production callers: the restore and publish CLI operations below, invoked by
// symbolize-worker-stack.sh before parsing and after exact binary comparison.
export function copyVerifiedArchive(source, destination, expected) {
  const input = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let output;
  try {
    const before = fstatSync(input, { bigint: true });
    if (!before.isFile() || before.size > BigInt(limit)) throw failure("archive_download_failed");
    output = openSync(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(64 * 1024);
    let total = 0;
    for (;;) {
      const count = readSync(input, buffer, 0, buffer.length, null);
      if (!count) break;
      total += count;
      if (total > limit) throw failure("archive_download_failed");
      hash.update(buffer.subarray(0, count));
      let offset = 0;
      while (offset < count) offset += writeSync(output, buffer, offset, count - offset);
    }
    const after = fstatSync(input, { bigint: true });
    const named = lstatSync(source, { bigint: true });
    if (!named.isFile() || ["dev", "ino", "size", "mtimeNs", "ctimeNs"].some(
      (key) => before[key] !== after[key] || after[key] !== named[key],
    ) || BigInt(total) !== before.size) throw failure("archive_download_failed");
    const actual = hash.digest("hex");
    console.log(`archive_sha256_actual=${actual}`);
    if (actual !== expected) throw failure("archive_checksum_mismatch");
    fsyncSync(output);
  } finally {
    closeSync(input);
    if (output !== undefined) closeSync(output);
  }
}

export function restoreArchive(cache, destination, expected) {
  // Only absence is a miss. Dangling symlinks, FIFO/device/directory entries,
  // changed files and checksum errors must never fall back to the network.
  try { lstatSync(cache); } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  copyVerifiedArchive(cache, destination, expected);
  return true;
}

export function publishArchive(source, cache, expected) {
  mkdirSync(dirname(cache), { recursive: true });
  if (!lstatSync(dirname(cache)).isDirectory()) throw failure("archive_download_failed");
  // source is inside the symbolizer's uniquely owned (0700) work directory.
  // Never stage under the untrusted cache parent: replacing that directory
  // between descriptor verification and linkSync must not swap our source.
  const staging = mkdtempSync(`${dirname(source)}/worker-node-publish-`);
  const temporary = `${staging}/archive`;
  try {
    copyVerifiedArchive(source, temporary, expected);
    // Atomic, no replacement: an existing immutable entry is never repaired.
    linkSync(temporary, cache);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [operation, cache, archive, expected] = process.argv.slice(2);
  try {
    if (operation === "restore") process.exitCode = restoreArchive(cache, archive, expected) ? 0 : 2;
    else if (operation === "publish") publishArchive(archive, cache, expected);
    else throw failure("archive_download_failed");
  } catch (error) {
    const reason = error.message === "archive_checksum_mismatch" ? error.message : "archive_download_failed";
    console.log(`diagnostic_failure=${reason}`);
    process.exitCode = 1;
  }
}
