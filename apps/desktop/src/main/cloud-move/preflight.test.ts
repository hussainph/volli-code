/**
 * The dry run over a real profile: the shipped exporter worker under Node
 * (`worker-under-node.mjs`, with its TypeScript loader), the real verifier and
 * the real plan, against a migrated SQLite profile with UUID projects.
 *
 * The fixture is the move fixture (`migration-dry-run/test-support`): three
 * local projects — Alpha with transcripts, a Pi log, an automation and the
 * pending edges, Café with a ticket and a delegated Session, and `Gone`
 * removed — plus every exclusion the export makes. Nothing here is a fake: a
 * project's counts are what its export and plan actually carry, and a refusal
 * is one the exporter really raised.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createMoveEngine, type MoveEnginePorts } from "@volli/host-core/cloud-move";
import { automaticBackupDiskRequirement } from "@volli/host-core/migration-export";
import type {
  CloudMoveCounts,
  CloudMovePreflightProgress,
  CloudMoveProject,
  SessionTranscriptDigest,
} from "@volli/shared";
import { createLogger } from "@volli/host-core/log";
import {
  MOVE_IDS,
  writeMoveProfile,
  type MoveFault,
} from "../../../../../packages/host-core/src/migration-dry-run/test-support/move-profile";
import { SYNTHETIC_IDS as ids } from "../../../../../packages/host-core/src/migration-dry-run/test-support/synthetic-profile";
import { sessionEventImportRecord } from "../../../../../packages/host-core/src/migration-export/session-event-record";
import { prepareLocalMoves, type MovePreflightOptions, type PreparedLocalMoves } from "./preflight";

// Every test exports a real profile through a real worker thread; a cold CI disk is slow.
vi.setConfig({ testTimeout: 30_000 });

const ENTRY = new URL(
  "../../../../../packages/host-core/src/migration-export/test-support/worker-under-node.mjs",
  import.meta.url,
);
const EXEC_ARGV = ["--experimental-transform-types", "--disable-warning=ExperimentalWarning"];
const USER = "7a1f0c2e-0000-4000-8000-0000000000f1";
const WORKSPACE = "7a1f0c2e-0000-4000-8000-0000000000f2";
const RUNNER = "7a1f0c2e-0000-4000-8000-0000000000f3";
const MISSING = "7a1f0c2e-0000-4000-8000-0000000000ff";
/** Two projects a previous "Move all" named: the journal's own definition of a queue of several. */
const PRIOR = ["7a1f0c2e-0000-4000-8000-0000000000b1", "7a1f0c2e-0000-4000-8000-0000000000b2"];
const ALPHA = ids.project;
const CAFE = MOVE_IDS.project;
const REMOVED = ids.removedProject;
/** The estimate's constants, as production states them. */
const SETTLING = 11 * 60;
const estimate = (counts: CloudMoveCounts, rowCount: number, settling: number) =>
  settling +
  Math.ceil(
    120 +
      rowCount / 500 +
      (counts.attachmentBytes + counts.transcriptBytes + counts.piLogBytes) / 2_500_000,
  );

interface Fixture {
  root: string;
  dbPath: string;
  db: Database.Database;
  workRoot: string;
  run(
    input: { projectIds?: string[]; includeRemoved?: boolean },
    over?: Partial<MovePreflightOptions>,
  ): Promise<PreparedLocalMoves>;
}
const open: Fixture[] = [];
afterEach(() => {
  for (const fixture of open.splice(0)) {
    fixture.db.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

function setup(seed: { fault?: MoveFault; artifacts?: number } = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), "volli-move-preflight-"));
  const profile = writeMoveProfile(root, {
    artifacts: seed.artifacts ?? 2,
    now: 1_800_000_000_000,
    ...(seed.fault === undefined ? {} : { fault: seed.fault }),
  });
  const db = new Database(profile.dbPath);
  const workRoot = join(root, "cloud-moves");
  const base: MovePreflightOptions = {
    db,
    profilePath: profile.dbPath,
    workRoot,
    workerEntry: ENTRY,
    appVersion: "0.3.0-test",
    stores: {
      blobsDir: profile.blobsDir,
      transcriptsDir: join(root, "session-transcripts"),
      piLogsDir: join(root, "pi-sessions"),
    },
    busySessionIds: () => new Set(),
    hasMove: () => false,
    eventRecord: sessionEventImportRecord,
    workerExecArgv: EXEC_ARGV,
  };
  const fixture: Fixture = {
    root,
    dbPath: profile.dbPath,
    db,
    workRoot,
    run: (input, over = {}) =>
      prepareLocalMoves(
        { ...base, ...over },
        {
          workspaceId: null,
          includeRemoved: input.includeRemoved ?? false,
          projectIds: input.projectIds,
        },
        new AbortController().signal,
      ),
  };
  open.push(fixture);
  return fixture;
}

function project(answered: PreparedLocalMoves, id: string): CloudMoveProject {
  const found = answered.preflight.projects.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`No answer for ${id}`);
  return found;
}
/** The scratch root every project's export lives in while the dry run runs. */
const scratchDirs = (fixture: Fixture) => readdirSync(join(fixture.workRoot, "preflight"));
const rows = (answered: PreparedLocalMoves, id: string) =>
  Object.values(answered.summaries[id]!.expected).reduce((sum, count) => sum + count, 0);

function bytesUnder(directory: string): number {
  let total = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    total += entry.isDirectory() ? bytesUnder(path) : statSync(path).size;
  }
  return total;
}

describe("a dry run over a real profile", () => {
  it("counts what each project's export and plan actually carry", async () => {
    const fixture = setup();
    // The real runtime writes message semantics here, not the artifact checksum.
    const digest = { role: "assistant", reply: true } satisfies SessionTranscriptDigest;
    fixture.db
      .prepare(
        "UPDATE session_events SET payload=json_set(payload,'$.digest',json(?)) WHERE json_extract(payload,'$.kind')='transcript.referenced'",
      )
      .run(JSON.stringify(digest));
    const before = readFileSync(fixture.dbPath);
    const answered = await fixture.run({ projectIds: [ALPHA, CAFE] });
    const alpha = project(answered, ALPHA);
    const cafe = project(answered, CAFE);

    expect(answered.failures).toEqual({});
    expect(alpha.blockers).toEqual([]);
    expect(cafe.blockers).toEqual([]);
    expect(alpha.counts).toEqual({
      tickets: 4,
      sessions: 2,
      events: 9,
      attachments: 1,
      attachmentBytes: 20,
      transcriptBytes: 134_232,
      piLogBytes: 1_410_000,
    });
    expect(cafe.counts).toEqual({
      tickets: 1,
      sessions: 1,
      events: 1,
      attachments: 1,
      attachmentBytes: 20,
      transcriptBytes: 0,
      piLogBytes: 0,
    });
    // The counts are the plan's own tallies, not a second query over the profile.
    expect(answered.summaries[ALPHA]!.expected).toMatchObject({
      projects: 1,
      tickets: 4,
      sessions: 2,
      sessionEvents: 9,
      blobs: 1,
    });
    expect(answered.summaries[CAFE]!.expected).toMatchObject({
      projects: 1,
      tickets: 1,
      sessions: 1,
      sessionEvents: 1,
    });
    // Nothing local is written: the snapshot is `VACUUM INTO`, opened read-only.
    expect(readFileSync(fixture.dbPath)).toEqual(before);
    // Every project's scratch directory, export and staging included, is gone.
    expect(scratchDirs(fixture)).toEqual([]);
  });

  it("adds the signed-history wait to a project with history, and nothing to one without", async () => {
    const fixture = setup();
    const answered = await fixture.run({ projectIds: [ALPHA, CAFE] });
    const alpha = project(answered, ALPHA);
    const cafe = project(answered, CAFE);

    // Transcripts and Pi logs are uploaded through signed URLs, so the verify
    // step waits that URL out before it checks: 11 minutes, once per project.
    expect(alpha.estimateSeconds).toBe(estimate(alpha.counts!, rows(answered, ALPHA), SETTLING));
    expect(alpha.estimateSeconds).toBeGreaterThanOrEqual(SETTLING);
    // Café moves no Session history, so nothing is signed and nothing waits.
    expect(cafe.estimateSeconds).toBe(estimate(cafe.counts!, rows(answered, CAFE), 0));
    expect(cafe.estimateSeconds).toBeLessThan(SETTLING);
  });

  it("reports each project's own exclusions and references, never another project's", async () => {
    const fixture = setup();
    const answered = await fixture.run({ projectIds: [ALPHA, CAFE] });
    const alpha = project(answered, ALPHA);
    const cafe = project(answered, CAFE);

    expect(answered.summaries[ALPHA]!.pausedAutomations).toEqual(["Review"]);
    expect(alpha.exclusions).toEqual([
      {
        label: "Automatic starts",
        count: 1,
        reason: "Automations move paused; re-arm them in Volli Cloud.",
      },
      { label: "Automation: Review", count: 1, reason: "Moves paused; re-arm it in Volli Cloud." },
    ]);
    expect(cafe.exclusions).toEqual([]);
    // The other side is named as the person knows it, never by its id.
    expect(alpha.warnings).toEqual([
      "Ticket prefix AL is used by 2 projects; ticket keys may be ambiguous.",
      `1 shared attachments to ${cafe.name}.`,
      `2 ticket references to ${cafe.name}.`,
    ]);
    expect(cafe.warnings).toEqual([
      "Ticket prefix AL is used by 2 projects; ticket keys may be ambiguous.",
      `1 Session links to ${alpha.name}.`,
      `1 shared attachments to ${alpha.name}.`,
      `1 ticket references to ${alpha.name}.`,
    ]);
  });

  it("bounds the disk the backup and the exports need on the volume that holds both", async () => {
    const fixture = setup();
    const answered = await fixture.run({ projectIds: [ALPHA, CAFE] });
    const { disk, backupDirectory } = answered.preflight;
    const database =
      statSync(fixture.dbPath).size +
      (existsSync(`${fixture.dbPath}-wal`) ? statSync(`${fixture.dbPath}-wal`).size : 0);
    const artifacts =
      bytesUnder(join(fixture.root, "blobs")) +
      bytesUnder(join(fixture.root, "session-transcripts"));

    expect(backupDirectory).toBe(join(fixture.root, "backups"));
    expect(answered.estimatedExportBytes).toBe(
      answered.summaries[ALPHA]!.estimatedExportBytes +
        answered.summaries[CAFE]!.estimatedExportBytes,
    );
    // The profile and the scratch root are one volume here, so both bounds are added.
    expect(disk.requiredBytes).toBe(
      automaticBackupDiskRequirement(database, artifacts) +
        2 * answered.estimatedExportBytes +
        256 * 1024 * 1024,
    );
    expect(disk.freeBytes).toBeGreaterThan(0);
    expect(answered.preflight.exclusions).toEqual([
      { label: "Personal files", reason: "Skills and templates stay on this Mac." },
      {
        label: "Secrets and API keys",
        reason:
          "Credentials stay sealed on this Mac; re-enter them on other machines or for teammates.",
      },
      { label: "Removed projects", reason: "Not moved unless you include them." },
    ]);
  });

  it("answers every requested id it will not export, and says what would change it", async () => {
    const fixture = setup();
    fixture.db
      .prepare(
        `INSERT INTO projects (id,name,path,ticket_prefix,color_index,sort_order,created_at,updated_at)
         VALUES ('legacy-project','Legacy','/tmp/legacy','LG',0,3,1,1)`,
      )
      .run();

    const answered = await fixture.run({
      projectIds: [MISSING, REMOVED, "legacy-project"],
    });
    // A local project keeps its place in the profile's order; the rest are answered after.
    expect(answered.preflight.projects.map((entry) => entry.id)).toEqual([
      "legacy-project",
      MISSING,
      REMOVED,
    ]);
    expect(project(answered, "legacy-project")).toMatchObject({
      name: "Legacy",
      counts: null,
      estimateSeconds: null,
      blockers: [{ message: "This project has an unsupported local identifier." }],
    });
    expect(project(answered, MISSING)).toEqual({
      id: MISSING,
      name: "Unavailable project",
      removed: false,
      counts: null,
      estimateSeconds: null,
      blockers: [{ message: "This project is no longer a local project on this Mac." }],
      exclusions: [],
      warnings: [],
    });
    expect(project(answered, REMOVED)).toMatchObject({
      name: "Gone",
      removed: true,
      counts: null,
      blockers: [
        { message: "This project was removed. Turn on Include removed projects to move it." },
      ],
    });
    expect(answered.summaries).toEqual({});
    expect(scratchDirs(fixture)).toEqual([]);
  });

  it("exports a removed project only when it is asked for", async () => {
    const fixture = setup();
    const answered = await fixture.run({ projectIds: [REMOVED], includeRemoved: true });
    const gone = project(answered, REMOVED);

    expect(gone.blockers).toEqual([]);
    expect(gone.removed).toBe(true);
    // The removed project's ticket and its Session travel, and nothing else does.
    expect(gone.counts).toMatchObject({ tickets: 1, sessions: 1, events: 1, transcriptBytes: 0 });
    expect(answered.preflight.exclusions.at(-1)).toEqual({
      label: "Removed projects",
      reason: "Included only because you selected them.",
    });
  });
});

describe("what stops a project", () => {
  it("names the Session that is busy or waiting, and only the project's own", async () => {
    const fixture = setup();
    // A drained Session is not this Mac's local work, but the engine's idle
    // check still reads every Session of the project: so does the dry run.
    const busy = await fixture.run(
      { projectIds: [ALPHA] },
      { busySessionIds: () => new Set([MOVE_IDS.drainedSession]) },
    );
    expect(project(busy, ALPHA).blockers).toEqual([
      {
        message: "Finish this Session’s turn, shell or terminal first.",
        sessionId: MOVE_IDS.drainedSession,
      },
    ]);
    expect(project(busy, ALPHA).counts).toBeNull();
    expect(busy.failures).toEqual({});

    // Alpha's own Session stops Alpha, and Café is answered regardless.
    const other = await fixture.run(
      { projectIds: [ALPHA, CAFE] },
      { busySessionIds: () => new Set([ids.hotSession]) },
    );
    expect(project(other, ALPHA).blockers).toEqual([
      {
        message: "Finish this Session’s turn, shell or terminal first.",
        sessionId: ids.hotSession,
      },
    ]);
    expect(project(other, CAFE).blockers).toEqual([]);
    expect(project(other, CAFE).counts).not.toBeNull();
    expect(other.failures).toEqual({});
  });

  it("names the queued messages, notices, Run messages and cleanup in the way", async () => {
    const fixture = setup();
    // The fixture already queues on a drained Session: not this Mac's work, so not a blocker.
    expect(project(await fixture.run({ projectIds: [ALPHA] }), ALPHA).blockers).toEqual([]);

    fixture.db
      .prepare(
        "INSERT INTO session_follow_up_queue (session_id,state,pending_count) VALUES (?,'{}',2)",
      )
      .run(ids.hotSession);
    fixture.db
      .prepare(
        "INSERT INTO host_notice_outbox (command_id, session_id, notice) VALUES ('notice-1', ?, '{}')",
      )
      .run(ids.hotSession);
    fixture.db
      .prepare("INSERT INTO automation_commands (id,intent,created_at) VALUES ('cmd-1','{}',1)")
      .run();
    fixture.db
      .prepare(
        `INSERT INTO automation_run_deliveries
           (run_id, session_id, automation_command_id, message_command_id, message_id, text, resources, created_at, delivered_at)
         VALUES (?, ?, 'cmd-1', 'message-command', 'message-1', 'hello', '[]', 1, NULL)`,
      )
      .run(ids.run, ids.hotSession);
    fixture.db
      .prepare(
        "INSERT INTO worktree_cleanup_commands (id, intent, created_at) VALUES ('cleanup-1', ?, 1)",
      )
      .run(JSON.stringify({ kind: "orphan.cleanup", items: [{ id: "item-1", projectId: ALPHA }] }));

    const blocked = await fixture.run({ projectIds: [ALPHA] });
    expect(project(blocked, ALPHA).blockers).toEqual([
      { message: "Settle this Session’s queued messages first.", sessionId: ids.hotSession },
      { message: "Deliver this Session’s waiting notices first.", sessionId: ids.hotSession },
      { message: "Settle this Session’s waiting Run messages first.", sessionId: ids.hotSession },
      { message: "Let this project’s worktree cleanup finish first." },
    ]);
    // A cleanup the person stopped is not pending work anyone is waiting for.
    fixture.db
      .prepare(
        `INSERT INTO worktree_cleanup_facts (id, command_id, kind, payload, created_at)
         VALUES ('fact-1','cleanup-1','cleanup.run.interrupted','{}',2)`,
      )
      .run();
    const interrupted = await fixture.run({ projectIds: [ALPHA] });
    expect(project(interrupted, ALPHA).blockers).toHaveLength(3);
  });

  it("does not promise to merge a cloud copy kept by Go back to local", async () => {
    const fixture = setup();
    const answered = await fixture.run({ projectIds: [CAFE] }, { hasCloudCopy: () => true });
    expect(project(answered, CAFE).counts).toBeNull();
    expect(project(answered, CAFE).blockers).toEqual([
      {
        message:
          "Volli Cloud keeps a copy of this project. Moving again would not merge its changes.",
      },
    ]);
    expect(scratchDirs(fixture)).toEqual([]);
  });
  it("refuses a project that already has a move", async () => {
    const fixture = setup();
    const answered = await fixture.run({ projectIds: [CAFE] }, { hasMove: () => true });
    expect(project(answered, CAFE).blockers).toEqual([
      { message: "This project already has a move. Open its progress to continue." },
    ]);
    expect(project(answered, CAFE).counts).toBeNull();
  });
});

describe("one project's refusal", () => {
  it("leaves the other project's counts and leaves no scratch directory behind", async () => {
    // A label id that is not a UUID: the exporter refuses that row (a refused row is a lost row).
    const fixture = setup({ fault: "nonUuid" });
    const answered = await fixture.run({ projectIds: [ALPHA, CAFE] });
    const alpha = project(answered, ALPHA);

    expect(answered.failures).toEqual({ [ALPHA]: "row_refused" });
    expect(alpha.counts).toBeNull();
    expect(alpha.estimateSeconds).toBeNull();
    expect(alpha.blockers).toEqual([
      { message: "A local record has an unsupported identifier or format." },
    ]);
    // The refusal is a sentence, not an exception: no path, no record, no id.
    expect(JSON.stringify(alpha)).not.toContain(fixture.root);
    expect(JSON.stringify(alpha)).not.toContain("not-a-uuid");

    expect(answered.summaries[ALPHA]).toBeUndefined();
    expect(project(answered, CAFE).blockers).toEqual([]);
    expect(project(answered, CAFE).counts).toMatchObject({ tickets: 1, sessions: 1 });
    expect(answered.summaries[CAFE]!.counts).toEqual(project(answered, CAFE).counts);
    // The refused project's half-written export is deleted with its scratch directory.
    expect(scratchDirs(fixture)).toEqual([]);
  });
});

/** Every line a logger was given, as the log file would hold it. */
function recordingLog() {
  const lines: Record<string, unknown>[] = [];
  const log = createLogger({
    component: "cloud-move",
    level: "debug",
    sink: { write: (record) => lines.push(record as unknown as Record<string, unknown>) },
  });
  return { log, lines };
}

describe("a dry run at scale (VC-1029)", () => {
  /**
   * The owner's profile: 878k events, ~580k transcript artifacts, 8 GB of Pi
   * logs, and a five-minute target. A dry run's cost must not grow with what a
   * copy of the history weighs: it takes one snapshot for every project and
   * checks the history without staging it. These profiles are that shape
   * scaled down (two projects plus a removed one, a thousand and four
   * thousand artifacts of 26 KiB): what the scratch holds must stay flat as
   * the history grows fourfold, and the time each extra artifact costs must
   * stay inside the owner's per-artifact budget, with five times the slack.
   */
  const OWNER_ARTIFACTS = 582_366;
  const PER_ARTIFACT_BUDGET_MS = ((5 * 60_000) / OWNER_ARTIFACTS) * 5;

  async function dryRunAt(artifacts: number) {
    const fixture = setup({ artifacts });
    const { log, lines } = recordingLog();
    const preflightRoot = join(fixture.workRoot, "preflight");
    const staged: { files: string[]; inodes: number[]; bytes: number }[] = [];
    const seen: CloudMovePreflightProgress[] = [];
    const startedAt = performance.now();
    const answered = await fixture.run(
      { projectIds: [ALPHA, CAFE] },
      {
        log,
        onProgress: (progress) => {
          seen.push(progress);
          if (progress.phase !== "verifying" && progress.phase !== "planning") return;
          // What the scratch holds once a project's export is published.
          const files: string[] = [];
          const walk = (directory: string) => {
            for (const entry of readdirSync(directory, { withFileTypes: true })) {
              const path = join(directory, entry.name);
              if (entry.isDirectory()) walk(path);
              else files.push(path.slice(preflightRoot.length));
            }
          };
          walk(preflightRoot);
          const kept = files.filter((file) => file.endsWith("/snapshot.db"));
          staged.push({
            files,
            inodes: kept.map((file) => statSync(join(preflightRoot, file)).ino),
            bytes: bytesUnder(preflightRoot),
          });
        },
      },
    );
    const elapsed = performance.now() - startedAt;
    return { fixture, answered, lines, seen, staged, elapsed };
  }

  it("takes one snapshot, stages no history, and logs every phase without content", async () => {
    const { fixture, answered, lines, seen, staged } = await dryRunAt(4096);

    expect(answered.failures).toEqual({});
    expect(project(answered, ALPHA).counts?.transcriptBytes).toBeGreaterThan(100 * 1024 * 1024);
    // No history chunk is ever staged, and one snapshot file serves every project.
    expect(staged.length).toBeGreaterThanOrEqual(4);
    for (const moment of staged) {
      expect(moment.files.filter((file) => /transcriptArtifacts|piLogs/.test(file))).toEqual([]);
      expect(moment.inodes).toHaveLength(1);
    }
    // The same kept file from the first project to the last: never taken twice.
    expect(new Set(staged.flatMap((moment) => moment.inodes)).size).toBe(1);
    // The phases a person sees, in order, with counts while reading history.
    expect([...new Set(seen.map((progress) => progress.phase))]).toEqual([
      "checking",
      "snapshot",
      "reading",
      "exporting",
      "history",
      "verifying",
      "planning",
      "sizing",
    ]);
    expect(seen.some((progress) => progress.phase === "history" && progress.done! > 0)).toBe(true);
    expect(seen.every((progress) => progress.projectCount === 2)).toBe(true);
    // Every phase's start is logged with its end and duration; no name, path or content.
    const started = lines.filter((line) => line.msg === "dry run phase started");
    const finished = lines.filter((line) => line.msg === "dry run phase finished");
    expect(finished).toHaveLength(started.length);
    for (const line of finished) expect(line.durationMs).toEqual(expect.any(Number));
    expect(lines.at(-1)).toMatchObject({ msg: "dry run finished", outcome: "ok" });
    const text = JSON.stringify(lines);
    for (const secret of [fixture.root, "Alpha", "Caf", "日本語"])
      expect(text).not.toContain(secret);
    expect(scratchDirs(fixture)).toEqual([]);
  }, 120_000);

  it("stays flat on disk and inside the owner's per-artifact time as the history grows", async () => {
    const small = await dryRunAt(1024);
    const large = await dryRunAt(4096);
    const [atSmall, atLarge] = [small, large].map((run) => ({
      transcripts: project(run.answered, ALPHA).counts!.transcriptBytes,
      scratch: Math.max(...run.staged.map((moment) => moment.bytes)),
    }));
    // Four times the history (some 75 MiB more to copy), and the scratch grows
    // only by the extra events' own rows: under a tenth of what a copy would add.
    const grown = atLarge!.transcripts - atSmall!.transcripts;
    expect(grown).toBeGreaterThan(75 * 1024 * 1024);
    expect(atLarge!.scratch - atSmall!.scratch).toBeLessThan(grown / 10);
    expect((large.elapsed - small.elapsed) / (4096 - 1024)).toBeLessThan(PER_ARTIFACT_BUDGET_MS);
  }, 180_000);

  it("sweeps the scratch a dry run cut short by a quit or a restart left behind", async () => {
    const fixture = setup();
    const abandoned = join(fixture.workRoot, "preflight", "6b0c4bde-0000-4000-8000-000000000001");
    mkdirSync(join(abandoned, CAFE, "export.partial"), { recursive: true });
    writeFileSync(join(abandoned, CAFE, "export.partial", "snapshot.db"), "left behind");
    await fixture.run({ projectIds: [CAFE] });
    expect(existsSync(abandoned)).toBe(false);
    expect(scratchDirs(fixture)).toEqual([]);
  });
});

const nope = async (): Promise<never> => {
  throw new Error("A dry run takes no move step");
};
/** The production writer of a queue, with every other port refusing to be reached. */
function journal(fixture: Fixture) {
  const ports: MoveEnginePorts = {
    db: fixture.db,
    profilePath: fixture.dbPath,
    workRoot: fixture.workRoot,
    stores: { blobsDir: "", transcriptsDir: "", piLogsDir: "" },
    homeDir: fixture.root,
    appVersion: "0.3.0-test",
    backend: { query: nope, mutation: nope, action: nope },
    objects: { put: nope, head: nope, digest: nope },
    history: {
      eventRecord: sessionEventImportRecord,
      upload: nope,
      seedCursors: () => {},
    },
    backup: { write: nope },
    identity: { current: async () => null },
    liveWork: { busySessionIds: () => new Set() },
    realPath: { check: nope },
    exportProject: nope,
  };
  return createMoveEngine(ports);
}

describe("the stop-at-first-problem default", () => {
  it("is on for a single project, on for the first queue of several, off after one has run", async () => {
    const fixture = setup();
    const single = await fixture.run({ projectIds: [CAFE] });
    expect(single.preflight.stopAtFirstProblem).toBe(true);
    const first = await fixture.run({ projectIds: [ALPHA, CAFE] });
    expect(first.preflight.stopAtFirstProblem).toBe(true);

    // A real earlier "Move all", written by the engine's own enqueue.
    journal(fixture).enqueue({
      projectIds: PRIOR,
      target: { userId: USER, workspaceId: WORKSPACE, runnerId: RUNNER },
    });
    const later = await fixture.run({ projectIds: [ALPHA, CAFE] });
    expect(later.preflight.stopAtFirstProblem).toBe(false);
    expect(later.preflight.projects.every((entry) => entry.counts !== null)).toBe(true);
    // A single project still stops at its own problem, however many queues came before.
    expect((await fixture.run({ projectIds: [CAFE] })).preflight.stopAtFirstProblem).toBe(true);
  });
});
