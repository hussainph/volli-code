// The shared SessionLedger contract against the production SQLite ledger.
// session-engine runs the same suite against its in-memory twin.
import { describeSessionLedgerContract } from "@volli/session-engine/testing/contracts";
import { insertProject } from "../db/projects-repo";
import { openTestDb, testProject, testTicket } from "../db/test-helpers";
import { insertTicket } from "../db/tickets-repo";
import { createSqliteSessionLedger } from "./sqlite-ledger";

describeSessionLedgerContract("SQLite", () => {
  const ctx = openTestDb();
  return {
    ledger: createSqliteSessionLedger(ctx.db),
    seedProject(projectId, ticketIds = []) {
      insertProject(ctx.db, testProject({ id: projectId, path: `/repo/${projectId}` }));
      for (const id of ticketIds) {
        insertTicket(ctx.db, testTicket(projectId, { id, usesWorktree: false }));
      }
    },
    dispose: ctx.cleanup,
  };
});
