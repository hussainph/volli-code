// The shared follow-up ledger contract against the production SQLite queue.
// session-engine runs the same suite against its in-memory twin.
import { describeSessionFollowUpLedgerContract } from "@volli/session-engine/testing/contracts";
import { createSqliteSessionLedger } from "../session-control/sqlite-ledger";
import { insertProject } from "./projects-repo";
import { createSqliteSessionFollowUpLedger } from "./session-follow-up-repo";
import { openTestDb, testProject } from "./test-helpers";

describeSessionFollowUpLedgerContract("SQLite", () => {
  const ctx = openTestDb();
  return {
    ledger: createSqliteSessionLedger(ctx.db),
    followUps: createSqliteSessionFollowUpLedger(ctx.db),
    seedProject(projectId) {
      insertProject(ctx.db, testProject({ id: projectId, path: `/repo/${projectId}` }));
    },
    dispose: ctx.cleanup,
  };
});
