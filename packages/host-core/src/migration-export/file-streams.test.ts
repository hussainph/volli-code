import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { FileTranscriptArtifactStore } from "../session-runtime/transcript-artifacts";
import { exportFileStreams, type FileStreamOptions } from "./file-streams";

const fault = vi.hoisted(() => ({
  short: false,
  changed: "",
  abort: null as AbortController | null,
  nonError: false,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      if (!String(args[0]).endsWith(".jsonl")) return actual.open(...args);
      if (fault.nonError) throw "unreadable";
      const file = await actual.open(...args);
      let stats = 0;
      return {
        close: () => file.close(),
        stat: async () => {
          const info = await file.stat();
          stats++;
          if (stats > 1 && fault.changed)
            return {
              ...info,
              isFile: () => true,
              [fault.changed]: info[fault.changed as "size" | "mtimeMs"] + 1,
            };
          return info;
        },
        read: async (...params: Parameters<typeof file.read>) => {
          if (fault.abort) {
            fault.abort.abort();
            throw new Error("cancelled read");
          }
          const read = await file.read(...params);
          return fault.short ? { ...read, bytesRead: 0 } : read;
        },
      };
    },
  };
});
let root: string;
let db: Database.Database;
let path: string;
let options: FileStreamOptions;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "volli-export-files-"));
  db = new Database(":memory:");
  db.exec(`CREATE TABLE sessions(id TEXT,project_id TEXT);
    INSERT INTO sessions VALUES ('s','p');
    CREATE TABLE session_events(session_id TEXT,sequence INTEGER,payload TEXT);
    CREATE TABLE session_attachments(id TEXT,session_id TEXT,native_detail TEXT,adapter_id TEXT,venue_kind TEXT,venue_id TEXT);
    CREATE TABLE blobs(hash TEXT,size_bytes INTEGER);CREATE TABLE blob_links(blob_hash TEXT);`);
  options = {
    transcriptsDir: join(root, "tx"),
    piLogsDir: join(root, "pi"),
    blobsDir: join(root, "blobs"),
  };
  path = join(options.piLogsDir, "--fixture--", "log.jsonl");
  mkdirSync(join(options.piLogsDir, "--fixture--"), { recursive: true });
  writeFileSync(path, "{}\n");
  fault.short = false;
  fault.changed = "";
  fault.abort = null;
  fault.nonError = false;
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
  rmSync(root, { recursive: true, force: true });
});
function attachment(
  detail: unknown = {
    kind: "volli.native-binding.v1",
    locator: { runtime: "pi", sessionFilePath: path },
  },
  overrides: Record<string, string> = {},
) {
  const row = {
    id: "a",
    session_id: "s",
    adapter_id: "pi",
    venue_kind: "local",
    venue_id: "local",
    native_detail: JSON.stringify(detail),
    ...overrides,
  };
  db.prepare(
    `INSERT INTO session_attachments (${Object.keys(row).join(",")}) VALUES (${Object.keys(row)
      .map(() => "?")
      .join(",")})`,
  ).run(...Object.values(row));
}
function artifact(digestOverride?: string) {
  const body = JSON.stringify({
    version: 1,
    threadId: "t",
    branchId: "b",
    attemptId: "a",
    turnId: null,
    message: { id: "m", parts: [] },
  });
  const id = `sha256:${createHash("sha256").update(body).digest("hex")}`;
  mkdirSync(options.transcriptsDir, { recursive: true });
  writeFileSync(join(options.transcriptsDir, `${id.slice(7)}.json`), body);
  db.prepare("INSERT INTO session_events VALUES ('s',1,?)").run(
    JSON.stringify({
      kind: "transcript.referenced",
      reference: { id, digest: id, mediaType: "application/vnd.volli.ui-message+json" },
      ...(digestOverride ? { digest: digestOverride } : {}),
    }),
  );
}
const run = () => exportFileStreams(db, join(root, "export"), options);
it.each([
  null,
  [],
  5,
  { kind: "terminal" },
  { kind: "volli.native-binding.v1" },
  { kind: "volli.native-binding.v1", locator: { runtime: "other" } },
])("ignores non-Pi native history %j", async (detail) => {
  attachment(detail);
  expect((await run()).checkpoints[1]!.rowsThrough).toBe(0);
});
it("names malformed attachment JSON", async () => {
  attachment(null, { native_detail: "not json" });
  await expect(run()).rejects.toThrow(/invalid native detail/);
});
it.each([{ adapter_id: "terminal" }, { venue_kind: "runner" }, { venue_id: "other" }] as Record<
  string,
  string
>[])("refuses a foreign Pi attachment %j", async (fields) => {
  attachment(undefined, fields);
  await expect(run()).rejects.toThrow(/not this Mac/);
});
it.each([undefined, "relative", join("--fixture--", "log.jsonl"), "/outside/log.jsonl"])(
  "refuses invalid Pi locator %j",
  async (locator) => {
    attachment({
      kind: "volli.native-binding.v1",
      locator: { runtime: "pi", sessionFilePath: locator },
    });
    await expect(run()).rejects.toThrow(/Pi attachment/);
  },
);
it.each(["other/log.jsonl", "--incomplete/log.jsonl", "--fixture--/log.txt"])(
  "refuses invalid Pi layout %s",
  async (locator) => {
    attachment({
      kind: "volli.native-binding.v1",
      locator: { runtime: "pi", sessionFilePath: join(options.piLogsDir, locator) },
    });
    await expect(run()).rejects.toThrow(/outside history layout/);
  },
);
it("refuses a symlinked Pi directory", async () => {
  const dir = join(options.piLogsDir, "--fixture--");
  renameSync(dir, `${dir}-real`);
  symlinkSync(`${dir}-real`, dir);
  attachment();
  await expect(run()).rejects.toThrow(/directory is a symlink/);
});
it("refuses a Pi file symlink", async () => {
  renameSync(path, `${path}.real`);
  symlinkSync(`${path}.real`, path);
  attachment();
  await expect(run()).rejects.toThrow(/escaped history directory/);
});
it("refuses nonregular Pi files", async () => {
  rmSync(path);
  mkdirSync(path);
  attachment();
  await expect(run()).rejects.toThrow(/not a regular file/);
});
it("deduplicates repeated attachments of one Pi file", async () => {
  attachment();
  attachment(undefined, { id: "b" });
  expect((await run()).checkpoints[1]!.rowsThrough).toBe(1);
});
it("carries empty Pi files explicitly", async () => {
  writeFileSync(path, "");
  attachment();
  expect((await run()).checkpoints[1]!.rowsThrough).toBe(1);
});
it("names incomplete or oversized Pi lines", async () => {
  writeFileSync(path, "unterminated");
  attachment();
  await expect(run()).rejects.toThrow(/incomplete line/);
});
it("names a short Pi read", async () => {
  attachment();
  fault.short = true;
  await expect(run()).rejects.toThrow(/changed during export/);
});
it.each(["size", "mtimeMs"])("refuses a Pi file whose %s changes while read", async (field) => {
  attachment();
  fault.changed = field;
  await expect(run()).rejects.toThrow(/changed during export/);
});
it("does not relabel cancellation as corruption", async () => {
  attachment();
  const controller = new AbortController();
  options.signal = controller.signal;
  fault.abort = controller;
  await expect(run()).rejects.toThrow(/cancelled read/);
});
it("names non-Error filesystem failures", async () => {
  attachment();
  fault.nonError = true;
  await expect(run()).rejects.toThrow(/unreadable/);
});
it("refuses an event whose digest disagrees with its artifact", async () => {
  artifact("different");
  await expect(run()).rejects.toThrow(/digest differs/);
});
it("names non-Error artifact failures", async () => {
  artifact();
  vi.spyOn(FileTranscriptArtifactStore.prototype, "readCanonicalBytes").mockRejectedValue(
    "unreadable",
  );
  await expect(run()).rejects.toThrow(/unreadable/);
});
it("checks a matching event digest", async () => {
  artifact();
  db.prepare(
    "UPDATE session_events SET payload=json_set(payload,'$.digest',json_extract(payload,'$.reference.id'))",
  ).run();
  expect((await run()).checkpoints[0]!.rowsThrough).toBe(1);
});
it("can cancel before artifact IO", async () => {
  artifact();
  options.signal = AbortSignal.abort();
  await expect(run()).rejects.toThrow();
});
it("can cancel before blob IO", async () => {
  db.exec("INSERT INTO blobs VALUES ('hash',1);INSERT INTO blob_links VALUES ('hash')");
  options.signal = AbortSignal.abort();
  await expect(run()).rejects.toThrow();
});

it("refuses non-UTF-8 canonical bodies rather than changing their bytes", async () => {
  artifact();
  vi.spyOn(FileTranscriptArtifactStore.prototype, "readCanonicalBytes").mockResolvedValue(
    Buffer.from([0xff]),
  );
  await expect(run()).rejects.toThrow(/not UTF-8 JSON/);
});
it("honors explicit bulk chunk byte limits", async () => {
  attachment();
  options.chunkMaxBytes = 1;
  const result = await run();
  expect(result.checkpoints[1]!.chunks).toHaveLength(1);
});
it("honors explicit bulk chunk record limits", async () => {
  artifact();
  db.exec("INSERT INTO session_events SELECT session_id,2,payload FROM session_events");
  options.chunkMaxBytes = Number.MAX_SAFE_INTEGER;
  options.chunkMaxRecords = 1;
  const result = await run();
  expect(result.checkpoints[0]!.chunks).toHaveLength(2);
});
