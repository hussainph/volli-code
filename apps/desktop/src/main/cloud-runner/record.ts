/**
 * What this Mac remembers about its runners outside the sealed store: one
 * non-secret `app_state` row, {@link CLOUD_RUNNER_APP_STATE_KEY}, holding per
 * person the runner's id, the machine it was written on, a registration still
 * waiting for its answer, and a tombstone once the runner was removed or cut
 * off. Never a credential.
 *
 * It outlives the sealed link on purpose: a Mac that lost its keychain item
 * still knows which runner it was, and registers as its replacement instead
 * of as a duplicate; a Mac whose runner was removed still knows not to add
 * itself back. A row that cannot be read or written (a degraded database) is
 * logged and reads as nothing remembered.
 */
import { readId } from "@volli/shared/cloud";
import { THIS_MAC_RUNNER_PROBLEMS, type ThisMacRunnerProblem } from "@volli/shared";

import type { MacRunnerRecord, MacRunnerRecordStore } from "./mac-runner";

/** The `app_state` key (registered in `@volli/shared`'s app-state keys). */
export const CLOUD_RUNNER_APP_STATE_KEY = "volli:cloud-runner";

const RECORD_VERSION = 1;

type Records = Record<string, MacRunnerRecord>;

function readRecord(value: unknown): MacRunnerRecord | null {
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const runnerId = record["runnerId"] === null ? null : readId("runner", record["runnerId"]);
  const { machine, tombstone } = record;
  if ((runnerId === null && record["runnerId"] !== null) || typeof machine !== "string")
    return null;
  const registrationId =
    typeof record["registrationId"] === "string" ? record["registrationId"] : null;
  return {
    runnerId,
    machine,
    registrationId,
    tombstone:
      tombstone === null
        ? null
        : (THIS_MAC_RUNNER_PROBLEMS as readonly unknown[]).includes(tombstone)
          ? (tombstone as ThisMacRunnerProblem)
          : // A tombstone this build cannot name is still a tombstone.
            "removed",
  };
}

/** Every person's record in a stored row; anything unreadable reads as none. */
export function decodeRunnerRecords(raw: string | undefined): Records {
  if (raw === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== "object") return {};
  const { v, accounts } = parsed as { v?: unknown; accounts?: unknown };
  if (v !== RECORD_VERSION || accounts === null || typeof accounts !== "object") return {};
  const records: Records = {};
  for (const [userId, value] of Object.entries(accounts)) {
    const record = readRecord(value);
    if (record !== null) records[userId] = record;
  }
  return records;
}

export function encodeRunnerRecords(records: Records): string {
  return JSON.stringify({ v: RECORD_VERSION, accounts: records });
}

/** The row as main reaches it. */
export interface RunnerRecordRow {
  read(): string | undefined;
  write(value: string): void;
}

export function runnerRecordStore(
  row: () => RunnerRecordRow | null,
  userId: string,
  log: { warn(message: string, fields?: Record<string, unknown>): void },
): MacRunnerRecordStore {
  return {
    read() {
      try {
        return decodeRunnerRecords(row()?.read())[userId] ?? null;
      } catch (error) {
        log.warn("could not read this Mac's runner record", { error });
        return null;
      }
    },
    write(record) {
      try {
        const live = row();
        if (live === null) return;
        const records = decodeRunnerRecords(live.read());
        records[userId] = record;
        live.write(encodeRunnerRecords(records));
      } catch (error) {
        log.warn("could not write this Mac's runner record", { error });
      }
    },
  };
}
