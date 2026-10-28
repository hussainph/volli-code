/**
 * The move engine (host-core `cloud-move/`) end to end against the real
 * person-authorized import, in-process under `convex-test`: Alice owns a
 * Workspace and a runner, a synthetic local profile (host-core's dry-run
 * fixture, migrated by the real migrations) holds the project she moves, and
 * the engine runs every step through `projectImports.*` and the window's own
 * signed in as her.
 *
 * Stand-ins, each at a port the engine names: object storage (a write-once
 * map, as the store's `If-None-Match: *` makes R2), the Session-history
 * upload (nothing to pack in this fixture), the backup writer, this Mac's
 * live work and the identity. `kill` points let the kill/resume matrix stop
 * the engine dead at any step boundary or mid-step, as a crash would.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makeFunctionReference } from "convex/server";
import { MIGRATION_IMPORT_STREAMS, MigrationDigest, migrationRowDigest } from "@volli/shared/cloud";

import { createMoveEngine, type MoveEngine } from "../../packages/host-core/src/cloud-move/engine";
import { sessionEventImportRecord } from "../../packages/host-core/src/migration-export/session-event-record";
import { openRawDb } from "../../packages/host-core/src/db/test-helpers";
import type {
  MoveBackend,
  MoveEnginePorts,
  MoveObjectStore,
  MoveSessionHistory,
} from "../../packages/host-core/src/cloud-move/ports";
import {
  SYNTHETIC_IDS,
  writeSyntheticProfile,
} from "../../packages/host-core/src/migration-dry-run/test-support/synthetic-profile";
import { exportMigrationSnapshot } from "../../packages/host-core/src/migration-export/exporter";
import { seedTestWorld } from "../functions/lib/testWorld";
import { setup, signIn, type Tester } from "./board-helpers";

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
  /** Every `every`-th backend call fails as the network would, before it reaches the backend. */
  every: number;
}

/** A write-once object store: what R2 does with the move's `If-None-Match: *` PUTs. */
export class ObjectStandIn implements MoveObjectStore {
  readonly objects = new Map<string, Uint8Array>();
  async put(
    _moveId: string,
    object: { key: string; bytes: number; sha256: string },
    body: () => Promise<Uint8Array | NodeJS.ReadableStream>,
  ): Promise<"stored" | "exists"> {
    if (this.objects.has(object.key)) return "exists";
    const source = await body();
    const chunks: Uint8Array[] = [];
    if (source instanceof Uint8Array) chunks.push(source);
    else for await (const chunk of source as AsyncIterable<Uint8Array>) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    const sha256 = (await import("node:crypto")).createHash("sha256").update(bytes).digest("hex");
    // The store checks the length and checksum the URL was signed for.
    if (bytes.length !== object.bytes || sha256 !== object.sha256) {
      throw Object.assign(new Error("400"), { data: { code: "object_refused" } });
    }
    this.objects.set(object.key, bytes);
    return "stored";
  }
  async head(_moveId: string, key: string) {
    const bytes = this.objects.get(key);
    if (bytes === undefined) return null;
    const sha256 = (await import("node:crypto")).createHash("sha256").update(bytes).digest("hex");
    return { bytes: bytes.length, sha256 };
  }
  async get(_moveId: string, key: string) {
    return this.objects.get(key) ?? null;
  }
}

type Db = ReturnType<typeof openRawDb>;

/** The Session-history port for a fixture with no transcripts or Pi logs. */
function testHistory(): MoveSessionHistory & { uploads: string[] } {
  const uploads: string[] = [];
  return {
    uploads,
    // The importer's own encoding: payload and provenance as JSON text.
    eventRecord: sessionEventImportRecord,
    async upload(_move, session) {
      uploads.push(session.sessionId);
      return { missing: [], piFilesLeftBehind: 0, packs: 0, piSegments: 0 };
    },
  };
}

/**
 * The dry run's synthetic profile, its `$`-keyed schema and 300 KiB payload
 * included: the move stores every event hot, as JSON text, and spills
 * nothing.
 */
export function writeMoveFixture(root: string) {
  const profile = writeSyntheticProfile(root, 1_790_000_000_000);
  for (const dir of ["session-transcripts", "pi-sessions"])
    mkdirSync(join(root, dir), { recursive: true });
  return profile;
}

export interface MoveWorld {
  t: Tester;
  root: string;
  db: Db;
  objects: ObjectStandIn;
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
  cleanup(): void;
}

export async function moveWorld(): Promise<MoveWorld> {
  const t = setup();
  const alice = await signIn(t, "alice");
  const world = await t.run((ctx) => seedTestWorld(ctx, { ownerUserId: alice.userId, runners: 2 }));
  const runnerId = world.runnerIds[0]!;
  const root = mkdtempSync(join(tmpdir(), "volli-move-engine-"));
  const profile = writeMoveFixture(join(root, "profile"));
  const db = openRawDb(profile.dbPath);
  db.pragma("foreign_keys = ON");
  const objects = new ObjectStandIn();
  const calls = new Map<string, number>();
  const history = testHistory();

  const backendFor = (kill?: Kill, flaps?: Flaps): MoveBackend => {
    const hits = new Map<string, number>();
    let made = 0;
    const call =
      (kind: "query" | "mutation" | "action") =>
      async (path: string, args: Record<string, unknown>) => {
        made += 1;
        if (flaps !== undefined && made % flaps.every === 0) throw new TypeError("fetch failed");
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
        objects,
        history,
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
