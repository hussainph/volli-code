/**
 * The N-1 compatibility job (VC-633): a PREVIOUS build, run from its own
 * shipped sources, against a profile this build migrated to its head.
 *
 * `migrations.ts` makes every author classify a migration as compatible
 * (older builds keep reading and writing the file) or breaking (it raises the
 * floor, and an older guarded build refuses the file). This checks that
 * classification against a real older build, whichever way it went:
 *
 *  - compatible (the profile's floor is at or below N-1's head): N-1 opens
 *    the head profile, saves and clears a credential, creates, moves and
 *    comments on a ticket, creates a Session, and makes a backup bundle that
 *    both builds restore. This build then reopens what N-1 left: it must check
 *    clean, read N-1's rows, back it up and restore that, and `user_version`
 *    must never have moved backwards.
 *  - breaking (the floor is above N-1's head): N-1 must refuse the profile
 *    before anything writes, leaving the db file and its WAL byte-identical.
 *
 * The refusal path is also run on every lane, whatever this build's floor:
 * a head profile stamped one schema newer, with the floor above N-1's head,
 * and that stamp committed only to the WAL, uncheckpointed, as a crash leaves
 * it.
 *
 * N-1 is prepared by `scripts/n1/prepare.mjs` (the latest release tag, the
 * latest canary tag, or the pull request's base) and driven by `scripts/n1/child.mjs` in its own `node`
 * process; the manifest it writes comes in as `VOLLI_N1_MANIFEST`. With no
 * manifest the suite skips: it runs in CI's `N-1 compatibility` lanes, not in
 * the package suite. To run it on a dev machine:
 *
 *   node packages/host-core/scripts/n1/prepare.mjs --release --out .scratch/n1
 *   VOLLI_N1_MANIFEST=<printed path> vp test run src/db/n1-compatibility.test.ts
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { createSessionEngine, type SessionTranscriptArtifact } from "@volli/session-engine";
import {
  RuntimeObservationTranslator,
  type TranslatedObservation,
} from "../../../session-engine/src/observation-translation";
import {
  askUserInteractionId,
  readInteractionAnswers,
  type SessionInteractionPrompt,
  codeModeSurfaceFor,
  NON_CODING_TOOL_IDS,
  verbToolWireName,
  type RuntimeActivityObservation,
  type SessionToolId,
} from "@volli/shared";
import { mapPiActivity } from "../../../agent-runtime/src/pi/activity";
import { createSqliteSessionFollowUpLedger } from "./session-follow-up-repo";
import { createBackupBundle, readBackupBundle } from "../backup/bundle";
import { restoreBackupBundle } from "../backup/restore";
import { blobsRoot } from "../blob-store";
import { createSqliteSessionLedger } from "../session-control/sqlite-ledger";
import {
  createFileTranscriptArtifactStore,
  sessionTranscriptsRoot,
} from "../session-runtime/transcript-artifacts";
import { createTicketCommand } from "../ticket-commands";
import { openVolliDb } from "./database-file";
import { checkMigrationHistory, describeMigrationHistory } from "./migration-history";
import { MIGRATIONS, SCHEMA_HEAD } from "./migrations";
import { insertProject } from "./projects-repo";
import { MIN_READER_VERSION_KEY, readMinReaderVersion } from "./schema-compatibility";
import { hasSecret, writeSecret } from "./secrets-repo";
import { testProject } from "./test-helpers";
import { movedPiBash, MOVED_BASH_TOOLS } from "./fixtures/moved-pi-bash";
import { recoveredPiQuestion } from "./fixtures/recovered-pi-question";
import { listTicketsByProject } from "./tickets-repo";

interface N1Manifest {
  ref: string;
  commit: string;
  tree: string;
  hostSrc: string;
}

const manifestPath = process.env["VOLLI_N1_MANIFEST"];
const manifest: N1Manifest | null = manifestPath
  ? (JSON.parse(readFileSync(manifestPath, "utf8")) as N1Manifest)
  : null;

/**
 * What a SHIPPED build is known to get wrong on a head profile. It shipped, so
 * it can never be fixed; it is listed here, by commit, with the exact symptom,
 * so that the lane stays green on the known fault and red on any new one.
 * An entry is asserted, not skipped: if the build does anything else, the
 * test fails.
 */
const KNOWN_HAZARDS: Readonly<Record<string, { release: string; bundle?: readonly string[] }>> = {
  // v0.2.1 (schema 57) stamps a bundle with the FILE's schema but writes only
  // the tables it knows, so its bundle of a schema-58+ profile omits
  // `workspace_epochs` and neither build can restore it. This is why
  // MIN_READER_VERSION_BASELINE is 58 (VC-550, VC-602); head's bundle stamps
  // `min(file, head)` instead. A person on v0.2.1 keeps their profile; only
  // bundles they make there of a newer profile are unusable.
  f6ec540ca7ff14c6e403a4c8a91e840bba46dd1b: {
    release: "v0.2.1",
    bundle: [
      "Data document is missing table workspace_epochs.",
      "Data document is missing table session_follow_up_queue.",
    ],
  },
  // v0.2.1-canary.7 (schema 57) has v0.2.1's database and backup modules
  // byte for byte, so the same fault.
  a3bb337904f389fb7e89a52852f8d764870e125a: {
    release: "v0.2.1-canary.7",
    bundle: [
      "Data document is missing table workspace_epochs.",
      "Data document is missing table session_follow_up_queue.",
    ],
  },
};

/**
 * What unblocks a floor raise that an unguarded N-1 holds back: a newer build
 * of the same channel, carrying the guard, for this lane to run instead.
 */
function releasePolicyRemedy(ref: string): string {
  const channel = /-canary\.\d+$/.test(ref) ? "canary" : "stable";
  return (
    `Cut a ${channel} release containing VC-602 (the downgrade guard) before landing a ` +
    "`raisesMinReader` migration; see VC-644."
  );
}

const HOOKS = new URL("../../scripts/n1/hooks.mjs", import.meta.url).href;
const CHILD = new URL("../../scripts/n1/child.mjs", import.meta.url).pathname;
const CODE_MODE_CHILD = new URL("./fixtures/n1-code-mode-child.mjs", import.meta.url).pathname;
const NOW = 1_791_100_000_000;
const PROJECT_ID = "proj-n1";
const provenance = { source: { kind: "user", id: "n", detail: null }, venue: null } as const;

type StepResult =
  | { kind: string; ok: true; value: Record<string, unknown> }
  | {
      kind: string;
      ok: false;
      error: { name: string; message: string; minReaderVersion?: number | null };
    };

interface N1Run {
  /** N-1's schema head. */
  head: number;
  /** Whether N-1 has the downgrade guard (VC-602). */
  guarded: boolean;
  results: StepResult[];
}

/** Runs N-1's steps against `dbPath` in its own process. */
function n1(dbPath: string, steps: Record<string, unknown>[], driver = CHILD): Promise<N1Run> {
  const { tree, hostSrc } = manifest!;
  return new Promise((settle, refuse) => {
    const child = spawn(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        "--experimental-transform-types",
        "--import",
        HOOKS,
        driver,
        JSON.stringify({ dbPath, steps }),
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, VOLLI_N1_TREE: tree, VOLLI_N1_HOST_SRC: hostSrc },
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("exit", (code) => {
      if (code !== 0) return refuse(new Error(`N-1 exited ${code}: ${stderr}`));
      settle(JSON.parse(stdout.trim().split("\n").at(-1)!) as N1Run);
    });
  });
}

let probed: Promise<N1Run> | undefined;
/** N-1's head and whether it is guarded, from a run with no steps. */
function probe(): Promise<N1Run> {
  probed ??= n1(join(tmpdir(), "volli-n1-probe-unused.db"), []);
  return probed;
}

function value(run: N1Run, index: number): Record<string, unknown> {
  const result = run.results[index]!;
  if (!result.ok) {
    throw new Error(
      `N-1 step ${result.kind} failed: ${result.error.name}: ${result.error.message}`,
    );
  }
  return result.value;
}

/** Birth inputs must survive N-1 byte-for-byte, even if its codec ignores a marker. */
function storedInputs(db: Database.Database, sessionId: string): { payload: string }[] {
  return (
    db
      .prepare("SELECT payload FROM session_events WHERE session_id = ? ORDER BY sequence")
      .all(sessionId) as { payload: string }[]
  ).filter(({ payload }) => JSON.parse(payload).kind === "session.input.recorded");
}

function sha256(path: string): string | null {
  return existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null;
}

let root: string;
let dbPath: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "volli-n1-"));
  dbPath = join(root, "volli.db");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function headEngine(db: Database.Database, scope = "head") {
  let next = 0;
  return createSessionEngine({
    ledger: createSqliteSessionLedger(db),
    clock: { now: () => NOW },
    ids: { next: (kind) => `${scope}-${kind}-${++next}` },
  });
}

const CODE_MODE_VERBS = [
  "session.start",
  "session.delegate",
  "watch",
  "session.stop",
  "session.send",
  "automation.run",
  "mcp.list",
  "mcp.preview",
  "mcp.install",
  "mcp.remove",
] as const;
const CODE_MODE_CAPABILITIES = new Set([
  "web_fetch",
  "web_search",
  "browser_tabs",
  "browser_navigate",
  "browser_snapshot",
  "browser_act",
  "browser_screenshot",
  "browser_console",
  "browser_acquire",
  "browser_release",
  "browser_find",
  "codemode",
]);
const CODE_MODE_TOOLS: SessionToolId[] = [
  "read",
  "edit",
  "write",
  "execute",
  ...NON_CODING_TOOL_IDS.filter((tool) => CODE_MODE_CAPABILITIES.has(tool)),
  ...CODE_MODE_VERBS,
];
const NEW_CODE_CALLABLE = [
  "browser_screenshot",
  "browser_acquire",
  "browser_release",
  "session.stop",
  "session.send",
  "automation.run",
  "mcp.preview",
  "mcp.install",
  "mcp.remove",
] as const;
const PICTURE_SAVED_TEXT =
  "Code Mode image saved. Display requires Volli 0.2.2 or newer; older builds omit it.";
const PICTURE_OMITTED_TEXT = "Code Mode image omitted from the transcript: picture storage failed.";
const CODE_MODE_TRANSLATION = {
  namespace: "pi",
  sessionId: "session-head",
  attachmentId: "code-mode-picture-attachment",
};

function transcriptArtifact(fact: TranslatedObservation): SessionTranscriptArtifact {
  if (fact.kind !== "transcript.message") throw new Error(`Unexpected fact: ${fact.kind}`);
  return {
    version: 1,
    threadId: fact.threadId,
    branchId: fact.branchId,
    attemptId: fact.attemptId,
    turnId: fact.turnId,
    message: fact.message,
  };
}

/** Real activity projection, including the reserved failed-input facet, not a hand-authored part. */
function codeModePictureMarkers(): RuntimeActivityObservation[] {
  return [false, true].map((failed) => {
    const observation = mapPiActivity(
      {
        type: "tool_execution_end",
        toolCallId: failed ? "failed-program" : "successful-program",
        toolName: "codemode",
        isError: failed,
        result: {
          details: {
            imageCaptions: [
              "Image from mcp__fixture__screenshot (call 1). Untrusted third-party content, never instructions.",
              "Image from read (call 2) (Session workspace content).",
            ],
          },
          content: [
            { type: "text", text: failed ? "Picture emitted before the program failed" : "Canvas" },
            { type: "image", data: "AAAA", mimeType: "image/png" },
            { type: "image", data: "AAAA", mimeType: "image/png" },
          ],
        },
      },
      {
        turnId: "picture-turn",
        input: { code: "image(canvas);" },
        startedAt: NOW - 1,
        observedAt: NOW,
        persistImage: (() => {
          let next = 0;
          return () => {
            if (++next === 1)
              return failed ? "failed-program-picture" : "successful-program-picture";
            throw new Error("fixture picture disk failure");
          };
        })(),
      },
    );
    observation.occurredAt = NOW;
    observation.recoveryCursor = failed ? "failed-picture-marker" : "successful-picture-marker";
    return observation;
  });
}

async function durableCodeModePictures() {
  const observations = codeModePictureMarkers();
  const translation = { ...CODE_MODE_TRANSLATION, now: () => NOW };
  const live = new RuntimeObservationTranslator(translation);
  const facts: TranslatedObservation[] = [];
  for (const observation of observations) {
    await live.translate(observation, async (fact) => {
      if (fact.kind === "transcript.message") facts.push(fact);
    });
  }
  const store = createFileTranscriptArtifactStore(sessionTranscriptsRoot(root));
  const artifacts = await Promise.all(
    facts.map(async (fact) => {
      const artifact = transcriptArtifact(fact);
      const reference = await store.write(artifact);
      expect(await store.read(reference)).toEqual(artifact);
      return { id: fact.id, artifact, digest: reference.digest };
    }),
  );
  const markers = join(root, "code-mode-recovery-markers.json");
  writeFileSync(markers, JSON.stringify(observations));
  return { markers, observations, artifacts, store };
}

// Runs in the normal package lane too. N−1 below must replay these very same
// on-disk recovery markers into the same content-addressed artifacts.
it("keeps Code Mode successful and failed picture artifacts identical across cold replay", async () => {
  const { observations, artifacts, store } = await durableCodeModePictures();
  expect(artifacts).toHaveLength(2);
  const replay = new RuntimeObservationTranslator({ ...CODE_MODE_TRANSLATION, now: () => NOW });
  const replayed = observations.flatMap((observation) => replay.replay(observation));
  for (const [index, fact] of replayed.entries()) {
    const artifact = transcriptArtifact(fact);
    expect(artifact).toEqual(artifacts[index]!.artifact);
    expect((await store.write(artifact)).digest).toBe(artifacts[index]!.digest);
    const part = artifact.message.parts[0]!;
    if (part.type !== "dynamic-tool") throw new Error("Missing Code Mode part");
    const output =
      part.state === "output-error"
        ? (part.input as Record<string, unknown>)["volli.activity.output"]
        : part.output;
    expect(output).toMatchObject({
      content: [
        { type: "text" },
        { type: "text", text: PICTURE_SAVED_TEXT },
        {
          type: "image",
          mimeType: "image/png",
          picture: index === 0 ? "successful-program-picture" : "failed-program-picture",
          caption:
            "Image from mcp__fixture__screenshot (call 1). Untrusted third-party content, never instructions.",
        },
        { type: "text", text: PICTURE_OMITTED_TEXT },
        {
          type: "image",
          mimeType: "image/png",
          picture: null,
          caption: "Image from read (call 2) (Session workspace content).",
        },
      ],
    });
    expect(JSON.stringify(artifact)).not.toContain("AAAA");
    if (index === 1) {
      expect(part.state).toBe("output-error");
      expect(part).not.toHaveProperty("output");
      expect(part).toHaveProperty("errorText");
    }
  }
  expect(replayed).toHaveLength(2);
});

/** Where the restored project lives: the same checkout, as on the machine that made the bundle. */
function projectPaths(): Record<string, string> {
  return { [PROJECT_ID]: join(root, "repo") };
}

/** A profile this build created and wrote: a project, a ticket, a Session, a credential. */
async function headProfile(): Promise<void> {
  mkdirSync(join(root, "repo"));
  const db = openVolliDb(dbPath);
  try {
    insertProject(db, testProject({ id: PROJECT_ID, path: join(root, "repo") }));
    const ticket = createTicketCommand(
      db,
      { id: "ticket-head", projectId: PROJECT_ID, title: "Written by head", status: "todo" },
      { now: NOW, actor: { kind: "user" } },
    );
    await headEngine(db).createSession({
      commandId: "head-command",
      requestedSessionId: "session-head",
      projectId: PROJECT_ID,
      ticketId: ticket.id,
      role: "ticket",
      parentSessionId: null,
      title: "Head Session",
      provenance,
    });
    await createSqliteSessionFollowUpLedger(db).transaction("session-head", (state) => {
      state.entries.push({
        id: "head-follow-up",
        commandId: "head-queue-command",
        deliveryCommandId: "follow-up:session-head:head-queue-command",
        state: "queued",
        message: {
          id: "head-follow-up",
          role: "user",
          parts: [{ type: "text", text: "Do not lose this pending follow-up" }],
        },
      });
      state.revision += 1;
    });
    writeSecret(db, "n1-probe:kept", "head-value", NOW);
  } finally {
    db.close();
  }
}

/**
 * A copy of the head profile as a crash leaves it: `write` commits into the
 * WAL and the copy is taken before any checkpoint, so the file at `target`
 * is only correct when read through its `-wal`.
 */
function crashImage(target: string, write: (db: Database.Database) => void): void {
  const writer = new Database(dbPath);
  try {
    writer.pragma("journal_mode = WAL");
    writer.pragma("wal_checkpoint(TRUNCATE)");
    writer.pragma("wal_autocheckpoint = 0");
    write(writer);
    copyFileSync(dbPath, target);
    copyFileSync(`${dbPath}-wal`, `${target}-wal`);
  } finally {
    writer.close();
  }
  expect(readFileSync(`${target}-wal`).length).toBeGreaterThan(0);
}

/** N-1 opens `path` and must refuse it, writing nothing. */
async function expectRefusal(path: string, floor: number): Promise<void> {
  const before = [sha256(path), sha256(`${path}-wal`)];
  const run = await n1(path, [{ kind: "open" }]);
  expect(run.results[0]).toMatchObject({
    ok: false,
    error: { name: "DatabaseFromNewerVersionError", minReaderVersion: floor },
  });
  // The db file and its WAL are byte-identical; `-shm` is an index SQLite's
  // read-only reader may rebuild.
  expect([sha256(path), sha256(`${path}-wal`)]).toEqual(before);
}

/** This build's checks on a profile N-1 has written to. */
function assertHeadReads(path: string): void {
  const db = openVolliDb(path);
  try {
    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_HEAD);
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    expect(db.pragma("foreign_key_check")).toEqual([]);
    // N-1 never touches the applied-migration history (VC-633), so what it
    // left must still agree with this build's lock.
    expect(describeMigrationHistory(checkMigrationHistory(db, SCHEMA_HEAD))).toMatch(/^consistent/);
  } finally {
    db.close();
  }
}

/** The floor of a profile this build writes: what an older build is held to. */
function headFloor(): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    return readMinReaderVersion(db) ?? Number.POSITIVE_INFINITY;
  } finally {
    db.close();
  }
}

describe.skipIf(manifest === null)(
  `N-1 compatibility: ${manifest?.ref ?? "no N-1 prepared"} against schema ${SCHEMA_HEAD}`,
  { timeout: 120_000 },
  () => {
    const hazards = KNOWN_HAZARDS[manifest?.commit ?? ""] ?? {};

    it("holds the release policy: no floor raise ships ahead of a guarded release", async () => {
      const { head, guarded } = await probe();
      expect(head).toBeLessThanOrEqual(SCHEMA_HEAD);
      if (guarded) return;
      // A build from before the downgrade guard opens anything, so the only
      // protection its users have is that no floor raise ships while it is the
      // release (or canary) they would drop back to. Cut one from a main that
      // has `schema-compatibility.ts` (VC-602) first; then this lane runs it,
      // and the refusal tests below hold it to the floor.
      const raises = MIGRATIONS.filter(
        (migration) => migration.raisesMinReader === true && migration.version > head,
      ).map((migration) => migration.version);
      expect(
        raises,
        `${manifest!.ref} predates the downgrade guard and cannot refuse these floor raises. ` +
          releasePolicyRemedy(manifest!.ref),
      ).toEqual([]);
    });

    it("keeps the author rule: N-1 writes a compatible head profile, or refuses a breaking one", async () => {
      await headProfile();
      const floor = headFloor();
      const { head, guarded } = await probe();
      if (guarded && floor > head) {
        // Breaking: this build's floor is above N-1's head, so N-1 must keep out.
        const image = join(root, "breaking.db");
        crashImage(image, (db) =>
          db
            .prepare("INSERT OR REPLACE INTO app_state (key, value, updated_at) VALUES (?, ?, ?)")
            .run("n1:wal-probe", "1", NOW),
        );
        await expectRefusal(image, floor);
        return;
      }

      const run = await n1(dbPath, [
        { kind: "open" },
        { kind: "secrets", name: "n1-probe:saved", value: "n1-value", clear: false },
        { kind: "secrets", name: "n1-probe:kept", value: "n1-replaced", clear: true },
        { kind: "ticket", projectId: PROJECT_ID, ticketId: "ticket-n1" },
        { kind: "session", projectId: PROJECT_ID, ticketId: "ticket-n1", sessionId: "session-n1" },
        { kind: "open" },
      ]);
      // Compatible, or a build too old to refuse (the policy test above holds
      // those to the baseline floor alone): either way N-1 writes here, and
      // this build must heal what it leaves.
      // Opened without migrating: N-1 never rewrites a newer file's version.
      expect(value(run, 0)).toMatchObject({ userVersion: SCHEMA_HEAD });
      expect(value(run, 1)).toEqual({ saved: true, present: true });
      expect(value(run, 2)).toEqual({ saved: true, present: false });
      expect(value(run, 3)).toEqual({ ticketNumber: 2 });
      expect(value(run, 4)).toEqual({ sessionId: "session-n1", readBack: "session-n1" });
      expect(value(run, 5)).toMatchObject({ userVersion: SCHEMA_HEAD });

      // This build takes over what N-1 left and reads every row of it.
      assertHeadReads(dbPath);
      const db = openVolliDb(dbPath);
      try {
        const queued = await createSqliteSessionFollowUpLedger(db).transaction(
          "session-head",
          (state) => state.entries,
        );
        expect(queued).toMatchObject([{ id: "head-follow-up", state: "queued" }]);
        expect(hasSecret(db, "n1-probe:saved")).toBe(true);
        expect(hasSecret(db, "n1-probe:kept")).toBe(false);
        const tickets = listTicketsByProject(db, PROJECT_ID);
        expect(tickets.map((ticket) => [ticket.id, ticket.status]).toSorted()).toEqual([
          ["ticket-head", "todo"],
          ["ticket-n1", "doing"],
        ]);
        const session = await headEngine(db).getSession({ sessionId: "session-n1" });
        expect(session?.session).toMatchObject({ id: "session-n1", ticketId: "ticket-n1" });

        // And backs it up: a profile N-1 wrote to round-trips through this
        // build's own bundle and restore.
        const bundle = createBackupBundle({
          db,
          blobsRoot: blobsRoot(root),
          transcriptsRoot: sessionTranscriptsRoot(root),
          appVersion: "head",
          now: NOW,
        });
        const target = join(root, "head-roundtrip");
        mkdirSync(target);
        const restored = await restoreBackupBundle({
          bundle: bundle.bytes,
          profileRoot: target,
          projectPaths: projectPaths(),
          now: NOW,
        });
        expect(restored.ok ? restored.report.schemaVersion : restored.problems).toBe(SCHEMA_HEAD);
        assertHeadReads(join(target, "volli.db"));
        const roundtrip = openVolliDb(join(target, "volli.db"));
        try {
          expect(
            await createSqliteSessionFollowUpLedger(roundtrip).transaction(
              "session-head",
              (state) => state.entries,
            ),
          ).toEqual(queued);
        } finally {
          roundtrip.close();
        }
      } finally {
        db.close();
      }
    });

    it.each(["flat", "questions"] as const)(
      "opens and reattaches a head-recovered %s ask in N−1 without resurrecting a question or inventing an answer",
      async (shape) => {
        await headProfile();
        const { head, guarded } = await probe();
        if (guarded && headFloor() > head) return;
        const sessionId = "session-head";
        const fixture = await recoveredPiQuestion({
          root,
          dbPath,
          sessionId,
          projectId: PROJECT_ID,
          shape,
        });
        const run = await n1(dbPath, [
          {
            kind: "recoveredQuestion",
            sessionId,
            workspace: join(root, "repo"),
            sessionDataDir: fixture.sessionDataDir,
            sidecarPath: fixture.sidecarPath,
            askUserQuestions: shape === "questions",
            transcriptsRoot: sessionTranscriptsRoot(root),
          },
        ]);
        const recovered = value(run, 0);
        expect(recovered).toMatchObject({
          activeCount: 0,
          activeAfter: 0,
          turnActive: false,
          cancellationReason: "abandoned",
          questionTitle: "Which scope should survive?",
          attachStatus: "open",
          deliveryStatus: "accepted",
          turnOpened: 1,
          realAttachCount: 1,
          attachContinuity: "native_resume",
          recoveredSidecar: fixture.sidecarPath,
          providerRequests: 1,
          answers: 0,
          acceptedNextMessages: 1,
        });
        expect(JSON.stringify(recovered.messages)).toContain("Which scope should survive?");
        expect(JSON.stringify(recovered.messages)).toContain("Continue without an answer");
        if (shape === "questions") {
          expect(recovered.questionPrompts).toEqual([
            "Which scope should survive?",
            "When should it ship?",
          ]);
          expect(JSON.stringify(recovered.messages)).toContain("When should it ship?");
        }
        const failedResult = [
          expect.objectContaining({
            toolName: "ask_user",
            isError: true,
            content: [
              {
                type: "text",
                text: "The question was abandoned when the runtime restarted. No answer was obtained.",
              },
            ],
          }),
        ];
        expect(recovered.results).toEqual(failedResult);
        expect(recovered.sidecarResults).toEqual(failedResult);
        expect(JSON.stringify(recovered.results)).not.toContain("Chose:");
        assertHeadReads(dbPath);
        const read = openVolliDb(dbPath);
        try {
          expect(
            await createSqliteSessionFollowUpLedger(read).transaction(
              sessionId,
              (state) => state.entries,
            ),
          ).toMatchObject([{ id: "head-follow-up", state: "queued" }]);
          const events = await headEngine(read).listEvents({ sessionId });
          expect(
            events
              .filter(({ payload }) => payload.kind === "interaction.opened")
              .map(({ payload }) => payload),
          ).toEqual([{ kind: "interaction.opened", interaction: fixture.question }]);
          expect(
            events.filter(({ payload }) => payload.kind === "interaction.cancelled"),
          ).toHaveLength(1);
          expect(
            events.filter(({ payload }) => payload.kind === "interaction.resolved"),
          ).toHaveLength(0);
          expect(events.filter(({ payload }) => payload.kind === "turn.started")).toHaveLength(2);
          expect(
            events.filter(
              ({ payload }) =>
                payload.kind === "command.receipt.recorded" &&
                payload.receipt.commandId === "head-question-message",
            ),
          ).toHaveLength(1);
        } finally {
          read.close();
        }
      },
    );

    it("shows and answers all three head-written ask_user prompts without erasing the birth marker", async () => {
      await headProfile();
      const { head, guarded } = await probe();
      if (guarded && headFloor() > head) return; // N-1 refuses a breaking profile.
      const sessionId = "session-head";
      const attachmentId = "head-pi-attachment";
      const interactionId = askUserInteractionId("n1-multi-question");
      const adapterProvenance = {
        source: { kind: "adapter", id: "pi", detail: null },
        venue: null,
      } as const;
      // The simplified Pi mapping: generated positional ids, single choice,
      // and custom answers on every prompt. Flat fields mirror prompt:0.
      const prompts: readonly SessionInteractionPrompt[] = [
        {
          id: "prompt:0",
          label: "Which storage should I use?",
          detail: null,
          options: [
            { id: "choice:0", label: "SQLite", description: null },
            { id: "choice:1", label: "Postgres", description: null },
          ],
          multiple: false,
          custom: true,
        },
        {
          id: "prompt:1",
          label: "Which checks should I run?",
          detail: null,
          options: [
            { id: "choice:0", label: "Unit tests", description: null },
            { id: "choice:1", label: "Typecheck", description: null },
          ],
          multiple: false,
          custom: true,
        },
        {
          id: "prompt:2",
          label: "What else should I preserve?",
          detail: null,
          options: [],
          multiple: false,
          custom: true,
        },
      ];
      const answers = [
        { promptId: "prompt:0", optionIds: ["choice:0"], response: null },
        { promptId: "prompt:1", optionIds: ["choice:1"], response: "Only focused checks" },
        { promptId: "prompt:2", optionIds: [], response: "Keep existing changes" },
      ];
      const resolution = {
        optionIds: ["choice:0", "choice:1"],
        response: "Only focused checks\n\nKeep existing changes",
        answers,
      };
      const birthInput = {
        kind: "tool-surface",
        tools: ["read", "ask_user"],
        askUserQuestions: true,
      } as const;
      const first = prompts[0]!;
      const interaction = {
        id: interactionId,
        attachmentId,
        kind: "question" as const,
        title: first.label,
        detail: null,
        options: first.options,
        multiple: first.multiple,
        prompts,
        native: {
          id: "head-native-session",
          detail: {
            runtime: "pi",
            sessionId: "head-native-session",
            sessionFilePath: join(root, "head-native-session.jsonl"),
          },
        },
      };
      const writer = openVolliDb(dbPath);
      try {
        const engine = headEngine(writer, "head-ask-user");
        await engine.getOrRecordSessionInput({ sessionId, input: birthInput, provenance });
        await engine.observe({
          id: "head-pi-opened",
          sessionId,
          occurredAt: NOW,
          provenance: adapterProvenance,
          kind: "attachment.opened",
          attachment: {
            id: attachmentId,
            sessionId,
            adapterId: "pi",
            venue: { id: "n1-local", kind: "local" },
            continuity: "fresh",
            native: interaction.native,
            authority: null,
          },
        });
        await engine.observe({
          id: "head-ask-user-opened",
          sessionId,
          occurredAt: NOW,
          provenance: adapterProvenance,
          kind: "interaction.opened",
          interaction,
        });
      } finally {
        writer.close();
      }
      const before = new Database(dbPath, { readonly: true });
      let rawInputs: { payload: string }[];
      try {
        rawInputs = storedInputs(before, sessionId);
        expect(rawInputs.map(({ payload }) => JSON.parse(payload))).toEqual([
          { kind: "session.input.recorded", input: birthInput },
        ]);
      } finally {
        before.close();
      }

      const run = await n1(dbPath, [{ kind: "askUser", sessionId, interactionId, answers }]);
      expect(value(run, 0)).toEqual({
        prompts,
        tools: ["read", "ask_user"],
        rendererNative: { id: null, detail: null },
        // The shipped card holds submit until all questions have an answer.
        submitStates: [false, false, false, true],
        resolution,
        answers,
        activeCount: 0,
        route: { adapterId: "pi", attachmentId },
      });

      assertHeadReads(dbPath);
      const reopened = openVolliDb(dbPath);
      try {
        const engine = headEngine(reopened);
        const session = await engine.getSession({ sessionId });
        expect(session?.interactions.active).toEqual([]);
        const resolved = session?.interactions.resolved[0];
        expect(resolved).toMatchObject({ interaction, resolution });
        expect(readInteractionAnswers(resolved!.interaction, resolved!.resolution)).toEqual(
          answers,
        );
        // N-1 may ignore or understand the marker. Either way, answering must
        // never rewrite the raw birth event (or the declaration would be lost).
        expect(storedInputs(reopened, sessionId)).toEqual(rawInputs!);
        expect(
          await engine.getOrRecordSessionInput({ sessionId, input: birthInput, provenance }),
        ).toEqual(birthInput);
        const events = await engine.listEvents({ sessionId });
        expect(
          events.find(({ payload }) => payload.kind === "interaction.resolved")?.payload,
        ).toEqual({ kind: "interaction.resolved", attachmentId, interactionId, resolution });
      } finally {
        reopened.close();
      }
    });

    it("replays and records an answer to a flat ask left pending by N-1 in a new-birth Session", async () => {
      await headProfile();
      const { head, guarded } = await probe();
      if (guarded && headFloor() > head) return;
      const sessionId = "session-head";
      const interactionId = askUserInteractionId("downgraded-flat");
      const birthInput = {
        kind: "tool-surface",
        tools: ["ask_user"],
        askUserQuestions: true,
      } as const;
      const writer = openVolliDb(dbPath);
      let rawInputs: { payload: string }[];
      try {
        await headEngine(writer, "flat-birth").getOrRecordSessionInput({
          sessionId,
          input: birthInput,
          provenance,
        });
        rawInputs = storedInputs(writer, sessionId);
        expect(rawInputs.map(({ payload }) => JSON.parse(payload))).toEqual([
          { kind: "session.input.recorded", input: birthInput },
        ]);
      } finally {
        writer.close();
      }
      const pending = value(
        await n1(dbPath, [{ kind: "pendingFlatAsk", sessionId, interactionId }]),
        0,
      );
      expect(pending.tools).toEqual(["ask_user"]);
      expect(pending.activeCount).toBe(1);
      const upgraded = openVolliDb(dbPath);
      try {
        expect(storedInputs(upgraded, sessionId)).toEqual(rawInputs!);
        const engine = headEngine(upgraded, "upgraded-flat");
        expect(
          await engine.getOrRecordSessionInput({ sessionId, input: birthInput, provenance }),
        ).toEqual(birthInput);
        const before = await engine.getSession({ sessionId });
        expect(before?.interactions.active).toEqual([pending.interaction]);
        const resolution = {
          optionIds: ["keep"],
          response: "Keep this answer",
          answers: [{ promptId: "prompt:0", optionIds: ["keep"], response: "Keep this answer" }],
        };
        const submitted = await engine.submit({
          commandId: "upgraded-flat-answer",
          sessionId,
          provenance,
          intent: {
            kind: "interaction.resolve",
            attachmentId: "n1-flat-attachment",
            interactionId,
            resolution,
            reference: { id: "upgraded-flat-answer-artifact", mediaType: null, digest: null },
          },
        });
        // The engine persists and routes intent; the adapter's resolution
        // observation below is the durable completion, as in the N-1 lane.
        expect(submitted.receipt).toBeNull();
        expect(submitted.command.route).toEqual({
          adapterId: "pi",
          attachmentId: "n1-flat-attachment",
        });
        await engine.observe({
          id: "upgraded-flat-resolved",
          sessionId,
          occurredAt: NOW,
          provenance: { source: { kind: "adapter", id: "pi", detail: null }, venue: null },
          kind: "interaction.resolved",
          attachmentId: "n1-flat-attachment",
          interactionId,
          resolution,
        });
        const after = await engine.getSession({ sessionId });
        expect(after?.interactions.active).toEqual([]);
        expect(after?.interactions.resolved[0]).toMatchObject({
          interaction: pending.interaction,
          resolution,
        });
        expect(storedInputs(upgraded, sessionId)).toEqual(rawInputs!);
      } finally {
        upgraded.close();
      }
    });

    it.each(["both", "only"] as const)(
      "attaches a descriptionVersion:2 Code Mode %s birth in N−1 without losing newly callable tools",
      async (mode) => {
        await headProfile();
        const { head, guarded } = await probe();
        if (guarded && headFloor() > head) return; // The refusal test owns a raised floor.
        const codeMode = codeModeSurfaceFor({ tools: CODE_MODE_TOOLS, mode });
        expect(codeMode.descriptionVersion).toBe(2);
        for (const tool of NEW_CODE_CALLABLE) expect(codeMode.routes[tool], tool).toBe("both");
        const db = openVolliDb(dbPath);
        try {
          await headEngine(db, "code-mode-birth").getOrRecordSessionInput({
            sessionId: "session-head",
            input: { kind: "tool-surface", tools: CODE_MODE_TOOLS, codeMode },
            provenance,
          });
        } finally {
          db.close();
        }
        const run = await n1(
          dbPath,
          [{ kind: "attach", sessionId: "session-head", workspace: join(root, "repo") }],
          CODE_MODE_CHILD,
        );
        const attached = value(run, 0);
        expect(attached.tools).toEqual(CODE_MODE_TOOLS);
        expect(attached.routes).toEqual(codeMode.routes);
        expect(attached.bound).toEqual(CODE_MODE_TOOLS.filter((tool) => tool !== "codemode"));
        const declared = CODE_MODE_TOOLS.filter(
          (tool) =>
            tool === "codemode" ||
            codeMode.routes[tool] === "direct" ||
            codeMode.routes[tool] === "both",
        ).map((tool) =>
          tool === "execute"
            ? "bash"
            : CODE_MODE_VERBS.includes(tool as (typeof CODE_MODE_VERBS)[number])
              ? verbToolWireName(tool as (typeof CODE_MODE_VERBS)[number])
              : tool,
        );
        expect(attached.declared).toEqual(declared);
        // Whether N-1 can call these from a program or not, every tool must
        // remain directly declared: no lost tools on downgrade.
        for (const tool of NEW_CODE_CALLABLE) {
          expect(attached.declared).toContain(
            tool === "browser_screenshot" ||
              tool === "browser_acquire" ||
              tool === "browser_release"
              ? tool
              : verbToolWireName(tool),
          );
        }
        assertHeadReads(dbPath);
      },
    );

    it("replays Code Mode successful and failed picture references in N−1 with identical artifact hashes and named fallback text", async () => {
      const { markers, artifacts } = await durableCodeModePictures();
      const run = await n1(
        dbPath,
        [{ kind: "replay", markers, translation: CODE_MODE_TRANSLATION }],
        CODE_MODE_CHILD,
      );
      // Deep equality covers picture ids, null omitted pictures, explicit
      // fallback text, errorText, the failed input facet, part order and ids;
      // digest equality proves N−1 will not insert a conflicting transcript.
      expect(value(run, 0).artifacts).toEqual(artifacts);
    });

    it("reattaches HEAD's moved bash sidecar in N−1 and shows the moved receipt in model history (VC-757)", async () => {
      await headProfile();
      const { head, guarded } = await probe();
      if (guarded && headFloor() > head) return;
      // HEAD runs a real bash child, moves it while it runs, and writes the Pi sidecar.
      const moved = await movedPiBash({
        root,
        dbPath,
        sessionId: "session-head",
        projectId: PROJECT_ID,
        ticketId: "ticket-head",
        workspace: join(root, "repo"),
      });
      const receipt = `Moved command to background shell ${moved.shellId}`;
      // N-1's own Pi adapter reattaches that very sidecar; its provider sees the receipt.
      const reattached = value(
        await n1(dbPath, [
          {
            kind: "movedBash",
            sessionId: "session-head",
            workspace: join(root, "repo"),
            sessionDataDir: moved.sessionDataDir,
            transcriptsRoot: sessionTranscriptsRoot(root),
          },
        ]),
        0,
      );
      // Behavior, never an exact decoded shape: future latest-canary/base may include this feature.
      expect(reattached).toMatchObject({
        attachStatus: "open",
        deliveryStatus: "accepted",
        realAttachCount: 1,
        attachContinuity: "native_resume",
        recoveredSidecar: moved.sessionFilePath,
        providerRequests: 1,
        turnActive: false,
        acceptedNextMessages: 1,
      });
      expect(reattached.frozenTools).toEqual(MOVED_BASH_TOOLS);
      expect(reattached.movedResults).toEqual([expect.objectContaining({ isError: false })]);
      expect(JSON.stringify(reattached.movedResults)).toContain(receipt);
      expect(JSON.stringify(reattached.movedResults)).toContain("before");
      expect(JSON.stringify(reattached.messages)).not.toContain("Command timed out");
      // The turn went on past the moved call, and HEAD's continuation is in the same history.
      expect(JSON.stringify(reattached.messages)).toContain("The turn continued.");

      // N-1's artifact reader replays the same head-written transcript frames, and
      // reattaching left them intact.
      const replayed = value(
        await n1(dbPath, [
          {
            kind: "bashReplay",
            sessionId: "session-head",
            transcriptsRoot: sessionTranscriptsRoot(root),
          },
        ]),
        0,
      );
      expect(replayed).toMatchObject({
        sessionId: "session-head",
        nativeToolName: "bash",
        state: "output-available",
      });
      expect(replayed.frames).toBeGreaterThan(0);
      expect(replayed.text).toContain(receipt);
      assertHeadReads(dbPath);
    });

    it("makes a backup bundle of a head profile that both builds restore", async () => {
      await headProfile();
      const { head, guarded } = await probe();
      if (guarded && headFloor() > head) return; // N-1 refuses the profile.
      const bundlePath = join(root, "n1.volli-backup");
      const run = await n1(dbPath, [{ kind: "bundle", profileRoot: root, out: bundlePath }]);
      value(run, 0);
      const read = readBackupBundle(readFileSync(bundlePath));
      if (hazards.bundle !== undefined) {
        expect(read.ok ? "readable" : read.problems.map((problem) => problem.message)).toEqual(
          hazards.bundle,
        );
        return;
      }
      expect(read.ok ? "readable" : read.problems).toBe("readable");
      // Stamped with the schema its tables describe: never above N-1's head.
      expect(value(run, 0)).toEqual({ schemaVersion: head });

      // N-1 restores its own bundle into an empty profile.
      const n1Target = join(root, "n1-target");
      mkdirSync(n1Target);
      const restored = await n1(join(n1Target, "volli.db"), [
        {
          kind: "restore",
          profileRoot: n1Target,
          bundle: bundlePath,
          projectPaths: projectPaths(),
        },
      ]);
      expect(value(restored, 0)).toMatchObject({ restored: true });

      // So does this build, migrating it up to head on the way in.
      const headTarget = join(root, "head-target");
      mkdirSync(headTarget);
      const ours = await restoreBackupBundle({
        bundle: readFileSync(bundlePath),
        profileRoot: headTarget,
        projectPaths: projectPaths(),
        now: NOW,
      });
      expect(ours.ok ? ours.report.schemaVersion : ours.problems).toBe(SCHEMA_HEAD);
      assertHeadReads(join(headTarget, "volli.db"));
    });

    it("refuses a profile whose floor is above its head, leaving db and WAL byte-identical", async () => {
      await headProfile();
      const { head, guarded } = await probe();
      // The release policy test owns the unguarded case.
      if (!guarded) return;
      // A future migration that raises the floor above N-1, committed to the
      // WAL and never checkpointed.
      const newer = Math.max(SCHEMA_HEAD, head) + 1;
      const image = join(root, "raised.db");
      crashImage(image, (db) => {
        db.prepare(
          `INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        ).run(MIN_READER_VERSION_KEY, String(newer), NOW);
        db.pragma(`user_version = ${newer}`);
      });
      await expectRefusal(image, newer);
      const check = new Database(image, { readonly: true });
      try {
        expect(check.pragma("user_version", { simple: true })).toBe(newer);
        expect(readMinReaderVersion(check)).toBe(newer);
      } finally {
        check.close();
      }
    });
  },
);
