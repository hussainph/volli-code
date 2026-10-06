/** `volli-hostd`'s command line. */
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { HostdBootError } from "./boot-error";
import type { CredentialsResetCommand } from "./credentials";
import { parseListen, type HostProtocolBind } from "./host-protocol";
import type { DatabaseRestoreCommand } from "./database";
import type { EnrollCommand } from "./enroll";
import type { InstallCommand } from "./install";
import type { ManagedStatusCommand } from "./manage-status";
import type { StartCommand } from "./start";
import { DEFAULT_START_TIMEOUT_MS } from "./start";
import { DEFAULT_HOST_PROTOCOL_PORT, type InstallMode } from "@volli/host-install/contract";
import type { OperatorTokenCommand } from "./operator-token";
import { DEFAULT_OPERATORS_FILE } from "./operators";

/** The account the packaged systemd unit runs hostd, and so every Session, as. */
export const DEFAULT_SERVICE_USER = "volli";

export const USAGE = `Usage:
  volli-hostd --data-dir <dir> [--socket <path>] [--operators <file>]
              [--listen <host>:<port>]             Serve this data directory.
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
  volli-hostd install --system|--user [--from <release>] [--port <n>] [--operator <login>]
                                                   Put this release in place under systemd:
                                                   a system unit as volli (root), or a
                                                   user unit as you. Idempotent; upgrades
                                                   and adopts. Does not start it.
  volli-hostd start --system|--user [--timeout <s>]
                                                   Run what install recorded; wait until
                                                   it serves.
  volli-hostd enroll --system|--user|--data-dir <dir> --public-key <spki> --name <label>
                                                   As hostd's account: trust a device key
                                                   (enrollment over SSH).
  volli-hostd status --json [--system|--user|--data-dir <dir>]
                                                   The install, unit, host and devices.
  volli-hostd --version | --help

The agent socket defaults to <dir>/volli.sock, mode 600. Under systemd socket
activation (LISTEN_FDS) hostd serves the socket the unit bound, and --socket
only names it. Point the volli CLI at it with VOLLI_SOCKET=<path>. The operators file defaults to ${DEFAULT_OPERATORS_FILE}
and must be root's; the service user defaults to ${DEFAULT_SERVICE_USER}.
VOLLI_SECRET_KEY_FILE names an absolute key file; VOLLI_HOSTD_LOG_LEVEL is
debug, info (default), warn or error.

install, start, enroll and status --json print one line of JSON; a failure
is {"ok":false,"code":…,"message":…}. Their contract: @volli/host-install.

With VOLLI_EXPERIMENTAL=cloud, --listen serves the host protocol's WebSocket
on a loopback address (127.0.0.1:<port>, [::1]:<port>); port 0 picks one, and
the status file names it. Until pairing lands it refuses every credential.
`;

export type HostdCommand =
  | {
      kind: "serve";
      dataDir: string;
      socketPath: string;
      operatorsFile: string;
      /** `--listen`: the host protocol's loopback address, or `null`. */
      listen: HostProtocolBind | null;
    }
  | { kind: "status"; dataDir: string }
  | CredentialsResetCommand
  | DatabaseRestoreCommand
  | OperatorTokenCommand
  | InstallCommand
  | StartCommand
  | EnrollCommand
  | ManagedStatusCommand
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
  const managed = managementCommand(verb, rest, values, cwd);
  if (managed !== null) return managed;
  if (MANAGEMENT_OPTIONS.some((name) => values[name] !== undefined)) {
    throw new HostdBootError(
      "usage",
      "--system, --user, --json, --port, --operator, --public-key, --name and --timeout belong to install, start, enroll and status --json.",
    );
  }
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
  if (verb !== undefined && values.listen !== undefined) {
    throw new HostdBootError("usage", `--listen belongs to serving, not to ${verb}.`);
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
  const listen = values.listen === undefined ? null : parseListen(values.listen);
  if (typeof listen === "string") throw new HostdBootError("usage", listen);
  return {
    kind: "serve",
    dataDir,
    socketPath,
    operatorsFile: operatorsFileFrom(values.operators, cwd),
    listen,
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

const MANAGEMENT_OPTIONS = [
  "system",
  "user",
  "json",
  "port",
  "operator",
  "public-key",
  "name",
  "timeout",
] as const;

type ParsedValues = ReturnType<typeof parse>["values"];

/** Which of `--system`, `--user` and `--data-dir` named where; refuses two. */
function where(
  values: ParsedValues,
  cwd: string,
): { mode: InstallMode | null; dataDir: string | null } {
  const dataDir = values["data-dir"] === undefined ? null : resolve(cwd, values["data-dir"]);
  const named = [values.system === true, values.user === true, dataDir !== null].filter(Boolean);
  if (named.length > 1) {
    throw new HostdBootError("usage", "Name one of --system, --user or --data-dir.");
  }
  return {
    mode: values.system === true ? "system" : values.user === true ? "user" : null,
    dataDir,
  };
}

/** Only the options `allowed` may be present, beyond the mode. */
function only(verb: string, values: ParsedValues, allowed: readonly string[]): void {
  const extra = Object.keys(values).find(
    (name) => !allowed.includes(name) && !["system", "user", "data-dir"].includes(name),
  );
  if (extra !== undefined)
    throw new HostdBootError("usage", `--${extra} does not belong to ${verb}.`);
}

function positiveInteger(value: string, flag: string, max: number): number {
  if (!/^[0-9]+$/u.test(value) || Number(value) < 1 || Number(value) > max) {
    throw new HostdBootError("usage", `${flag} takes a whole number from 1 to ${max}.`);
  }
  return Number(value);
}

/** install, start, enroll and `status --json`; `null` for any other verb. */
function managementCommand(
  verb: string | undefined,
  rest: readonly string[],
  values: ParsedValues,
  cwd: string,
): InstallCommand | StartCommand | EnrollCommand | ManagedStatusCommand | null {
  const json = verb === "status" && values.json === true;
  if (verb !== "install" && verb !== "start" && verb !== "enroll" && !json) return null;
  if (rest.length > 0) throw new HostdBootError("usage", `Unknown argument: ${rest[0]}`);
  const { mode, dataDir } = where(values, cwd);
  if (json) {
    only("status --json", values, ["json"]);
    return { kind: "status-json", mode, dataDir };
  }
  if (verb === "enroll") {
    only("enroll", values, ["public-key", "name"]);
    if (mode === null && dataDir === null) {
      throw new HostdBootError("usage", "enroll needs --system, --user or --data-dir <dir>.");
    }
    if (values["public-key"] === undefined || values["public-key"].length === 0) {
      throw new HostdBootError("usage", "enroll needs --public-key <base64url SPKI>.");
    }
    return {
      kind: "enroll",
      mode,
      dataDir,
      publicKey: values["public-key"],
      name: values.name ?? "",
    };
  }
  if (dataDir !== null || mode === null) {
    throw new HostdBootError("usage", `${verb} needs --system or --user.`);
  }
  if (verb === "start") {
    only("start", values, ["timeout"]);
    return {
      kind: "start",
      mode,
      timeoutMs:
        values.timeout === undefined
          ? DEFAULT_START_TIMEOUT_MS
          : positiveInteger(values.timeout, "--timeout", 3600) * 1000,
    };
  }
  only("install", values, ["from", "port", "operator"]);
  if (mode === "user" && values.operator !== undefined) {
    throw new HostdBootError(
      "usage",
      "--operator belongs to install --system: a user unit is yours.",
    );
  }
  return {
    kind: "install",
    mode,
    from: values.from === undefined ? null : resolve(cwd, values.from),
    port:
      values.port === undefined
        ? DEFAULT_HOST_PROTOCOL_PORT
        : positiveInteger(values.port, "--port", 65_535),
    operator: values.operator ?? null,
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
      listen: { type: "string" },
      for: { type: "string" },
      revoke: { type: "string" },
      "service-user": { type: "string" },
      yes: { type: "boolean" },
      from: { type: "string" },
      schema: { type: "string" },
      system: { type: "boolean" },
      user: { type: "boolean" },
      json: { type: "boolean" },
      port: { type: "string" },
      operator: { type: "string" },
      "public-key": { type: "string" },
      name: { type: "string" },
      timeout: { type: "string" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
}
