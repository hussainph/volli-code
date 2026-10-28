/** Daily local backups. All profile reads/compression/verification run in a worker.
 * Only successful, service-owned bundles participate in retention. Failed and
 * move-created bundles are deliberately outside that deletion namespace.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProfileBackupStatus } from "@volli/shared";
import { hostLogger } from "../log/root";

const log = hostLogger("profile-backups");

const DAY = 86_400_000;
const RETRY = 60 * 60_000;
const OWN_BUNDLE = /^auto-\d{13}-[a-f0-9-]{36}\.tar\.gz$/;
export const BACKUPS_DIRECTORY = "backups";

export interface AutomaticBackupRecord {
  fileName: string;
  createdAt: number;
  sizeBytes: number;
  verified: true;
  kept?: boolean;
}

/** Seven most recent daily snapshots, plus the latest completed UTC week's snapshot. */
export function retainedAutomaticBackups(
  records: readonly AutomaticBackupRecord[],
  now: number,
): Set<string> {
  const sorted = records.toSorted((a, b) => b.createdAt - a.createdAt);
  const days = new Set<string>();
  const keep = new Set<string>();
  for (const record of sorted) {
    const day = new Date(record.createdAt).toISOString().slice(0, 10);
    if (!days.has(day) && days.size < 7) {
      days.add(day);
      keep.add(record.fileName);
    }
    if (record.kept) keep.add(record.fileName);
  }
  const date = new Date(now);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  const weekly = sorted.find((record) => record.createdAt < date.getTime());
  if (weekly) keep.add(weekly.fileName);
  return keep;
}

/** Rotation never trusts a bare filename: it requires the writer's verified receipt. */
export async function rotateAutomaticBackups(directory: string, now: number): Promise<void> {
  const records: AutomaticBackupRecord[] = [];
  for (const fileName of await readdir(directory)) {
    if (!OWN_BUNDLE.test(fileName)) continue;
    try {
      const value: unknown = JSON.parse(
        await readFile(join(directory, `${fileName}.json`), "utf8"),
      );
      if (
        isRecord(value) &&
        value.fileName === fileName &&
        value.verified === true &&
        typeof value.createdAt === "number" &&
        Number.isFinite(value.createdAt) &&
        typeof value.sizeBytes === "number" &&
        value.sizeBytes > 0 &&
        (await stat(join(directory, fileName))).size === value.sizeBytes
      ) {
        records.push(value as unknown as AutomaticBackupRecord);
      }
    } catch {
      /* Unknown, incomplete, or unreadable receipts are never deletion authority. */
    }
  }
  const keep = retainedAutomaticBackups(records, now);
  for (const record of records) {
    if (keep.has(record.fileName)) continue;
    const path = join(directory, record.fileName);
    // A move may mark an automatic bundle kept after the scan. Re-read at deletion.
    try {
      await stat(`${path}.kept`);
      continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") continue;
    }
    const receipt = JSON.parse(await readFile(`${path}.json`, "utf8")) as AutomaticBackupRecord;
    if (receipt.kept) continue;
    await rm(path);
    await rm(`${path}.json`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface AutomaticBackupOptions {
  dataDir: string;
  run(
    outputPath: string,
    signal: AbortSignal,
    onNotice: (notice: string | null) => void,
  ): Promise<{ sizeBytes: number }>;
  reveal(directory: string): Promise<void>;
  now?: () => number;
}

/** One scheduler per app launch, not per window or cloud connection. */
export class AutomaticProfileBackups {
  readonly #directory: string;
  readonly #options: AutomaticBackupOptions;
  #status: ProfileBackupStatus = { running: false, lastBackup: null, notice: null };
  #lastAttempt = 0;
  #timer: ReturnType<typeof setInterval> | undefined;
  #flight: Promise<ProfileBackupStatus> | undefined;
  #stopped = false;
  #abort = new AbortController();
  #loaded: Promise<void>;

  constructor(options: AutomaticBackupOptions) {
    this.#options = options;
    this.#directory = join(options.dataDir, BACKUPS_DIRECTORY);
    this.#loaded = this.#load();
  }

  async #load(): Promise<void> {
    try {
      const value: unknown = JSON.parse(
        await readFile(join(this.#directory, "automatic-state.json"), "utf8"),
      );
      if (!isRecord(value)) throw new Error("Invalid backup state");
      const last = value.lastBackup;
      if (
        isRecord(last) &&
        typeof last.createdAt === "number" &&
        typeof last.sizeBytes === "number"
      ) {
        this.#status.lastBackup = { createdAt: last.createdAt, sizeBytes: last.sizeBytes };
      }
      if (typeof value.notice === "string") this.#status.notice = value.notice;
      if (typeof value.lastAttempt === "number") this.#lastAttempt = value.lastAttempt;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        this.#status.notice = "Backup history could not be read. Back up now to try again.";
    }
  }

  async status(): Promise<ProfileBackupStatus> {
    await this.#loaded;
    return { ...this.#status };
  }

  start(): void {
    if (this.#timer || this.#stopped) return;
    this.#timer = setInterval(() => {
      void this.tick();
    }, 60_000);
    this.#timer.unref();
    void this.tick();
  }

  async tick(): Promise<void> {
    await this.#loaded;
    const now = this.#now();
    if (
      this.#stopped ||
      this.#flight ||
      (this.#status.lastBackup !== null && now - this.#status.lastBackup.createdAt < DAY) ||
      (this.#lastAttempt !== 0 && now - this.#lastAttempt < RETRY)
    )
      return;
    await this.run();
  }

  run(): Promise<ProfileBackupStatus> {
    if (this.#flight) return this.#flight;
    if (this.#stopped) return Promise.reject(new Error("Volli is closing."));
    this.#flight = this.#run().finally(() => {
      this.#flight = undefined;
    });
    return this.#flight;
  }

  async #run(): Promise<ProfileBackupStatus> {
    await this.#loaded;
    const createdAt = this.#now();
    this.#lastAttempt = createdAt;
    this.#status.running = true;
    const fileName = `auto-${createdAt}-${randomUUID()}.tar.gz`;
    const path = join(this.#directory, fileName);
    try {
      await mkdir(this.#directory, { recursive: true, mode: 0o700 });
      const { sizeBytes } = await this.#options.run(path, this.#abort.signal, (notice) => {
        this.#status.notice = notice;
      });
      const record: AutomaticBackupRecord = { fileName, createdAt, sizeBytes, verified: true };
      await writeFile(`${path}.json`, JSON.stringify(record), { flag: "wx", mode: 0o600 });
      this.#status.lastBackup = { createdAt, sizeBytes };
      this.#status.notice = null;
      try {
        await rotateAutomaticBackups(this.#directory, createdAt);
      } catch (error) {
        log.warn("backup rotation failed", { error });
        this.#status.notice =
          "Backup saved, but older backups could not be rotated. Check disk space and try Back up now.";
      }
    } catch (error) {
      log.warn("local profile backup failed", { error });
      this.#status.notice =
        error instanceof Error && error.message.startsWith("Backup")
          ? error.message
          : "The local backup could not be completed. Check disk space and try Back up now.";
    } finally {
      this.#status.running = false;
      try {
        const target = join(this.#directory, "automatic-state.json");
        await writeFile(
          `${target}.tmp`,
          JSON.stringify({ ...this.#status, lastAttempt: this.#lastAttempt }),
          { mode: 0o600 },
        );
        await rename(`${target}.tmp`, target);
      } catch {
        this.#status.notice =
          "Backup history could not be saved. Check available disk space and try again.";
      }
    }
    return this.status();
  }

  async reveal(): Promise<void> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    await this.#options.reveal(this.#directory);
  }

  stop(): void {
    this.#stopped = true;
    clearInterval(this.#timer);
    this.#abort.abort();
  }

  #now(): number {
    return (this.#options.now ?? Date.now)();
  }
}
