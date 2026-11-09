/**
 * Node has no openat/renameat API, and Darwin's /dev/fd directories cannot be
 * traversed. A short-lived Node child gives file operations a pinned cwd:
 * before touching any child name it verifies cwd against the inherited open
 * directory descriptor. No operation below resolves the mutable root path.
 * This is constant host code, not a shell or caller-supplied program.
 */
import { spawn } from "node:child_process";
import type { FileHandle } from "node:fs/promises";

const MAX_FILE = 24 * 1024 * 1024;
const DEADLINE_MS = 3_000;
const PROGRAM = String.raw`
const fs = require("node:fs");
const crypto = require("node:crypto");
const c = fs.constants;
const max = 24 * 1024 * 1024;
const pin = fs.fstatSync(3);
const cwd = fs.lstatSync(".");
if (!pin.isDirectory() || !cwd.isDirectory() || pin.dev !== cwd.dev || pin.ino !== cwd.ino) process.exit(1);
// The inherited descriptor and cwd now refer to the SAME directory. All
// subsequent paths are fixed single components relative to that pinned cwd.
const directory = fs.opendirSync(".");
try {
  for (let scanned = 0; scanned < 1024; scanned++) {
    const entry = directory.readSync();
    if (entry === null) break;
    if (!/^\.cache-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(entry.name)) continue;
    try { fs.unlinkSync(entry.name); } catch {}
  }
} finally { directory.closeSync(); }
if (process.argv[1] === "read") {
  let fd;
  try {
    fd = fs.openSync("cache-v1.json", c.O_RDONLY | c.O_NOFOLLOW | c.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > max) process.exitCode = 1;
    else {
      const bytes = Buffer.alloc(Math.min(max + 1, stat.size + 1));
      let size = 0;
      while (size < bytes.length) {
        const count = fs.readSync(fd, bytes, size, bytes.length - size, size);
        if (count === 0) break;
        size += count;
      }
      if (size !== stat.size || size > max) process.exitCode = 1;
      else process.stdout.write(bytes.subarray(0, size));
    }
  } catch { process.exitCode = 1; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
} else if (process.argv[1] === "write") {
  const chunks = []; let size = 0;
  process.stdin.on("data", (chunk) => {
    size += chunk.length;
    if (size > max) process.exit(1);
    chunks.push(chunk);
  });
  process.stdin.on("end", () => {
    const staging = ".cache-" + crypto.randomUUID();
    let fd;
    try {
      fd = fs.openSync(staging, c.O_WRONLY | c.O_CREAT | c.O_EXCL | c.O_NOFOLLOW, 0o600);
      fs.writeFileSync(fd, Buffer.concat(chunks, size));
      fs.fsyncSync(fd);
      fs.closeSync(fd); fd = undefined;
      fs.renameSync(staging, "cache-v1.json");
    } catch { process.exitCode = 1; }
    finally {
      if (fd !== undefined) fs.closeSync(fd);
      try { fs.unlinkSync(staging); } catch {}
    }
  });
} else process.exitCode = 1;
`;

/** Resolves only once the physical child has closed, including deadline kills. */
export function pinnedSourceIconIo(
  root: string,
  directory: FileHandle,
  body?: string,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", PROGRAM, body === undefined ? "read" : "write"], {
      cwd: root,
      // In Electron this starts its bundled Node, not another desktop app.
      // No inherited credentials, provider configuration, or shell environment.
      env: { ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["pipe", "pipe", "ignore", directory.fd],
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    const stop = (): void => {
      failed = true;
      child.kill("SIGKILL");
    };
    const deadline = setTimeout(stop, DEADLINE_MS);
    child.on("error", () => {
      failed = true;
    });
    child.once("close", (code) => {
      clearTimeout(deadline);
      if (failed || code !== 0) reject(new Error("Source icon directory I/O unavailable"));
      else resolve(Buffer.concat(chunks, size));
    });
    const input = child.stdin;
    const output = child.stdout;
    if (input === null || output === null) {
      stop();
      return;
    }
    input.on("error", stop);
    output.on("error", stop);
    output.on("data", (bytes: Buffer) => {
      size += bytes.length;
      if (size > MAX_FILE) stop();
      else chunks.push(bytes);
    });
    input.end(body);
  });
}
