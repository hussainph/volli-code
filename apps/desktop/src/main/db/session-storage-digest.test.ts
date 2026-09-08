import type Database from "better-sqlite3";
import { describe, expect, it } from "vite-plus/test";

import { createFixtureProfile, FIXTURE_NATIVE_USAGE_EVENT_ID } from "../backup/test-fixture";
import {
  assertSessionStorageContentUnchanged,
  computeSessionStorageContentDigest,
  computeSessionStorageContentDigestAtPath,
  type SessionStorageContentDigest,
} from "./session-storage-digest";

type DigestTable = keyof SessionStorageContentDigest;

function seedUsage(db: Database.Database): void {
  db.prepare(
    `INSERT INTO session_usage
      (event_id, session_id, project_id, ticket_id, occurred_at, cause,
       provider_id, model_id, input_tokens, output_tokens,
       cache_read_tokens, cache_write_tokens, cost_usd, cost_basis)
     VALUES (?, 'session-root', 'proj-alpha', 'ticket-live', 254, 'assistant',
             'anthropic', 'claude-opus-4-1', 100, 20, 400, 0, 0.25, 'catalog-estimate')`,
  ).run(FIXTURE_NATIVE_USAGE_EVENT_ID);
}

function digestDuringMutation(
  db: Database.Database,
  mutate: string,
): {
  before: SessionStorageContentDigest;
  after: SessionStorageContentDigest;
} {
  const before = computeSessionStorageContentDigest(db);
  db.exec("BEGIN");
  try {
    db.exec(mutate);
    return { before, after: computeSessionStorageContentDigest(db) };
  } finally {
    db.exec("ROLLBACK");
  }
}

const DIGESTED_COLUMN_MUTATIONS: ReadonlyArray<{
  table: DigestTable;
  column: string;
  sql: string;
}> = [
  {
    table: "sessionEvents",
    column: "session_id",
    sql: `UPDATE session_events SET session_id = 'session-child' WHERE id = '${FIXTURE_NATIVE_USAGE_EVENT_ID}'`,
  },
  {
    table: "sessionEvents",
    column: "sequence",
    sql: `UPDATE session_events SET sequence = 99 WHERE id = '${FIXTURE_NATIVE_USAGE_EVENT_ID}'`,
  },
  {
    table: "sessionEvents",
    column: "occurred_at",
    sql: `UPDATE session_events SET occurred_at = occurred_at + 1 WHERE id = '${FIXTURE_NATIVE_USAGE_EVENT_ID}'`,
  },
  {
    table: "sessionEvents",
    column: "recorded_at",
    sql: `UPDATE session_events SET recorded_at = recorded_at + 1 WHERE id = '${FIXTURE_NATIVE_USAGE_EVENT_ID}'`,
  },
  {
    table: "sessionEvents",
    column: "provenance",
    sql: `UPDATE session_events SET provenance = json_set(provenance, '$.source.id', 'mutated') WHERE id = '${FIXTURE_NATIVE_USAGE_EVENT_ID}'`,
  },
  {
    table: "sessionEvents",
    column: "attachment_id",
    sql: `UPDATE session_events SET attachment_id = NULL WHERE id = '${FIXTURE_NATIVE_USAGE_EVENT_ID}'`,
  },
  {
    table: "sessionEvents",
    column: "command_id",
    sql: `UPDATE session_events SET command_id = 'command-1' WHERE id = '${FIXTURE_NATIVE_USAGE_EVENT_ID}'`,
  },
  {
    table: "sessionEvents",
    column: "payload",
    sql: `UPDATE session_events SET payload = json_set(payload, '$.turnId', 'mutated') WHERE id = '${FIXTURE_NATIVE_USAGE_EVENT_ID}'`,
  },
  {
    table: "sessionUsage",
    column: "session_id",
    sql: "UPDATE session_usage SET session_id = 'session-child'",
  },
  {
    table: "sessionUsage",
    column: "project_id",
    sql: "UPDATE session_usage SET project_id = 'proj-beta'",
  },
  { table: "sessionUsage", column: "ticket_id", sql: "UPDATE session_usage SET ticket_id = NULL" },
  {
    table: "sessionUsage",
    column: "occurred_at",
    sql: "UPDATE session_usage SET occurred_at = occurred_at + 1",
  },
  { table: "sessionUsage", column: "cause", sql: "UPDATE session_usage SET cause = 'title'" },
  {
    table: "sessionUsage",
    column: "provider_id",
    sql: "UPDATE session_usage SET provider_id = 'other-provider'",
  },
  {
    table: "sessionUsage",
    column: "model_id",
    sql: "UPDATE session_usage SET model_id = 'other-model'",
  },
  {
    table: "sessionUsage",
    column: "input_tokens",
    sql: "UPDATE session_usage SET input_tokens = input_tokens + 1",
  },
  {
    table: "sessionUsage",
    column: "output_tokens",
    sql: "UPDATE session_usage SET output_tokens = output_tokens + 1",
  },
  {
    table: "sessionUsage",
    column: "cache_read_tokens",
    sql: "UPDATE session_usage SET cache_read_tokens = cache_read_tokens + 1",
  },
  {
    table: "sessionUsage",
    column: "cache_write_tokens",
    sql: "UPDATE session_usage SET cache_write_tokens = cache_write_tokens + 1",
  },
  {
    table: "sessionUsage",
    column: "cost_usd",
    sql: "UPDATE session_usage SET cost_usd = cost_usd + 1",
  },
  {
    table: "sessionUsage",
    column: "cost_basis",
    sql: "UPDATE session_usage SET cost_basis = 'provider-reported'",
  },
  {
    table: "sessionCommandReceipts",
    column: "id",
    sql: "UPDATE session_command_receipts SET id = 'receipt-mutated'",
  },
  {
    table: "sessionCommandReceipts",
    column: "session_id",
    sql: "UPDATE session_command_receipts SET session_id = 'session-child'",
  },
  {
    table: "sessionCommandReceipts",
    column: "command_id",
    sql: "UPDATE session_command_receipts SET command_id = 'command-mutated'",
  },
  {
    table: "sessionCommandReceipts",
    column: "sequence",
    sql: "UPDATE session_command_receipts SET sequence = sequence + 10",
  },
  {
    table: "sessionCommandReceipts",
    column: "recorded_at",
    sql: "UPDATE session_command_receipts SET recorded_at = recorded_at + 1",
  },
  {
    table: "sessionCommandReceipts",
    column: "receipt",
    sql: "UPDATE session_command_receipts SET receipt = json_set(receipt, '$.recordedAt', 999)",
  },
];

const EXCLUDED_IDENTITY_MUTATIONS = [
  {
    column: "session_events.id",
    sql: `UPDATE session_events SET id = 'event-mutated' WHERE id = '${FIXTURE_NATIVE_USAGE_EVENT_ID}'`,
  },
  {
    column: "session_usage.event_id",
    sql: "UPDATE session_usage SET event_id = 'usage-event-mutated'",
  },
  {
    column: "session_command_receipts.receipt_event_id",
    sql: "UPDATE session_command_receipts SET receipt_event_id = 'receipt-event-mutated'",
  },
] as const;

describe("session storage logical content digest", () => {
  it("can inspect an arbitrary database path read-only", () => {
    const fixture = createFixtureProfile({ schemaVersion: 41 });
    try {
      const digest = computeSessionStorageContentDigest(fixture.db);
      expect(computeSessionStorageContentDigestAtPath(fixture.dbPath)).toEqual(digest);
    } finally {
      fixture.cleanup();
    }
  });

  it.each(DIGESTED_COLUMN_MUTATIONS.map(({ table, column, sql }) => [table, column, sql] as const))(
    "changes when %s.%s changes",
    (table, _column, sql) => {
      const fixture = createFixtureProfile({ schemaVersion: 41, nativeEventIds: true });
      try {
        seedUsage(fixture.db);
        fixture.db.pragma("foreign_keys = OFF");
        const { before, after } = digestDuringMutation(fixture.db, sql);

        expect(after[table]).not.toEqual(before[table]);
        expect(() => assertSessionStorageContentUnchanged(before, after)).toThrow(
          /session storage content changed/i,
        );
      } finally {
        fixture.cleanup();
      }
    },
  );

  it.each(EXCLUDED_IDENTITY_MUTATIONS)("ignores rewritten identity $column", ({ sql }) => {
    const fixture = createFixtureProfile({ schemaVersion: 41, nativeEventIds: true });
    try {
      seedUsage(fixture.db);
      fixture.db.pragma("foreign_keys = OFF");
      const { before, after } = digestDuringMutation(fixture.db, sql);

      expect(after).toEqual(before);
    } finally {
      fixture.cleanup();
    }
  });
});
