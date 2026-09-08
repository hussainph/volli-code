import { describe, expect, it } from "vite-plus/test";

import { createFixtureProfile } from "../backup/test-fixture";
import {
  assertSessionStorageContentUnchanged,
  computeSessionStorageContentDigest,
  computeSessionStorageContentDigestAtPath,
} from "./session-storage-digest";

describe("session storage logical content digest", () => {
  it("can inspect an arbitrary database path and ignores only rewritten event identities", () => {
    const fixture = createFixtureProfile({ schemaVersion: 41 });
    try {
      const before = computeSessionStorageContentDigest(fixture.db);
      expect(computeSessionStorageContentDigestAtPath(fixture.dbPath)).toEqual(before);

      fixture.db
        .prepare("UPDATE session_events SET id = 'renamed-event' WHERE id = 'event-4'")
        .run();
      expect(computeSessionStorageContentDigest(fixture.db)).toEqual(before);

      fixture.db
        .prepare(
          "UPDATE session_events SET recorded_at = recorded_at + 1 WHERE id = 'renamed-event'",
        )
        .run();
      expect(computeSessionStorageContentDigest(fixture.db)).not.toEqual(before);
    } finally {
      fixture.cleanup();
    }
  });

  it("includes every non-identity usage and receipt field and throws on any mismatch", () => {
    const fixture = createFixtureProfile({ schemaVersion: 41 });
    try {
      const before = computeSessionStorageContentDigest(fixture.db);
      fixture.db.prepare("UPDATE session_command_receipts SET recorded_at = recorded_at + 1").run();
      const after = computeSessionStorageContentDigest(fixture.db);

      expect(after.sessionCommandReceipts).not.toEqual(before.sessionCommandReceipts);
      expect(() => assertSessionStorageContentUnchanged(before, after)).toThrow(
        /session storage content changed/i,
      );
    } finally {
      fixture.cleanup();
    }
  });
});
