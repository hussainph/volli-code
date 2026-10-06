/** `volli-hostd`'s command line. */
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { HostdBootError } from "./boot-error";
import type { CredentialsResetCommand } from "./credentials";
import type { DatabaseRestoreCommand } from "./database";
import type { OperatorTokenCommand } from "./operator-token";
import { DEFAULT_OPERATORS_FILE } from "./operators";

/** The account the packaged systemd unit runs hostd, and so every Session, as. */
export const DEFAULT_SERVICE_USER = "volli";

export const USAGE = `Usage:
  volli-hostd --data-dir <dir> [--socket <path>] [--operators <file>]
                                                   Serve this data directory.
  volli-hostd status --data-dir <dir>              Report health; exit 0 serving,
                                                   1 refusing, 3 not serving.
  volli-hostd credentials reset --data-dir <dir> [--yes]
                                                   With hostd stopped: set aside saved
                                                   secrets it cannot open, and start
                                                   with none.
  volli-hostd database restore --data-dir <dir> --from <file> --schema <N> [--yes]
                                                   With hostd stopped: restore a cold
                                                   copy at N, without migration.
                                                   Discards later writes.
  volli-hostd operator-token --for <login>         As root: issue <login> an operator
  volli-hostd operator-token --revoke <login>      token, or revoke it. [--operators
                                                   <file>] [--service-user <name>]
  volli-hostd --version | --help

The agent socket defaults to <dir>/volli.sock, mode 600. Under systemd socket
activation (LISTEN_FDS) hostd serves the socket the unit bound, and --socket
only names it. Point the volli CLI at it with VOLLI_SOCKET=<path>. The operators file defaults to ${DEFAULT_OPERATORS_FILE}
and must be root's; the service user defaults to ${DEFAULT_SERVICE_USER}.
VOLLI_SECRET_KEY_FILE names an absolute key file; VOLLI_HOSTD_LOG_LEVEL is
debug, info (default), warn or error.
`;

export type HostdCommand =
  | {
      kind: "serve";
      dataDir: string;
      socketPath: string;
      operatorsFile: string;
    }
  | { kind: "status"; dataDir: string }
  | CredentialsResetCommand
  | DatabaseRestoreCommand
  | OperatorTokenCommand
  | { kind: "help" }
  | { kind: "version" };

/** The default agent socket, where the desktop app also puts its own. */
export function defaultSocketPath(dataDir: string): string {
  return resolve(dataDir, "volli.sock");
}

/** Parses argv (without node and the script). Relative paths resolve against `cwd`. */
export function parseHostdArgs(argv: readonly string[], cwd: string): HostdCommand {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    throw new HostdBootError("usage", (error as Error).message);
  }
  const { values, positionals } = parsed;
  if (values.help === true) return { kind: "help" };
  if (values.version === true) return { kind: "version" };
  const [verb, ...rest] = positionals;
  const known =
    verb === "status" || verb === "operator-token" || verb === "credentials" || verb === "database";
  // Maintenance commands take one action word.
  const action = verb === "credentials" || verb === "database" ? rest.shift() : undefined;
  if (verb === "database" && action !== "restore") {
    throw new HostdBootError(
      "usage",
      action === undefined ? "database needs an action: restore." : `Unknown argument: ${action}`,
    );
  }
  if (verb === "credentials" && action !== "reset") {
    throw new HostdBootError(
      "usage",
      action === undefined ? "credentials needs an action: reset." : `Unknown argument: ${action}`,
    );
  }
  if (rest.length > 0 || (verb !== undefined && !known)) {
    throw new HostdBootError("usage", `Unknown argument: ${known ? rest[0] : verb}`);
  }
  if (verb !== "credentials" && verb !== "database" && values.yes !== undefined) {
    throw new HostdBootError("usage", "--yes belongs to credentials reset or database restore.");
  }
  if (verb !== "database" && (values.from !== undefined || values.schema !== undefined))
    throw new HostdBootError("usage", "--from and --schema belong to database restore.");
  if (verb === "operator-token") return operatorTokenCommand(values, cwd);
  if (
    values.for !== undefined ||
    values.revoke !== undefined ||
    values["service-user"] !== undefined
  ) {
    throw new HostdBootError(
      "usage",
      "--for, --revoke and --service-user belong to operator-token.",
    );
  }
  if (values["data-dir"] === undefined || values["data-dir"].length === 0) {
    throw new HostdBootError("usage", "--data-dir <dir> is required.");
  }
  const dataDir = resolve(cwd, values["data-dir"]);
  if (verb === "database") {
    if ([values.socket, values.operators].some((v) => v !== undefined))
      throw new HostdBootError(
        "usage",
        "database restore takes --data-dir, --from, --schema and --yes only.",
      );
    if (values.from === undefined || values.from.length === 0)
      throw new HostdBootError("usage", "database restore requires --from <file>.");
    if (
      values.schema === undefined ||
      !/^[1-9][0-9]*$/.test(values.schema) ||
      !Number.isSafeInteger(Number(values.schema))
    )
      throw new HostdBootError(
        "usage",
        "database restore requires --schema <N>, a positive integer.",
      );
    return {
      kind: "database-restore",
      dataDir,
      sourcePath: resolve(cwd, values.from),
      schemaVersion: Number(values.schema),
      confirmed: values.yes === true,
    };
  }
  if (verb === "credentials") {
    if ([values.socket, values.operators].some((v) => v !== undefined)) {
      throw new HostdBootError("usage", "credentials reset takes --data-dir and --yes only.");
    }
    return { kind: "credentials-reset", dataDir, confirmed: values.yes === true };
  }
  if (verb === "status") {
    if ([values.socket, values.operators].some((v) => v !== undefined)) {
      throw new HostdBootError(
        "usage",
        "status takes --data-dir only: it reads the socket path from the data directory.",
      );
    }
    return { kind: "status", dataDir };
  }
  const socketPath =
    values.socket === undefined || values.socket.length === 0
      ? defaultSocketPath(dataDir)
      : resolve(cwd, values.socket);
  return {
    kind: "serve",
    dataDir,
    socketPath,
    operatorsFile: operatorsFileFrom(values.operators, cwd),
  };
}

function operatorsFileFrom(value: string | undefined, cwd: string): string {
  return value === undefined || value.length === 0 ? DEFAULT_OPERATORS_FILE : resolve(cwd, value);
}

function operatorTokenCommand(
  values: ReturnType<typeof parse>["values"],
  cwd: string,
): OperatorTokenCommand {
  if ([values["data-dir"], values.socket].some((v) => v !== undefined)) {
    throw new HostdBootError(
      "usage",
      "operator-token takes --for or --revoke, --operators and --service-user only.",
    );
  }
  const issue = values.for;
  const revoke = values.revoke;
  if ((issue === undefined) === (revoke === undefined)) {
    throw new HostdBootError(
      "usage",
      "operator-token needs exactly one of --for <login> or --revoke <login>.",
    );
  }
  return {
    kind: "operator-token",
    action: issue === undefined ? "revoke" : "issue",
    login: (issue ?? revoke)!,
    operatorsFile: operatorsFileFrom(values.operators, cwd),
    serviceUser: values["service-user"] || DEFAULT_SERVICE_USER,
  };
}

function parse(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: true,
    options: {
      "data-dir": { type: "string" },
      socket: { type: "string" },
      operators: { type: "string" },
      for: { type: "string" },
      revoke: { type: "string" },
      "service-user": { type: "string" },
      yes: { type: "boolean" },
      from: { type: "string" },
      schema: { type: "string" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
}
