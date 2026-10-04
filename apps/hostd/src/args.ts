/** `volli-hostd`'s command line. */
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { HostdBootError } from "./boot-error";

export const USAGE = `Usage:
  volli-hostd --data-dir <dir> [--socket <path>]   Serve this data directory.
  volli-hostd status --data-dir <dir>              Report health; exit 0 serving,
                                                   1 refusing, 3 not serving.
  volli-hostd --version | --help

The agent socket defaults to <dir>/volli.sock. Point the volli CLI at it with
VOLLI_SOCKET=<path>. VOLLI_SECRET_KEY_FILE names an absolute key file;
VOLLI_HOSTD_LOG_LEVEL is debug, info (default), warn or error.
`;

export type HostdCommand =
  | { kind: "serve"; dataDir: string; socketPath: string }
  | { kind: "status"; dataDir: string }
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
  if (rest.length > 0 || (verb !== undefined && verb !== "status")) {
    throw new HostdBootError("usage", `Unknown argument: ${verb === "status" ? rest[0] : verb}`);
  }
  if (values["data-dir"] === undefined || values["data-dir"].length === 0) {
    throw new HostdBootError("usage", "--data-dir <dir> is required.");
  }
  const dataDir = resolve(cwd, values["data-dir"]);
  if (verb === "status") {
    if (values.socket !== undefined) {
      throw new HostdBootError("usage", "status reads the socket path from the data directory.");
    }
    return { kind: "status", dataDir };
  }
  const socketPath =
    values.socket === undefined || values.socket.length === 0
      ? defaultSocketPath(dataDir)
      : resolve(cwd, values.socket);
  return { kind: "serve", dataDir, socketPath };
}

function parse(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: true,
    options: {
      "data-dir": { type: "string" },
      socket: { type: "string" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
}
