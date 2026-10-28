import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vite-plus/test";
import { writeSyntheticProfile } from "../migration-dry-run/test-support/synthetic-profile";
import { exportMigrationSnapshot, type MigrationExportManifest } from "./exporter";
import type { StreamName } from "./sources";
import { verifyMigrationExport } from "./verify";

// This matrix first migrates and exports a real profile, not an in-memory manifest.
vi.setConfig({ testTimeout: 30_000 });

const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const digest = `sha256:${sha("{}")}`;
const event = {
  sessionId: "s",
  sequence: 1,
  payload: { kind: "transcript.referenced", reference: { id: digest }, digest },
};
const artifact = { sessionId: "s", sequence: 1, digest, canonicalJson: "{}" };
const pi = (start = 0, fileBytes = 4) => ({
  sessionId: "s",
  piFileId: "pi",
  attachmentId: "a",
  startOffset: start,
  endOffset: start + 2,
  fileBytes,
  base64: Buffer.from("a\n").toString("base64"),
  sourceBytes: 2,
  sourceSha256: sha("a\n"),
});

it("refuses forged work promises, malformed history and incomplete source coverage", async () => {
  const root = mkdtempSync(join(tmpdir(), "volli-verify-safety-"));
  try {
    const profile = writeSyntheticProfile(root);
    const { outDir, manifest: empty } = await exportMigrationSnapshot({
      sourcePath: profile.dbPath,
      outDir: join(root, "export"),
      appVersion: "test",
      projectIds: [],
    });
    type Case = {
      rows?: Partial<Record<StreamName, Record<string, unknown>[]>>;
      edit?: (m: MigrationExportManifest) => void;
      error?: RegExp;
    };
    const cases: Case[] = [
      {
        edit: (m) => {
          (m as { pendingRunnerWork: boolean }).pendingRunnerWork = true;
        },
        error: /promise/,
      },
      ...(
        [
          "pendingFollowUps",
          "undeliveredNotices",
          "undeliveredRunMessages",
          "openCleanupCommands",
        ] as const
      ).map((name) => ({
        edit: (m: MigrationExportManifest) => {
          m.preflight[name] = 1;
        },
        error: /Pending runner work/,
      })),
      ...(["runnerJobs", "automationArmings", "automationScheduleCursors"] as const).map(
        (name) => ({
          edit: (m: MigrationExportManifest) => {
            m.streams.find((s) => s.name === name)!.records = 1;
          },
          error: /pending runner work/,
        }),
      ),
      {
        rows: { tickets: [{}] },
        edit: (m) => {
          m.streams.find((s) => s.name === "tickets")!.chunks[0]!.file = "../escape";
        },
        error: /chunk path/,
      },
      {
        rows: { sessionEvents: [{ ...event, payload: { kind: "transcript.referenced" } }] },
        error: /Invalid transcript/,
      },
      {
        rows: { sessionEvents: [{ ...event, payload: { ...event.payload, digest: "different" } }] },
        error: /Invalid transcript/,
      },
      { rows: { sessionEvents: [{ ...event, payload: null }] } },
      { rows: { sessionEvents: [event], transcriptArtifacts: [artifact] } },
      {
        rows: { sessionEvents: [event], transcriptArtifacts: [artifact, artifact] },
        error: /Duplicate transcript/,
      },
      {
        rows: { transcriptArtifacts: [{ ...artifact, canonicalJson: 5 }] },
        error: /digest mismatch/,
      },
      { rows: { transcriptArtifacts: [artifact] }, error: /coverage is incomplete/ },
      {
        rows: { sessionEvents: [event], transcriptArtifacts: [{ ...artifact, sequence: 2 }] },
        error: /coverage is incomplete/,
      },
      { rows: { piLogs: [pi(0), pi(2)] } },
      {
        edit: (m) => {
          delete (m as Partial<MigrationExportManifest>).piLogFiles;
        },
        error: /Missing Pi log/,
      },
      {
        rows: { piLogs: [pi(0, 2)] },
        edit: (m) => {
          m.piLogFiles.push(m.piLogFiles[0]!);
        },
        error: /Duplicate Pi log/,
      },
      {
        rows: { piLogs: [pi(0, 2)] },
        edit: (m) => {
          m.piLogFiles[0]!.sessionId = 5 as unknown as string;
        },
        error: /Invalid Pi log/,
      },
      {
        rows: { piLogs: [pi(0, 2)] },
        edit: (m) => {
          m.piLogFiles[0]!.attachmentId = 5 as unknown as string;
        },
        error: /Invalid Pi log/,
      },
      {
        rows: { piLogs: [pi(0, 2)] },
        edit: (m) => {
          m.piLogFiles[0]!.piFileId = 5 as unknown as string;
        },
        error: /Invalid Pi log/,
      },
      {
        rows: { piLogs: [pi(0, 2)] },
        edit: (m) => {
          m.piLogFiles[0]!.fileBytes = -1;
        },
        error: /Invalid Pi log/,
      },
      {
        rows: { piLogs: [pi(0, 2)] },
        edit: (m) => {
          m.piLogFiles[0]!.fileBytes = 1.5;
        },
        error: /Invalid Pi log/,
      },
      {
        rows: { piLogs: [pi(0, 2)] },
        edit: (m) => {
          m.piLogFiles = [];
        },
        error: /checksum mismatch/,
      },
      {
        rows: { piLogs: [pi(0, 2)] },
        edit: (m) => {
          m.piLogFiles[0]!.attachmentId = "other";
        },
        error: /checksum mismatch/,
      },
      {
        rows: {
          piLogs: [
            {
              ...pi(),
              base64: "",
              endOffset: 0,
              fileBytes: 0,
              sourceBytes: 0,
              sourceSha256: sha(""),
            },
            {
              ...pi(),
              base64: "",
              endOffset: 0,
              fileBytes: 0,
              sourceBytes: 0,
              sourceSha256: sha(""),
            },
          ],
        },
        error: /checksum mismatch/,
      },
      { rows: { piLogs: [{ ...pi(), base64: 5 }] }, error: /Invalid Pi/ },
      {
        rows: { piLogs: [{ ...pi(), fileBytes: 1.5 }] },
        edit: (m) => {
          m.piLogFiles[0]!.fileBytes = 4;
        },
        error: /Invalid Pi/,
      },
      {
        rows: { piLogs: [{ ...pi(), fileBytes: -1 }] },
        edit: (m) => {
          m.piLogFiles[0]!.fileBytes = 4;
        },
        error: /Invalid Pi/,
      },
      { rows: { piLogs: [{ ...pi(), base64: "!" }] }, error: /checksum mismatch/ },
      { rows: { piLogs: [{ ...pi(), startOffset: 1 }] }, error: /checksum mismatch/ },
      { rows: { piLogs: [{ ...pi(), endOffset: 3 }] }, error: /checksum mismatch/ },
      { rows: { piLogs: [pi(0), pi(2, 5)] }, error: /checksum mismatch/ },
      { rows: { piLogs: [pi(0, 1)] }, error: /checksum mismatch/ },
      {
        rows: { piLogs: [{ ...pi(), base64: "", startOffset: 0, endOffset: 0 }] },
        error: /checksum mismatch/,
      },
      { rows: { piLogs: [{ ...pi(), sourceBytes: 3 }] }, error: /checksum mismatch/ },
      {
        rows: {
          piLogs: [
            { ...pi(), base64: Buffer.from("aa").toString("base64"), sourceSha256: sha("aa") },
          ],
        },
        error: /checksum mismatch/,
      },
      { rows: { piLogs: [{ ...pi(), sourceSha256: "wrong" }] }, error: /checksum mismatch/ },
      { rows: { piLogs: [pi(0)] }, error: /coverage is incomplete/ },
      {
        rows: {
          piLogs: [
            {
              ...pi(),
              base64: "",
              endOffset: 0,
              fileBytes: 0,
              sourceBytes: 0,
              sourceSha256: sha(""),
            },
          ],
        },
      },
    ];
    for (const test of cases) {
      rmSync(join(outDir, "streams"), { recursive: true, force: true });
      const manifest = structuredClone(empty);
      for (const [name, rows] of Object.entries(test.rows ?? {})) {
        const stream = manifest.streams.find((s) => s.name === name)!;
        const file = `streams/${name}/000001.ndjson`;
        const text = rows.map((row) => JSON.stringify(row) + "\n").join("");
        mkdirSync(join(outDir, "streams", name), { recursive: true });
        writeFileSync(join(outDir, file), text);
        stream.records = rows.length;
        stream.bytes = Buffer.byteLength(text);
        stream.chunks = [{ file, records: rows.length, bytes: stream.bytes, sha256: sha(text) }];
      }
      manifest.piLogFiles = [
        ...new Map(
          (test.rows?.piLogs ?? []).map((row) => [
            JSON.stringify([row.sessionId, row.piFileId]),
            {
              sessionId: row.sessionId as string,
              attachmentId: row.attachmentId as string,
              piFileId: row.piFileId as string,
              fileBytes: row.fileBytes as number,
            },
          ]),
        ).values(),
      ];
      test.edit?.(manifest);
      writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest));
      if (test.error) await expect(verifyMigrationExport(outDir)).rejects.toThrow(test.error);
      else await verifyMigrationExport(outDir);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
