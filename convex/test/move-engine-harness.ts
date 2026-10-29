/**
 * The move engine (host-core `cloud-move/`) end to end against the real
 * person-authorized import, in-process under `convex-test`: Alice owns a
 * Workspace and a runner, a synthetic local profile (host-core's dry-run
 * fixture, migrated by the real migrations) holds the project she moves, and
 * the engine runs every step through `projectImports.*` and the window's own
 * public reads, signed in as her.
 *
 * Objects go through the production store (`presignedMoveObjects`): every
 * PUT, HEAD and GET presigned by the real `projectImports` actions and
 * checked by the S3 stand-in; Session history through the production port
 * (`createMoveSessionHistory`: the runner's spool over the import's doors,
 * real transcript bodies and a Pi log on disk). Stand-ins at the other
 * ports: the backup writer, this Mac's live work and the identity. `kill` points let the kill/resume matrix stop
 * the engine dead at any step boundary or mid-step, as a crash would.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makeFunctionReference } from "convex/server";
import { MIGRATION_IMPORT_STREAMS, MigrationDigest, migrationRowDigest } from "@volli/shared/cloud";

import { vi } from "vite-plus/test";

import { createMoveEngine, type MoveEngine } from "../../packages/host-core/src/cloud-move/engine";
import { presignedMoveObjects } from "../../packages/host-core/src/cloud-move/objects";
import { createMoveSessionHistory } from "../../packages/host-core/src/cloud-move/session-history";
import { openRawDb } from "../../packages/host-core/src/db/test-helpers";
import { writeMoveProfile } from "../../packages/host-core/src/migration-dry-run/test-support/move-profile";
import { createFileTranscriptArtifactStore } from "../../packages/host-core/src/session-runtime/transcript-artifacts";
import { ExactValueByteRedactor } from "@volli/shared";
import type { MoveBackend, MoveEnginePorts } from "../../packages/host-core/src/cloud-move/ports";
import { windowReadCheck } from "../../packages/host-core/src/cloud-move/real-paths";
import { SYNTHETIC_IDS } from "../../packages/host-core/src/migration-dry-run/test-support/synthetic-profile";
import { exportMigrationSnapshot } from "../../packages/host-core/src/migration-export/exporter";
import { seedTestWorld } from "../functions/lib/testWorld";
import { setup, signIn, type Tester } from "./board-helpers";
import { S3StandIn } from "./s3-standin";

/** A signed-in tester called by function path, as the engine's backend port calls it. */
type Untyped = Record<
  "query" | "mutation" | "action",
  (reference: unknown, args: Record<string, unknown>) => Promise<unknown>
>;

/** Stops the engine where it stands: the promise never settles, like a killed process. */
export const NEVER = new Promise<never>(() => {});

export interface Kill {
  /** Engine fault points (`freeze`, `rows.tickets`, …) and backend calls (`call:projectImports:commit`). */
  point: string;
  /** Which hit of the point (1-based). */
  hit: number;
  /** For backend calls: stop after the call landed (the client never hears back), or before it. */
  after?: boolean;
  /** Told when the engine stops there. */
  onKilled?: () => void;
}

export interface Flaps {
  /**
   * Every `every`-th backend call fails as the network would, before it
   * reaches the backend (`every: 1`: the network is down). Not a request
   * already dropped once, unless the network is down.
   */
  every: number;
}

type Db = ReturnType<typeof openRawDb>;

/**
 * The dry run's synthetic profile, its `$`-keyed schema and 300 KiB payload
 * included: the move stores every event hot, as JSON text, and spills
 * nothing.
 */
export function writeMoveFixture(root: string, artifacts = 12) {
  // Transcript bodies (mixed plain and gzip) and a multi-slice Pi log on the
  // moved project's busiest Session, so its history uploads too.
  return writeMoveProfile(root, { artifacts, now: 1_790_000_000_000 });
}

export interface MoveWorld {
  t: Tester;
  root: string;
  db: Db;
  /** The object store the move uploads to (write-once, signature-checked). */
  objects: S3StandIn;
  userId: string;
  runnerId: string;
  /** Another runner of Alice's: what this Mac is registered as after a replacement. */
  otherRunnerId: string;
  workspaceId: string;
  projectId: string;
  /** Backend calls made, by path, across every engine of this world. */
  calls: Map<string, number>;
  /** A fresh engine over the same profile and backend: what a relaunch builds. */
  engine(options?: { kill?: Kill; flaps?: Flaps; ports?: Partial<MoveEnginePorts> }): MoveEngine;
  /** The backend as Alice's sign-in calls it, for a port a test builds itself. */
  backend(): MoveBackend;
  cleanup(): void;
}

export async function moveWorld(fixture: { artifacts?: number } = {}): Promise<MoveWorld> {
  const t = setup();
  const alice = await signIn(t, "alice");
  const world = await t.run((ctx) => seedTestWorld(ctx, { ownerUserId: alice.userId, runners: 2 }));
  const runnerId = world.runnerIds[0]!;
  const root = mkdtempSync(join(tmpdir(), "volli-move-engine-"));
  const profile = writeMoveFixture(join(root, "profile"), fixture.artifacts);
  const db = openRawDb(profile.dbPath);
  db.pragma("foreign_keys = ON");
  const objects = new S3StandIn().install();
  const calls = new Map<string, number>();

  const backendFor = (kill?: Kill, flaps?: Flaps): MoveBackend => {
    const hits = new Map<string, number>();
    const dropped = new Set<string>();
    let made = 0;
    const call =
      (kind: "query" | "mutation" | "action") =>
      async (path: string, args: Record<string, unknown>) => {
        made += 1;
        // A dropped request, once: the same request sent again goes through.
        const request = `${path}:${JSON.stringify(args)}`;
        if (
          flaps !== undefined &&
          made % flaps.every === 0 &&
          (flaps.every === 1 || !dropped.has(request))
        ) {
          dropped.add(request);
          throw new TypeError("fetch failed");
        }
        const point = `call:${path}`;
        const hit = (hits.get(point) ?? 0) + 1;
        hits.set(point, hit);
        const dies = kill?.point === point && kill.hit === hit;
        if (dies && kill.after !== true) {
          kill.onKilled?.();
          return NEVER;
        }
        calls.set(path, (calls.get(path) ?? 0) + 1);
        const answer = await (alice.as as unknown as Untyped)[kind](
          makeFunctionReference(path),
          args,
        );
        if (dies) {
          kill!.onKilled?.();
          return NEVER;
        }
        return answer;
      };
    return { query: call("query"), mutation: call("mutation"), action: call("action") };
  };

  let backupWrites = 0;
  return {
    t,
    root,
    db,
    objects,
    userId: alice.userId,
    runnerId,
    otherRunnerId: world.runnerIds[1]!,
    workspaceId: world.workspaceId,
    projectId: SYNTHETIC_IDS.project,
    calls,
    backend: () => backendFor(),
    engine(options = {}) {
      const faultHits = new Map<string, number>();
      const kill = options.kill;
      const backend = backendFor(kill, options.flaps);
      const ports: MoveEnginePorts = {
        db,
        profilePath: profile.dbPath,
        workRoot: join(root, "cloud-moves"),
        stores: {
          blobsDir: profile.blobsDir,
          transcriptsDir: join(root, "profile", "session-transcripts"),
          piLogsDir: join(root, "profile", "pi-sessions"),
        },
        homeDir: join(root, "profile"),
        appVersion: "0.3.0-test",
        backend,
        history: createMoveSessionHistory({
          db,
          backend,
          artifacts: createFileTranscriptArtifactStore(
            join(root, "profile", "session-transcripts"),
          ),
          redaction: {
            step: (window, from, final) => new ExactValueByteRedactor([]).step(window, from, final),
            complete: () => true,
          },
          piDirectory: join(root, "profile", "pi-sessions"),
          fetch: objects.fetch as unknown as typeof globalThis.fetch,
          sleep: async () => {},
        }),
        objects: presignedMoveObjects({
          backend,
          fetch: objects.fetch as unknown as typeof globalThis.fetch,
        }),
        backup: {
          async write() {
            backupWrites += 1;
            const path = join(root, `backup-${backupWrites}.tar.gz`);
            writeFileSync(path, "backup");
            return { path, bytes: 6 };
          },
        },
        liveWork: { busySessionIds: () => new Set<string>() },
        identity: { current: async () => ({ userId: alice.userId, runnerId }) },
        realPath: windowReadCheck({ backend, sleep: async () => {}, foldTimeoutMs: 0 }),
        exportProject: (exportOptions) => exportMigrationSnapshot(exportOptions),
        sleep: async () => {},
        faults: async (point) => {
          const hit = (faultHits.get(point) ?? 0) + 1;
          faultHits.set(point, hit);
          if (kill?.point === point && kill.hit === hit) {
            kill.onKilled?.();
            await NEVER;
          }
        },
        ...options.ports,
      };
      return createMoveEngine(ports);
    },
    cleanup() {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/**
 * What the backend holds for the moved project, stream by stream: the
 * accumulators (they only grow on insert, so they are exactly what is
 * stored) and a direct scan of the project's own rows in the tables a
 * second insert would show in.
 */
export async function finalDigests(world: MoveWorld, moveId: string) {
  const as = world.t.withIdentity({ subject: "user:alice", issuer: "https://issuer.test" });
  const status = (await (as as unknown as Untyped).query(
    makeFunctionReference("projectImports:status"),
    { moveId },
  )) as {
    status: string;
    streams: Array<{ stream: string; count: number; digest: string }>;
  };
  const scanned = await world.t.run(async (ctx) => {
    const out: Record<string, { count: number; digest: string }> = {};
    for (const stream of ["tickets", "ticketComments", "sessionEvents", "boardEvents"] as const) {
      const digest = new MigrationDigest();
      for (const row of await ctx.db.query(stream).collect()) {
        const { _id, _creationTime, ...doc } = row as Record<string, unknown>;
        if (doc.projectId !== undefined && doc.projectId !== world.projectId) continue;
        if (stream === "sessionEvents" && doc.sessionId === undefined) continue;
        digest.add(migrationRowDigest(stream, doc));
      }
      out[stream] = { count: digest.count, digest: digest.value };
    }
    return out;
  });
  return {
    status: status.status,
    streams: Object.fromEntries(
      MIGRATION_IMPORT_STREAMS.map((stream) => {
        const entry = status.streams.find((s) => s.stream === stream)!;
        return [stream, { count: entry.count, digest: entry.digest }];
      }),
    ),
    scanned,
  };
}
