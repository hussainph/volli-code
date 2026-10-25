/** Opt-in, synthetic queue-row probe. No owner profile is opened. */
import Database from "better-sqlite3";
import { describe, expect, it } from "vite-plus/test";
import {
  canonicalJson,
  emptySessionFollowUpState,
  projectSessionFollowUps,
  pruneSessionFollowUpState,
  type SessionFollowUpState,
} from "@volli/session-engine";
import { createSqliteSessionFollowUpLedger } from "./session-follow-up-repo";

const SESSIONS = 8;
const QUEUED = 32;
const HISTORY = 1_024;

function fixture(pruned: boolean): SessionFollowUpState {
  const state = emptySessionFollowUpState();
  state.revision = HISTORY;
  for (let i = 0; i < HISTORY; i++) {
    const id = `command-${i}`;
    const message = {
      id: `message-${i}`,
      role: "user" as const,
      parts: [{ type: "text" as const, text: "Synthetic follow-up payload. ".repeat(32) }],
    };
    if (i < QUEUED)
      state.entries.push({
        id: message.id,
        commandId: id,
        deliveryCommandId: `delivery-${i}`,
        state: "queued",
        message,
      });
    state.commands[id] = {
      signature: canonicalJson({ commandId: id, message }),
      result: {
        sessionId: "synthetic",
        command: {
          id,
          sessionId: "synthetic",
          createdAt: i,
          route: null,
          intent: { kind: "message.queue", message },
        },
        receipt: {
          id: `queued-receipt-${i}`,
          commandId: id,
          status: "accepted",
          acceptedAt: i,
          result: { kind: "message.submitted", sessionId: "synthetic" },
          recordedAt: i,
          sequence: i,
        },
        throughSequence: 0,
        refusal: null,
      },
    };
    if (i >= QUEUED)
      state.releases[`delivery-${i}`] = {
        command: {
          id: `delivery-${i}`,
          sessionId: "synthetic",
          createdAt: i,
          route: null,
          intent: {
            kind: "message.submit",
            reference: { id: message.id, mediaType: null, digest: null },
          },
        },
        receipt: {
          id: `receipt-${i}`,
          commandId: `delivery-${i}`,
          status: "accepted",
          acceptedAt: i,
          result: { kind: "message.submitted", sessionId: "synthetic" },
          recordedAt: i,
          sequence: i,
        },
      };
  }
  // Price the real payload-retention policy, including the N−1 compatibility
  // identity tombstones that remain in this row after full replies expire.
  if (pruned) pruneSessionFollowUpState(state, Date.now());
  return state;
}

// Eight concurrent callers share the production adapter's synchronous SQLite
// connection, as eight Sessions in one runner do. Timing is descriptive only.
describe.skipIf(process.env.VOLLI_FOLLOW_UP_READ_BENCH !== "1")("follow-up row read cost", () => {
  it("reports unpruned/pruned rows and adapter/deferred projection reads", async () => {
    const db = new Database(":memory:");
    db.exec(
      "CREATE TABLE session_follow_up_queue(session_id TEXT PRIMARY KEY, state TEXT NOT NULL, pending_count INTEGER NOT NULL)",
    );
    try {
      const ledger = createSqliteSessionFollowUpLedger(db);
      const insert = db.prepare("INSERT OR REPLACE INTO session_follow_up_queue VALUES (?, ?, ?)");
      const select = db.prepare("SELECT state FROM session_follow_up_queue WHERE session_id = ?");
      const deferred = db.transaction((id: string) =>
        projectSessionFollowUps(JSON.parse((select.get(id) as { state: string }).state)),
      );
      for (const pruned of [false, true]) {
        const encoded = canonicalJson(fixture(pruned));
        for (let i = 0; i < SESSIONS; i++) insert.run(`session-${i}`, encoded, QUEUED);
        for (const mode of ["adapter", "deferred"] as const) {
          const samples: number[] = [];
          for (let round = 0; round < 12; round++) {
            const start = performance.now();
            const queues = await Promise.all(
              Array.from({ length: SESSIONS }, (_, i) =>
                mode === "adapter"
                  ? ledger.transaction(`session-${i}`, projectSessionFollowUps, { mode: "read" })
                  : deferred.deferred(`session-${i}`),
              ),
            );
            expect(queues.every((queue) => queue.length === QUEUED)).toBe(true);
            if (round >= 2) samples.push((performance.now() - start) / SESSIONS);
          }
          console.log(
            JSON.stringify({
              pruned,
              mode,
              sessions: SESSIONS,
              queued: QUEUED,
              history: HISTORY,
              bytes: Buffer.byteLength(encoded),
              medianMsPerRead: samples.toSorted((a, b) => a - b)[Math.floor(samples.length / 2)],
              maxMsPerRead: Math.max(...samples),
            }),
          );
        }
      }
    } finally {
      db.close();
    }
  });
});
