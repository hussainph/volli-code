/** The actual rehearsal worker against the pinned backend and an HTTP S3
 * fixture. Only expiry sleeps are shortened by direct composition; the CLI
 * has no bypass. Backup, exporter, imports, history, window reads are real.
 */
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRawDb } from "../../packages/host-core/src/db/test-helpers";
import { expect, test, vi } from "vite-plus/test";
import { api, internal } from "../functions/_generated/api";
import { connectBackend } from "../fixture/testing";
import { mintTestToken } from "../fixture/jwt";
import { verifyS3MoveRequest, verifyS3ReadRequest, verifyS3Request } from "../fixture/s3-boundary";
import { enrollBackendPreview } from "./preview-fixtures";
import { runRehearsalChild } from "../../packages/host-core/src/migration-dry-run/move-rehearsal";
import {
  runMoveJob,
  type MoveJob,
} from "../../packages/host-core/src/migration-dry-run/move-worker";
import { writeMoveProfile } from "../../packages/host-core/src/migration-dry-run/test-support/move-profile";

test("Move all on a synthetic copy verifies, resumes unchanged, rolls back and goes back to local", async () => {
  const backend = connectBackend();
  const subject = `user:rehearsal-${randomUUID()}`;
  const person = backend.client(subject);
  const { userId } = await person.mutation(api.accounts.ensureViewer, {});
  await enrollBackendPreview(backend, person, userId);
  const runnerId = await backend.admin(internal.testSeed.seedRunner, {
    ownerUserId: userId,
    name: "Rehearsal",
  });
  const workspaceId = randomUUID();
  await person.mutation(api.workspaces.create, {
    workspaceId,
    name: `migration-rehearsal-${workspaceId}`,
  });
  const root = mkdtempSync(join(tmpdir(), "move-rehearsal-http-"));
  const source = join(root, "source"),
    profile = join(root, "copy");
  const fixture = writeMoveProfile(source, { artifacts: 4 });
  // All backend files share one deployment. Do not collide with the original
  // migration dry-run test's fixed synthetic UUIDs.
  const unique = openRawDb(fixture.dbPath);
  try {
    unique.pragma("foreign_keys = OFF");
    const prefix = randomUUID().slice(0, 24);
    const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
    for (const { name } of unique
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[]) {
      for (const column of unique.prepare(`PRAGMA table_info(${quote(name)})`).all() as {
        name: string;
        type: string;
      }[]) {
        if (column.type === "TEXT")
          unique
            .prepare(
              `UPDATE ${quote(name)} SET ${quote(column.name)}=replace(${quote(column.name)},?,?) WHERE instr(${quote(column.name)},?)>0`,
            )
            .run("7a1f0c2e-0000-4000-8000-", prefix, "7a1f0c2e-0000-4000-8000-");
      }
    }
    expect(unique.pragma("foreign_key_check")).toEqual([]);
  } finally {
    unique.close();
  }
  const original = readFileSync(fixture.dbPath);
  // Cross-platform test copy; the operator CLI strictly requires cp -c on APFS.
  cpSync(source, profile, { recursive: true });
  const objects = new Map<string, Buffer>();
  const config = {
    endpoint: "",
    bucket: "volli-test",
    region: "auto",
    accessKeyId: "test-access",
    secretAccessKey: "test-secret",
  };
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url!, config.endpoint);
      const headers = Object.fromEntries(
        Object.entries(req.headers).map(([k, v]) => [k, String(v)]),
      );
      const request = { method: req.method!, headers };
      if (req.method === "PUT") {
        const key =
          headers["if-none-match"] === "*"
            ? verifyS3MoveRequest(request, url, config)
            : verifyS3Request(request, url, config);
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const bytes = Buffer.concat(chunks);
        expect(createHash("sha256").update(bytes).digest("base64")).toBe(
          headers["x-amz-checksum-sha256"],
        );
        if (objects.has(key) && headers["if-none-match"] === "*") {
          res.writeHead(412).end();
          return;
        }
        objects.set(key, bytes);
        res.writeHead(200).end();
      } else {
        const key = verifyS3ReadRequest(request, url, config);
        const bytes = objects.get(key);
        if (!bytes) {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, {
          "content-length": bytes.length,
          "x-amz-checksum-sha256": createHash("sha256").update(bytes).digest("base64"),
        });
        res.end(req.method === "HEAD" ? undefined : bytes);
      }
    } catch {
      res.writeHead(500).end();
    }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  config.endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const changes = {
    VOLLI_S3_ENDPOINT: config.endpoint,
    VOLLI_S3_BUCKET: config.bucket,
    VOLLI_S3_REGION: config.region,
    VOLLI_S3_ACCESS_KEY_ID: config.accessKeyId,
    VOLLI_S3_SECRET_ACCESS_KEY: config.secretAccessKey,
    VOLLI_MIGRATION_REHEARSAL: "enabled",
  };
  const update = await fetch(`${backend.url}/api/update_environment_variables`, {
    method: "POST",
    headers: {
      authorization: `Convex ${process.env.VOLLI_CONVEX_ADMIN_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      changes: Object.entries(changes).map(([name, value]) => ({ name, value })),
    }),
  });
  expect(update.ok).toBe(true);
  vi.stubEnv(
    "VOLLI_MOVE_TOKEN",
    mintTestToken(process.env.VOLLI_CONVEX_TEST_PRIVATE_KEY!, subject),
  );
  const file = join(root, "job.json");
  const job: MoveJob = {
    source,
    profile,
    target: backend.url,
    allowProduction: false,
    userId,
    runnerId,
    workspaceId,
    includeRemoved: false,
    operation: "run",
  };
  writeFileSync(file, JSON.stringify(job));
  try {
    // Public clients cannot call the cleanup helper, even with its exact args.
    await expect(
      person.mutation(
        internal.migration.cleanupRehearsal as never,
        { workspaceId, userId } as never,
      ),
    ).rejects.toThrow();
    for (const kill of ["upload", "import"] as const) {
      const current = JSON.parse(readFileSync(file, "utf8")) as MoveJob;
      writeFileSync(file, JSON.stringify({ ...current, kill }));
      expect((await runRehearsalChild(file, () => {})).killed).toBe(true);
    }
    writeFileSync(
      file,
      JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), kill: undefined }),
    );
    try {
      await runMoveJob(file, async () => {});
    } catch (error) {
      const diagnostic = openRawDb(join(profile, "volli.db"));
      try {
        throw new Error(
          JSON.stringify(
            diagnostic
              .prepare("SELECT state,paused,failure_json,report_json FROM cloud_moves")
              .all(),
          ),
          { cause: error },
        );
      } finally {
        diagnostic.close();
      }
    }
    const db = openRawDb(join(profile, "volli.db"));
    try {
      const moves = db
        .prepare(
          "SELECT move_id,state,report_json FROM cloud_moves WHERE workspace_id=? ORDER BY position",
        )
        .all(workspaceId) as { move_id: string; state: string; report_json: string }[];
      expect(moves).toHaveLength(2);
      expect(
        moves.every((m) => m.state === "checked" && JSON.parse(m.report_json).ok === true),
      ).toBe(true);
      const before = db.prepare("SELECT * FROM cloud_moves").all();
      await runMoveJob(file, async () => {});
      expect(db.prepare("SELECT * FROM cloud_moves").all()).toEqual(before);
      expect(objects.size).toBeGreaterThan(0);
      const first = moves[0]!.move_id;
      const current = JSON.parse(readFileSync(file, "utf8")) as MoveJob;
      writeFileSync(file, JSON.stringify({ ...current, operation: "rollback", moveId: first }));
      await runMoveJob(file, async () => {});
      expect(db.prepare("SELECT state FROM cloud_moves WHERE move_id=?").pluck().get(first)).toBe(
        "rolled_back",
      );
      const second = moves[1]!.move_id;
      writeFileSync(file, JSON.stringify({ ...current, operation: "go-back", moveId: second }));
      await runMoveJob(file, async () => {});
      expect(db.prepare("SELECT state FROM cloud_moves WHERE move_id=?").pluck().get(second)).toBe(
        "returned",
      );
      expect(readFileSync(fixture.dbPath)).toEqual(original);
    } finally {
      db.close();
    }
  } finally {
    vi.unstubAllEnvs();
    // The fixture backend is destroyed by global teardown, including its
    // scheduled purge. The unit cleanup tests cover final Workspace removal.
    await new Promise<void>((done) => server.close(() => done()));
    rmSync(root, { recursive: true, force: true });
    await fetch(`${backend.url}/api/update_environment_variables`, {
      method: "POST",
      headers: {
        authorization: `Convex ${process.env.VOLLI_CONVEX_ADMIN_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        changes: Object.keys(changes).map((name) => ({ name, value: null })),
      }),
    });
  }
}, 180_000);
