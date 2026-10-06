/**
 * `volli-hostd`: the headless Volli host (VC-562). See README.md.
 *
 * Exit codes: 0 after a clean stop; 1 when something failed at runtime or the
 * shutdown was not clean; 2 for usage errors; 78 (`EX_CONFIG`) for a boot
 * refusal an operator must fix, which the systemd unit does not restart.
 * `status` exits 0 serving, 1 refusing, 3 not serving. `credentials reset`
 * exits 0 when it reset or had nothing to reset, 1 when it did not.
 * `database restore` exits 0 after a durable, checked restore, 1 on refusal/failure.
 */
import { EXIT_CONFIG, HostdBootError } from "./boot-error";
import { VOLLI_OPERATOR_TOKEN_ENV } from "@volli/shared";

import { parseHostdArgs, USAGE, type HostdCommand } from "./args";
import { socketActivationFd } from "./activation";
import { runCredentialsReset } from "./credentials";
import { runDatabaseRestore } from "./database";
import { lookupSystemUser, runOperatorToken, writeTokenAsUser } from "./operator-token";
import { hostLogger, installHostLog, jsonLineSink } from "@volli/host-core/log";

import { logLevelFrom, routeConsole, type HostdLogger } from "./log";
import { startHostd, type RunningHostd } from "./hostd";
import { checkStatus, LIVE_PROBES, statusExitCode } from "./status";
import { headlessRuntimePaths } from "./runtime-paths";
import { HOSTD_VERSION } from "./version";

/** Past this, a stop that has not finished is abandoned and the process exits 1. */
const SHUTDOWN_DEADLINE_MS = 30_000;

async function main(): Promise<number> {
  // One destination for every line this process writes: hostd's own and
  // every host-core module's, JSON on stdout for the journal (VC-699).
  installHostLog({
    level: logLevelFrom(process.env["VOLLI_HOSTD_LOG_LEVEL"]),
    sink: jsonLineSink((line) => process.stdout.write(line)),
  });
  const logger = hostLogger("hostd");
  let command;
  try {
    command = parseHostdArgs(process.argv.slice(2), process.cwd());
  } catch (error) {
    process.stderr.write(`volli-hostd: ${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }
  switch (command.kind) {
    case "help":
      process.stdout.write(USAGE);
      return 0;
    case "version":
      process.stdout.write(`${HOSTD_VERSION}\n`);
      return 0;
    case "status": {
      const report = await checkStatus(command.dataDir, LIVE_PROBES);
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return statusExitCode(report.verdict);
    }
    case "credentials-reset":
      return runCredentialsReset(command, {
        env: process.env,
        now: () => new Date(),
        out: (text) => process.stdout.write(text),
        err: (text) => process.stderr.write(text),
      });
    case "database-restore":
      return runDatabaseRestore(command, {
        out: (text) => process.stdout.write(text),
        err: (text) => process.stderr.write(text),
      });
    case "operator-token":
      return runOperatorToken(command, {
        uid: () => process.getuid!(),
        rootUid: 0,
        lookupUser: lookupSystemUser,
        // "": the operator's home from the password database, never root's $HOME.
        writeTokenAsUser: (user, token) => writeTokenAsUser(user, token, ""),
        now: () => new Date(),
        out: (text) => process.stdout.write(text),
        err: (text) => process.stderr.write(text),
      });
    case "serve":
      return serve(command, logger);
  }
}

async function serve(
  command: Extract<HostdCommand, { kind: "serve" }>,
  logger: HostdLogger,
): Promise<number> {
  const { dataDir, socketPath } = command;
  // A person's credential is never inherited by the host, nor so by any
  // Session it starts (VC-623): an operator who exported it in the shell that
  // launched hostd keeps it in that shell.
  delete process.env[VOLLI_OPERATOR_TOKEN_ENV];
  // Read before the Sessions this host starts could inherit them: the
  // activated socket is hostd's, and no child is the process it names.
  const activation = { ...process.env };
  delete process.env["LISTEN_FDS"];
  delete process.env["LISTEN_PID"];
  delete process.env["LISTEN_FDNAMES"];
  routeConsole(logger);
  let running: RunningHostd | undefined;
  let finish!: (code: number) => void;
  const finished = new Promise<number>((resolve) => {
    finish = resolve;
  });
  // Any failure seen before the stop completes makes the exit non-zero, even
  // when the stop itself was clean and was asked for by a signal first.
  let failed = false;
  let stopRequested = false;
  let stopReason = "";
  let stopping = false;
  /** Exits now, from anywhere: boot may be stuck on I/O that never returns. */
  const forceExit = (msg: string, fields: Record<string, unknown>): void => {
    logger.error(msg, fields);
    process.exit(1);
  };
  // A stop asked for during boot waits for boot to finish, so it closes what
  // boot opened rather than exiting under an open database. The deadline
  // starts at the request, not when boot finishes.
  const beginStop = (): void => {
    if (running === undefined || stopping) return;
    stopping = true;
    void running.stop(stopReason).then(
      (clean) => finish(clean && !failed ? 0 : 1),
      (error: unknown) => {
        logger.error("shutdown failed", { error });
        finish(1);
      },
    );
  };
  const requestStop = (why: string, failure: boolean): void => {
    if (failure) failed = true;
    if (stopRequested) return;
    stopRequested = true;
    stopReason = why;
    // Referenced on purpose: a boot stuck on a promise with no I/O behind it
    // would otherwise let the event loop drain and exit 0.
    setTimeout(
      () => forceExit("shutdown deadline passed; exiting", { deadlineMs: SHUTDOWN_DEADLINE_MS }),
      SHUTDOWN_DEADLINE_MS,
    );
    beginStop();
  };
  let signalled = false;
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      if (signalled) {
        forceExit("second signal; exiting without waiting", { signal });
        return;
      }
      signalled = true;
      requestStop(signal, false);
    });
  }
  // A throw nobody caught leaves the host in a state nobody chose: stop
  // serving, close the database, exit non-zero, and let the supervisor restart.
  process.on("uncaughtException", (error) => {
    logger.error("uncaught exception", { error, stack: error.stack });
    requestStop("uncaught exception", true);
  });
  process.on("unhandledRejection", (reason) => {
    logger.error("unhandled rejection", { error: reason });
    requestStop("unhandled rejection", true);
  });

  try {
    const listenFd = socketActivationFd(activation, process.pid);
    running = await startHostd({
      dataDir,
      socketPath,
      listenFd,
      operatorsFile: command.operatorsFile,
      listen: command.listen,
      version: HOSTD_VERSION,
      env: process.env,
      logger,
      runtime: headlessRuntimePaths(__dirname, socketPath),
    });
  } catch (error) {
    if (error instanceof HostdBootError) {
      logger.error(error.message, { reason: error.reason, ...error.fields });
      return EXIT_CONFIG;
    }
    logger.error("boot failed", { error, stack: (error as Error).stack });
    return 1;
  }
  if (stopRequested) beginStop();
  return finished;
}

void main().then(
  (code) => {
    process.exitCode = code;
    // Nothing composed here is meant to outlive the host; a stray timer must
    // not keep a stopped service in the process table.
    process.exit(code);
  },
  (error: unknown) => {
    process.stderr.write(`volli-hostd: ${(error as Error).message}\n`);
    process.exit(1);
  },
);
