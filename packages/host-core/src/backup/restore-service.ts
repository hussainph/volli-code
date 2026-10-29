/** Local Storage restore orchestration. Every expensive read runs in a worker. */
import { hasPendingDatabaseRecovery } from "../db/database-file";
import { errorMessage } from "@volli/shared";
import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { lstat, readFile, readdir, rm, stat, open } from "node:fs/promises";
import type { ProfileRestoreBundle, ProfileRestoreStatus } from "@volli/shared";
import { runRestoreWorker } from "./restore-worker";
import {
  acceptPreparedBackupRestore,
  discardPreparedBackupRestore,
  cancelScheduledBackupRestore,
  scheduleBackupRestore,
} from "./restore-schedule";
import { withProfileMaintenance, profileOwnerAlive } from "./profile-maintenance";

export interface ProfileRestorePort {
  status(): Promise<ProfileRestoreStatus>;
  choose(fileName?: string): Promise<ProfileRestoreStatus>;
  directory(): Promise<string | null>;
  start(
    expectedRevision: string,
    projectPaths: Record<string, string>,
  ): Promise<ProfileRestoreStatus>;
  cancel(expectedRevision: string): Promise<ProfileRestoreStatus>;
  restart(expectedRevision: string): Promise<void>;
  revealPrevious(): Promise<void>;
}

interface RestoreOptions {
  root: string;
  workerEntry: string | URL;
  pickBundle(): Promise<string | null>;
  pickDirectory(): Promise<string | null>;
  localProjects(): { id: string; name: string; path: string }[];
  restart(): boolean;
  revealPrevious(path: string): void;
  /** Restore is local-only, with database and artifacts under one profile root. */
  available(): boolean;
  workerExecArgv?: string[];
}
export class ProfileRestoreService implements ProfileRestorePort {
  #state: ProfileRestoreStatus = {
    revision: randomUUID(),
    phase: "idle",
    bundles: [],
    selectedFile: null,
    projects: [],
    checkpoints: 0,
    paused: false,
    problems: [],
    credentialsMessage: null,
    previousProfile: null,
  };
  #bundlePath: string | null = null;
  #dataSha256: string | undefined;
  #flight: Promise<void> | undefined;
  #abort = new AbortController();
  #stopped = false;
  #cancelling = false;
  #restartRequested = false;
  #loaded: Promise<void>;
  constructor(private readonly options: RestoreOptions) {
    this.#loaded = this.#recoverAttempt().catch((error: unknown) =>
      this.#fail([{ kind: "interrupted", message: errorMessage(error) }]),
    );
  }
  async #recoverAttempt(): Promise<void> {
    if (hasPendingDatabaseRecovery(join(this.options.root, "volli.db"))) return;
    const attempt = join(this.options.root, ".volli-restore-attempt.json");
    for (const name of await readdir(this.options.root)) {
      const match = /^\.volli-inspect-(\d+)-[a-f0-9-]{36}$/.exec(name);
      if (match && !profileOwnerAlive(Number(match[1])))
        await rm(join(this.options.root, name), { recursive: true, force: true });
    }
    if (await discardPreparedBackupRestore(this.options.root))
      this.#fail([
        {
          kind: "cancelled",
          message:
            "The prepared restore was not scheduled. The current profile is unchanged. Choose a backup to try again.",
        },
      ]);
    try {
      const value: unknown = JSON.parse(await readFile(attempt, "utf8"));
      const record = value as { now?: unknown; pid?: unknown } | null;
      if (
        !record ||
        !Number.isSafeInteger(record.now) ||
        Number(record.now) < 0 ||
        !Number.isSafeInteger(record.pid) ||
        Number(record.pid) < 1
      )
        throw new Error(
          "The interrupted restore record is unreadable. The current profile is unchanged.",
        );
      if (profileOwnerAlive(Number(record.pid)))
        throw new Error("Another restore is still preparing this profile.");
      await rm(join(this.options.root, `.volli-restore-${record.now}`), {
        recursive: true,
        force: true,
      });
      await rm(attempt);
      this.#fail([
        {
          kind: "interrupted",
          message:
            "The previous restore was interrupted. The current profile is unchanged. Choose a backup to try again.",
        },
      ]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  #assertAvailable(): void {
    if (this.#stopped) throw new Error("Volli is closing.");
    if (!this.options.available())
      throw new Error(
        "Restart in local mode to restore a backup. A restore requires the default local profile directory.",
      );
  }
  #busy(): boolean {
    return (
      this.#cancelling ||
      !!this.#flight ||
      this.#state.phase === "ready" ||
      this.#state.phase === "restarting"
    );
  }
  async status(): Promise<ProfileRestoreStatus> {
    this.#assertAvailable();
    await this.#loaded;
    this.#state.bundles = await listRestoreBundles(this.options.root);
    if (this.#state.phase !== "ready" && this.#state.phase !== "restarting") {
      const previous = (await readdir(this.options.root))
        .filter((name) => /^\.volli-replaced-\d+$/.test(name))
        .toSorted()
        .at(-1);
      this.#state.previousProfile = previous ? join(this.options.root, previous) : null;
    }
    return structuredClone(this.#state);
  }
  async choose(fileName?: string): Promise<ProfileRestoreStatus> {
    this.#assertAvailable();
    await this.#loaded;
    if (this.#busy()) throw new Error("Cancel the current restore before choosing another backup.");
    let path: string | null;
    if (fileName !== undefined) {
      if (
        basename(fileName) !== fileName ||
        !(await listRestoreBundles(this.options.root)).some((item) => item.fileName === fileName)
      )
        throw new Error("This backup is no longer listed. Refresh and try again.");
      path = join(this.options.root, "backups", fileName);
    } else path = await this.options.pickBundle();
    if (!path) return this.status();
    // The native picker may have been open while another window accepted a job.
    if (this.#busy()) throw new Error("Another restore is already in progress.");
    this.#bundlePath = path;
    this.#state = {
      ...this.#state,
      revision: randomUUID(),
      phase: "checking",
      selectedFile: basename(path),
      projects: [],
      checkpoints: 0,
      paused: false,
      problems: [],
      credentialsMessage: null,
      previousProfile: null,
    };
    this.#launch(async () => {
      const result = await this.#worker({
        kind: "inspect",
        root: this.options.root,
        bundlePath: path,
      });
      if (!result.ok) {
        this.#fail(result.problems);
        return;
      }
      if (!("projects" in result)) throw new Error("Restore inspection returned no projects.");
      this.#dataSha256 = result.dataSha256;
      const local = this.options.localProjects();
      const projects = [];
      for (const project of result.projects) {
        const match = local.find((item) => item.id === project.id && item.name === project.name);
        let directory: string | null = null;
        if (match) {
          try {
            if ((await stat(match.path)).isDirectory()) directory = match.path;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
        projects.push({ ...project, directory });
      }
      this.#state.projects = projects;
      this.#state.phase = "mapping";
    });
    return this.status();
  }
  async directory(): Promise<string | null> {
    this.#assertAvailable();
    return this.options.pickDirectory();
  }
  async start(
    expectedRevision: string,
    projectPaths: Record<string, string>,
  ): Promise<ProfileRestoreStatus> {
    this.#assertAvailable();
    if (expectedRevision !== this.#state.revision) return this.status();
    if (this.#cancelling || this.#flight || this.#state.phase !== "mapping" || !this.#bundlePath)
      throw new Error("Choose and verify a backup first.");
    const bundlePath = this.#bundlePath;
    this.#state.revision = randomUUID();
    this.#state.phase = "staging";
    this.#state.checkpoints = 0;
    this.#launch(() =>
      withProfileMaintenance(this.options.root, async () => {
        const now = Date.now();
        const attempt = join(this.options.root, ".volli-restore-attempt.json");
        const file = await open(attempt, "wx", 0o600);
        try {
          await file.writeFile(JSON.stringify({ now, pid: process.pid }));
          await file.sync();
        } finally {
          await file.close();
        }
        try {
          const result = await this.#worker({
            kind: "stage",
            root: this.options.root,
            bundlePath,
            projectPaths,
            now,
            expectedDataSha256: this.#dataSha256,
          });
          if (!result.ok) {
            this.#fail(result.problems);
            return;
          }
          if (!("report" in result) || !result.report.stagedPath)
            throw new Error("Restore did not prepare a profile.");
          try {
            this.#abort.signal.throwIfAborted();
            await scheduleBackupRestore(this.options.root, result.report);
            if (this.#abort.signal.aborted) {
              await cancelScheduledBackupRestore(this.options.root);
              this.#abort.signal.throwIfAborted();
            }
          } catch (error) {
            await cancelScheduledBackupRestore(this.options.root);
            await rm(result.report.stagedPath, { recursive: true, force: true });
            throw error;
          }
          this.#state.credentialsMessage = result.report.credentials.message;
          this.#state.previousProfile = result.report.replacedPath;
          this.#state.phase = "ready";
        } finally {
          await rm(attempt, { force: true });
        }
      }),
    );
    return this.status();
  }
  async cancel(expectedRevision: string): Promise<ProfileRestoreStatus> {
    this.#assertAvailable();
    if (expectedRevision !== this.#state.revision) return this.status();
    if (this.#state.phase === "restarting")
      throw new Error("The restore restart is already in progress.");
    if (this.#cancelling) return this.status();
    this.#cancelling = true;
    try {
      this.#abort.abort();
      await this.#flight;
      if (this.#state.phase === "ready") await cancelScheduledBackupRestore(this.options.root);
      this.#state.phase = "cancelled";
      this.#state.revision = randomUUID();
      return await this.status();
    } finally {
      this.#cancelling = false;
    }
  }
  async restart(expectedRevision: string): Promise<void> {
    this.#assertAvailable();
    if (expectedRevision === this.#state.revision && this.#state.phase === "restarting") return;
    if (
      this.#cancelling ||
      expectedRevision !== this.#state.revision ||
      this.#state.phase !== "ready"
    )
      throw new Error("No verified restore is ready. Refresh and try again.");
    this.#restartRequested = true;
    this.#state.phase = "restarting";
    if (!this.options.restart()) this.restartRefused();
  }
  async revealPrevious(): Promise<void> {
    const state = await this.status();
    if (
      !state.previousProfile ||
      !/^\.volli-replaced-\d+$/.test(basename(state.previousProfile)) ||
      !(await lstat(state.previousProfile)).isDirectory()
    )
      throw new Error("No previous profile is available to reveal.");
    this.options.revealPrevious(state.previousProfile);
  }
  /** The Electron restart lifecycle calls this only after quit gates accept. */
  acceptRestart(): void {
    if (!this.#restartRequested) return;
    acceptPreparedBackupRestore(this.options.root);
    this.#restartRequested = false;
  }
  restartRefused(): void {
    if (this.#state.phase === "restarting") this.#state.phase = "ready";
    this.#restartRequested = false;
  }
  stop(): void {
    this.#stopped = true;
    this.#abort.abort();
  }
  async settled(): Promise<void> {
    await this.#flight;
  }
  #worker(request: Parameters<typeof runRestoreWorker>[1]) {
    return runRestoreWorker(
      this.options.workerEntry,
      request,
      this.#abort.signal,
      (count, paused) => {
        this.#state.checkpoints = count;
        this.#state.paused = paused;
      },
      this.options.workerExecArgv,
    );
  }
  #fail(problems: ProfileRestoreStatus["problems"]): void {
    this.#state.phase = "failed";
    this.#state.problems = problems;
  }
  #launch(work: () => Promise<void>): void {
    this.#abort = new AbortController();
    this.#flight = work()
      .catch((error: unknown) => {
        if (this.#abort.signal.aborted) this.#state.phase = "cancelled";
        else this.#fail([{ kind: "restore", message: errorMessage(error) }]);
      })
      .finally(() => {
        this.#flight = undefined;
      });
  }
}
export async function listRestoreBundles(root: string): Promise<ProfileRestoreBundle[]> {
  const directory = join(root, "backups");
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const result: ProfileRestoreBundle[] = [];
  for (const fileName of names) {
    if (!/\.tar\.gz(?:\.failed)?$/.test(fileName)) continue;
    const path = join(directory, fileName);
    let info;
    try {
      info = await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (!info.isFile()) continue;
    let verification: ProfileRestoreBundle["verification"] = fileName.endsWith(".failed")
      ? "failed"
      : "unknown";
    let createdAt = info.mtimeMs;
    let keptForMove = names.includes(`${fileName}.kept`);
    try {
      const record = JSON.parse(await readFile(`${path}.json`, "utf8")) as Record<string, unknown>;
      if (record.fileName === fileName && record.sizeBytes === info.size) {
        if (record.verified === true) verification = "verified";
        if (record.verified === false) verification = "failed";
        if (typeof record.createdAt === "number" && Number.isFinite(record.createdAt))
          createdAt = record.createdAt;
        keptForMove ||= record.kept === true;
      }
    } catch {
      /* Missing/unreadable receipt is unknown, never a verification claim. */
    }
    // Move's kept marker is published only after the writer verifies the file.
    if (keptForMove && fileName.startsWith("pre-cloud-move-") && verification === "unknown")
      verification = "verified";
    result.push({ fileName, createdAt, sizeBytes: info.size, verification, keptForMove });
  }
  return result.toSorted((a, b) => b.createdAt - a.createdAt);
}
