/**
 * Process-only acceptance fixture: the real hostd composition and managedStatus.
 * A relative agent socket keeps every write inside the scratch cwd even when a
 * ticket worktree's absolute path exceeds macOS's Unix-socket length limit.
 * No install/start/unit management, enrollment, Sessions or sign-ins run here.
 */
import { userInfo } from "node:os";

import { startHostd } from "../../../hostd/src/hostd";
import { installLayout } from "../../../hostd/src/layout";
import { createJsonLogger } from "../../../hostd/src/log";
import { managedStatus } from "../../../hostd/src/manage-status";
import { LIVE_PROBES, statusExitCode } from "../../../hostd/src/status";

async function main(): Promise<void> {
  const [command, dataDir, version, port] = process.argv.slice(2);
  if (!dataDir || !version || !port || !["serve", "status"].includes(command ?? "")) {
    throw new Error("Expected serve|status dataDir version port");
  }
  if (command === "status") {
    const where = { home: process.env.HOME!, env: process.env, platform: process.platform };
    const report = await managedStatus(
      { kind: "status-json", mode: null, dataDir },
      {
        layouts: { system: installLayout("system", where), user: installLayout("user", where) },
        run: () => {
          throw new Error("Acceptance fixture must never invoke a service manager");
        },
        probes: LIVE_PROBES,
        login: () => userInfo().username,
        uid: () => process.getuid!(),
        version,
        trustedOwnerUid: 0,
      },
    );
    process.stdout.write(`${JSON.stringify(report)}\n`);
    process.exit(statusExitCode(report.verdict));
  }
  const host = await startHostd({
    dataDir,
    socketPath: "agent.sock",
    version,
    env: process.env,
    operatorsFile: `${dataDir}/absent-operators`,
    // No operator entries exist; the fixture account owns its private scratch.
    operatorsOwnerUid: process.getuid!(),
    listen: { host: "127.0.0.1", port: Number(port) },
    logger: createJsonLogger({ level: "warn", write: (line) => process.stderr.write(line) }),
  });
  if (!host.host.database.ok) throw new Error(host.host.database.error);
  const projects = host.host.database.db
    .prepare("SELECT COUNT(*) AS count FROM projects")
    .get() as { count: number };
  process.stdout.write(`${JSON.stringify({ projects: projects.count })}\n`);
  let stopping = false;
  process.on("SIGTERM", () => {
    if (stopping) return;
    stopping = true;
    void host.stop("acceptance fixture stopped").then((clean) => process.exit(clean ? 0 : 1));
  });
}
void main().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exit(1);
});
