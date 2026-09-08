import { existsSync } from "node:fs";
import { compactNativeObservationEventId, createSessionEngine } from "@volli/session-engine";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  createFixtureProfile,
  FIXTURE_NATIVE_RECEIPT_EVENT_ID,
  FIXTURE_NATIVE_USAGE_EVENT_ID,
  type FixtureProfile,
} from "../backup/test-fixture";
import { SqliteSessionLedger } from "../session-control/sqlite-ledger";
import { migrate } from "./migrations";
import { computeSessionStorageContentDigest } from "./session-storage-digest";

const RECEIPT_EVENT_ID = FIXTURE_NATIVE_RECEIPT_EVENT_ID;
const USAGE_EVENT_ID = FIXTURE_NATIVE_USAGE_EVENT_ID;

let fixture: FixtureProfile | undefined;

afterEach(() => {
  fixture?.cleanup();
  fixture = undefined;
});

function v41Fixture(options: { nativeEventIds?: boolean } = {}): FixtureProfile {
  fixture = createFixtureProfile({ schemaVersion: 41, ...options });
  return fixture;
}

function installNativeUsageProjection(profile: FixtureProfile): void {
  profile.db
    .prepare(
      `INSERT INTO session_usage
        (event_id, session_id, project_id, ticket_id, occurred_at, cause,
         provider_id, model_id, input_tokens, output_tokens,
         cache_read_tokens, cache_write_tokens, cost_usd, cost_basis)
       VALUES (?, 'session-root', 'proj-alpha', 'ticket-live', 254, 'assistant',
               'anthropic', 'claude-opus-4-1', 100, 20, 400, 0, 0.25, 'catalog-estimate')`,
    )
    .run(USAGE_EVENT_ID);
}

function withoutId<T extends { id: string }>(value: T): Omit<T, "id"> {
  const { id: _id, ...content } = value;
  return content;
}

function readV41EventContent(profile: FixtureProfile, id: string): Record<string, unknown> {
  const row = profile.db
    .prepare(
      `SELECT session_id, sequence, occurred_at, recorded_at, provenance,
              attachment_id, command_id, payload
         FROM session_events
        WHERE id = ?`,
    )
    .get(id) as {
    session_id: string;
    sequence: number;
    occurred_at: number;
    recorded_at: number;
    provenance: string;
    attachment_id: string | null;
    command_id: string | null;
    payload: string;
  };
  return {
    sessionId: row.session_id,
    sequence: row.sequence,
    occurredAt: row.occurred_at,
    recordedAt: row.recorded_at,
    provenance: JSON.parse(row.provenance) as unknown,
    ...(row.attachment_id === null ? {} : { attachmentId: row.attachment_id }),
    ...(row.command_id === null ? {} : { commandId: row.command_id }),
    payload: JSON.parse(row.payload) as unknown,
  };
}

describe("migration 42 — compact native event ids and interned provenance", () => {
  it("rewrites native-event identities and every relational copy without changing content", async () => {
    const profile = v41Fixture({ nativeEventIds: true });
    installNativeUsageProjection(profile);
    const beforeDigest = computeSessionStorageContentDigest(profile.db);
    const beforeEventContent = readV41EventContent(profile, USAGE_EVENT_ID);

    migrate(profile.db, profile.dbPath);

    const receiptEventId = compactNativeObservationEventId(RECEIPT_EVENT_ID);
    const usageEventId = compactNativeObservationEventId(USAGE_EVENT_ID);
    expect(profile.db.pragma("user_version", { simple: true })).toBe(42);
    expect(computeSessionStorageContentDigest(profile.db)).toEqual(beforeDigest);
    expect(
      (profile.db.pragma("table_info(session_events)") as Array<{ name: string }>).map(
        ({ name }) => name,
      ),
    ).toContain("provenance_id");
    expect(
      (profile.db.pragma("table_info(session_events)") as Array<{ name: string }>).map(
        ({ name }) => name,
      ),
    ).not.toContain("provenance");
    expect(profile.db.prepare("SELECT COUNT(*) AS n FROM session_provenances").get()).toEqual({
      n: 1,
    });

    const afterLedger = new SqliteSessionLedger(profile.db);
    const afterEvent = await afterLedger.transaction((transaction) =>
      transaction.getEvent(usageEventId),
    );
    expect(afterEvent).not.toBeNull();
    expect(withoutId(afterEvent!)).toEqual(beforeEventContent);
    await expect(
      afterLedger.transaction((transaction) => transaction.getEvent(USAGE_EVENT_ID)),
    ).resolves.toBeNull();

    expect(
      profile.db
        .prepare(
          `SELECT u.event_id
             FROM session_usage u
             JOIN session_events e ON e.id = u.event_id AND e.session_id = u.session_id`,
        )
        .get(),
    ).toEqual({ event_id: usageEventId });
    expect(
      profile.db
        .prepare(
          `SELECT r.receipt_event_id
             FROM session_command_receipts r
             JOIN session_events e
               ON e.id = r.receipt_event_id AND e.session_id = r.session_id`,
        )
        .get(),
    ).toEqual({ receipt_event_id: receiptEventId });
    expect(
      profile.db
        .prepare(
          "SELECT id, json_extract(receipt, '$.id') AS json_id FROM session_command_receipts",
        )
        .get(),
    ).toEqual({ id: "receipt-1", json_id: "receipt-1" });
    expect(profile.db.pragma("foreign_key_check")).toEqual([]);
    expect(
      profile.db
        .prepare(
          "SELECT COUNT(*) AS n FROM sqlite_temp_master WHERE type = 'table' AND name = 'session_event_id_map_v42'",
        )
        .get(),
    ).toEqual({ n: 0 });
  });

  it("deduplicates a v41 observation replayed through the engine after migration", async () => {
    const profile = v41Fixture({ nativeEventIds: true });
    installNativeUsageProjection(profile);
    migrate(profile.db, profile.dbPath);
    const compactId = compactNativeObservationEventId(USAGE_EVENT_ID);
    const engine = createSessionEngine({
      ledger: new SqliteSessionLedger(profile.db),
      clock: { now: () => 999 },
      ids: { next: () => "unexpected-new-id" },
    });
    const provenance = {
      source: {
        kind: "adapter" as const,
        id: "terminal",
        detail: { cwd: "/Users/source/code/alpha" },
      },
      venue: { id: "local", kind: "local" as const },
    };

    const replayed = await engine.observe({
      id: compactId,
      sessionId: "session-root",
      occurredAt: 254,
      provenance,
      attachmentId: "attach-1",
      kind: "usage.recorded",
      turnId: "turn-1",
      usage: {
        cause: "assistant",
        providerId: "anthropic",
        modelId: "claude-opus-4-1",
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 400,
        cacheWriteTokens: 0,
        costUsd: 0.25,
        costBasis: "catalog-estimate",
      },
    });

    expect(replayed.id).toBe(compactId);
    expect(
      profile.db.prepare("SELECT COUNT(*) AS n FROM session_events WHERE id = ?").get(compactId),
    ).toEqual({ n: 1 });
    expect(profile.db.prepare("SELECT COUNT(*) AS n FROM session_usage").get()).toEqual({ n: 1 });
  });

  it("rejects a compact-id collision before changing any row and rolls back", () => {
    const profile = v41Fixture({ nativeEventIds: true });
    installNativeUsageProjection(profile);
    const collision = compactNativeObservationEventId(USAGE_EVENT_ID);
    profile.db
      .prepare(
        `INSERT INTO session_commands (id, session_id, created_at, intent, route)
         VALUES (?, 'session-child', 300, '{"kind":"session.archive"}', NULL)`,
      )
      .run(collision);

    expect(() => migrate(profile.db, profile.dbPath)).toThrow(/collision/i);
    expect(profile.db.pragma("user_version", { simple: true })).toBe(41);
    expect(
      profile.db.prepare("SELECT id FROM session_events WHERE id = ?").get(USAGE_EVENT_ID),
    ).toEqual({ id: USAGE_EVENT_ID });
    expect(
      profile.db.prepare("SELECT name FROM sqlite_master WHERE name = 'session_provenances'").get(),
    ).toBeUndefined();
    expect(existsSync(`${profile.dbPath}.backup-v41`)).toBe(true);
  });

  it("migrates empty and zero-native-id databases while leaving ordinary ids unchanged", () => {
    const empty = v41Fixture();
    empty.db.exec(
      "DELETE FROM session_command_receipts; DELETE FROM session_usage; DELETE FROM session_events; DELETE FROM session_commands; DELETE FROM session_attachments; DELETE FROM session_delegation_extensions; DELETE FROM session_delegation_claims; DELETE FROM session_verb_grants; DELETE FROM session_delegations; DELETE FROM sessions; DELETE FROM ticket_signals; DELETE FROM ticket_comments; DELETE FROM ticket_event_sequence; DELETE FROM ticket_events; DELETE FROM ticket_labels; DELETE FROM labels; DELETE FROM tickets; DELETE FROM projects;",
    );

    migrate(empty.db, empty.dbPath);

    expect(empty.db.pragma("user_version", { simple: true })).toBe(42);
    expect(empty.db.prepare("SELECT COUNT(*) AS n FROM session_events").get()).toEqual({ n: 0 });
    expect(empty.db.prepare("SELECT COUNT(*) AS n FROM session_provenances").get()).toEqual({
      n: 0,
    });

    empty.cleanup();
    fixture = createFixtureProfile({ schemaVersion: 41 });
    const idsBefore = fixture.db
      .prepare("SELECT id FROM session_events ORDER BY session_id, sequence")
      .all();
    migrate(fixture.db, fixture.dbPath);
    expect(fixture.db.pragma("user_version", { simple: true })).toBe(42);
    expect(
      fixture.db.prepare("SELECT id FROM session_events ORDER BY session_id, sequence").all(),
    ).toEqual(idsBefore);
  });
});
