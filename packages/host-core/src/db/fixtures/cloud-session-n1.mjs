// The previous build reads an owner-stamped cloud Session through its own
// SQLite repositories and real Session codec. hooks.mjs resolves every n1:
// import against that build; no current-source implementation is imported.
const n1 = (path) => import(`n1:${path}`);
const command = JSON.parse(process.argv[2]);
const { openVolliDb } = await n1("./db/index");
const migrations = await n1("./db/migrations");
const { createSessionEngine } = await n1("@volli/session-engine");
const { createSqliteSessionLedger } = await n1("./session-control/sqlite-ledger");
const { listProjects } = await n1("./db/projects-repo");
const { listTicketsByProject } = await n1("./db/tickets-repo");
const guarded = await n1("./db/schema-compatibility").then(
  () => true,
  (error) => {
    if (error?.code === "ERR_MODULE_NOT_FOUND") return false;
    throw error;
  },
);
const results = [];
for (const step of command.steps) {
  let db;
  try {
    if (step.kind !== "cloudListing") throw new Error(`Unknown fixture step ${step.kind}`);
    db = openVolliDb(command.dbPath);
    const engine = createSessionEngine({
      ledger: createSqliteSessionLedger(db),
      clock: { now: () => 1_791_000_000_000 },
      ids: { next: (kind) => `n1-cloud-read-${kind}` },
    });
    const local = await engine.listSessions({ projectId: step.localProjectId, scope: "all" });
    const cloud = await engine.listSessions({ projectId: step.projectId, scope: "all" });
    const snapshot = await engine.getSession({ sessionId: step.sessionId });
    const projects = listProjects(db);
    const tickets = listTicketsByProject(db, step.projectId);
    results.push({
      kind: step.kind,
      ok: true,
      value: {
        localVisible: local.some(({ session }) => session.id === step.localSessionId),
        cloudListed: cloud.some(({ session }) => session.id === step.sessionId),
        cloudReadable: snapshot !== null,
        shadowProjectListed: projects.some((project) => project.id === step.projectId),
        shadowTicketListed: tickets.some((ticket) => ticket.id === step.ticketId),
      },
    });
  } catch (error) {
    results.push({
      kind: step.kind,
      ok: false,
      error: {
        name: error?.name ?? typeof error,
        message: String(error?.message ?? error),
      },
    });
  } finally {
    db?.close();
  }
}
process.stdout.write(
  `${JSON.stringify({
    head: migrations.SCHEMA_HEAD ?? migrations.MIGRATIONS.at(-1).version,
    guarded,
    results,
  })}\n`,
);
