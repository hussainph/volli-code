import type Database from "better-sqlite3";
import {
  parseExperimentEnvironment,
  readStoredExperiments,
  requireExperimentId,
  resolveExperiments,
  serializeExperimentUpdate,
  type ExperimentId,
  type ExperimentSnapshot,
  type ExperimentValues,
} from "@volli/shared";

import { getAppState, setAppState, withTransaction } from "@volli/host-core/db";
import { hostLogger } from "@volli/host-core/log";

const log = hostLogger("experiments");

/** Host-level settings, not workspace data; classification lives beside the registry. */
export const EXPERIMENTS_APP_STATE_KEY = "volli:experimental-flags";

/**
 * No Electron dependency: a future hostd can own this same settings service.
 * Boot performs one small row read. Readers use committed memory so a Session
 * transaction cannot expose provisional settings; writers publish after COMMIT.
 */
export class ExperimentalSettings {
  readonly #environment: readonly ExperimentId[];
  #stored: Partial<ExperimentValues>;

  constructor(
    private readonly db: Database.Database | null,
    environment: string | undefined,
    private readonly now: () => number = Date.now,
  ) {
    const parsed = parseExperimentEnvironment(environment);
    this.#environment = parsed.ids;
    if (parsed.unknownIds.length > 0) {
      log.warn("ignoring unknown VOLLI_EXPERIMENTAL ids", { ids: parsed.unknownIds });
    }
    this.#stored = readStoredExperiments(
      db === null ? undefined : getAppState(db, EXPERIMENTS_APP_STATE_KEY),
    );
  }

  snapshot(): ExperimentSnapshot {
    return resolveExperiments(this.#stored, this.#environment);
  }

  isEnabled(id: ExperimentId): boolean {
    return this.snapshot()[requireExperimentId(id)].enabled;
  }

  /** One semantic write, never a renderer-owned raw app_state write. */
  async set(id: ExperimentId, enabled: boolean): Promise<ExperimentSnapshot> {
    requireExperimentId(id);
    if (typeof enabled !== "boolean") throw new Error("Experiment enabled must be a boolean");
    if (this.#environment.includes(id)) throw new Error("Experiment is set by environment");
    const db = this.db;
    if (db === null) throw new Error("Experimental settings storage is unavailable");
    const stored = withTransaction(db, () => {
      const raw = serializeExperimentUpdate(
        getAppState(db, EXPERIMENTS_APP_STATE_KEY),
        id,
        enabled,
      );
      setAppState(db, EXPERIMENTS_APP_STATE_KEY, raw, this.now());
      return readStoredExperiments(raw);
    });
    this.#stored = stored;
    return this.snapshot();
  }
}

let current = new ExperimentalSettings(null, undefined);

/** Bind once at the composition root, after the database opens and before feature consumers. */
export function installExperimentalSettings(settings: ExperimentalSettings): () => void {
  const previous = current;
  current = settings;
  return () => {
    current = previous;
  };
}

/** The main/host reader later cloud tickets call. Unknown ids fail even from untyped code. */
export function isExperimentEnabled(id: ExperimentId): boolean {
  return current.isEnabled(id);
}

/** Settings projection: the effective value plus its provenance, never the storage blob. */
export function readExperiments(): ExperimentSnapshot {
  return current.snapshot();
}

/** Host command implementation, exposed through settings.setExperiment in session-rpc. */
export function setExperiment(id: ExperimentId, enabled: boolean): Promise<ExperimentSnapshot> {
  return current.set(id, enabled);
}
