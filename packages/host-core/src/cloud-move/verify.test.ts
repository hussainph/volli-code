import { describe, expect, test } from "vite-plus/test";
import {
  MIGRATION_IMPORT_STREAMS,
  MigrationDigest,
  migrationDocument,
  migrationRowDigest,
} from "@volli/shared/cloud";
import {
  MIGRATION_FIXTURE_RECORDS,
  fixtureUuid as U,
} from "../../../shared/src/cloud/migration-import.fixture";
import { importCalls } from "./backend";
import type { MovePlan } from "./plan";
import { verifyHiddenImport } from "./verify";

describe("moved Automation pause verification", () => {
  test.each(["automationArmings", "automationSchedules"] as const)(
    "checks the non-digested pause stamp on %s",
    async (stream) => {
      const target = { userId: U(901), workspaceId: U(902), runnerId: U(903) };
      const row = migrationDocument(stream, MIGRATION_FIXTURE_RECORDS[stream], target, 100);
      const expected = MIGRATION_IMPORT_STREAMS.map((name) => {
        const tally = new MigrationDigest();
        if (name === stream) tally.add(migrationRowDigest(name, row));
        return { stream: name, count: tally.count, digest: tally.value };
      });
      const plan: MovePlan = {
        projectId: U(1),
        exportManifestSha256: "a".repeat(64),
        expected,
        tickets: {},
        sessions: {},
        sessionList: [],
        lastEventIds: {},
        ticketNumbers: 0,
        objects: [],
        exported: {},
      };
      let pausedAt: unknown = 100;
      const unexpected = async (): Promise<never> => {
        throw new Error("unexpected write or object read");
      };
      const calls = importCalls(
        {
          query: async (path, args) =>
            path === "projectImports:status"
              ? { streams: expected }
              : {
                  rows: args.stream === stream ? [{ ...row, pausedAt }] : [],
                  isDone: true,
                  continueCursor: "",
                },
          mutation: unexpected,
          action: unexpected,
        },
        { attempts: 1, baseMs: 0, maxMs: 0, sleep: unexpected },
      );
      const verify = () =>
        verifyHiddenImport({
          calls,
          plan,
          moveId: U(900),
          runnerId: target.runnerId,
          objects: { put: unexpected, head: unexpected, digest: unexpected },
          signal: new AbortController().signal,
        });
      expect((await verify()).ok).toBe(true);
      for (pausedAt of [null, undefined, "100", NaN]) {
        const report = await verify();
        expect(report.streams[stream]!.match).toBe(true); // The digest alone cannot catch this.
        expect(report.ok).toBe(false);
        expect(report.invariants.automationNotPaused).toBe(1);
      }
    },
  );
});
