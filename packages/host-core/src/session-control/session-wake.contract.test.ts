// The shared committed-stream contract against the production wake bus, over
// the SQLite ledger. session-engine runs the same suite against its twin.
import { describeCommittedSessionStreamContract } from "@volli/session-engine/testing/contracts";
import { insertProject } from "../db/projects-repo";
import { openTestDb, testProject } from "../db/test-helpers";
import { createTestSessionEngine } from "../testing/session-engine";
import { createSessionWakeBus } from "./session-wake";

describeCommittedSessionStreamContract("wake bus", () => {
  const ctx = openTestDb();
  let id = 0;
  const bus = createSessionWakeBus(
    createTestSessionEngine(ctx.db, { now: () => 100, nextId: () => `wake-${++id}` }),
    { db: ctx.db },
  );
  return {
    engine: bus.engine,
    subscribe: (listener) => bus.subscribe(({ event }) => listener(event)),
    seedProject(projectId) {
      insertProject(ctx.db, testProject({ id: projectId, path: `/repo/${projectId}` }));
    },
    dispose: ctx.cleanup,
  };
});
