/**
 * `volli-runner`'s command registry: every command the CLI answers, in the
 * order `--help` lists them.
 *
 * A command is one {@link RunnerCommand} entry: its name, a one-line
 * summary, its usage, the options `node:util`'s `parseArgs` accepts for it
 * (strictly: an unknown flag is a usage error), and `run`, which gets the
 * parsed input and the {@link CommandContext} (the process's environment,
 * output and live ports, which a test replaces). `args.ts` routes argv to an
 * entry; `main.ts` builds the live context and exits with what `run`
 * resolves.
 *
 * To add a command, replace its stub below with an entry from its own
 * module (`src/<area>/…`). A stub keeps the command table stable for
 * scripts and the installer: it answers {@link EXIT_UNAVAILABLE} and says the
 * command is not in this build.
 *
 * Exit codes: 0 done; 1 refused or failed; 2 usage; `status` 0 serving, 1
 * refusing, 3 not serving; 69 (sysexits' `EX_UNAVAILABLE`) a command this
 * build does not have yet.
 */
import type { ParseArgsOptionsConfig } from "node:util";

import type {
  ConvexClientModule,
  RunnerFetch,
  RunnerLinkClient,
} from "@volli/host-core/cloud-runner";
import type { RunnerHostFacts } from "@volli/shared/cloud";

import { runRun } from "./commands/run";
import { doctorCommand } from "./doctor/commands";
import { installCommand, uninstallCommand } from "./install/commands";
import { runGitCredential } from "./git/git-credential";
import { runLink, runUnlink } from "./link/commands";
import type { RunnerDeployment } from "./link/deployment";
import { loginCommand, logoutCommand } from "./login/commands";
import { PATH_OPTIONS, PATH_USAGE, type RunnerPaths } from "./shell/paths";
import type { RunnerStatus } from "./shell/runner-status";
import type { RunnerRuntimePaths } from "./shell/runtime-paths";
import type { ServiceProcess } from "./shell/service";
import type { StatusProbes } from "./shell/status";
import { runStatus } from "./shell/status-command";
import { UPDATE_COMMAND, type UpdateDeps } from "./update/command";

/** sysexits' `EX_UNAVAILABLE`: the command exists, and this build does not have it yet. */
export const EXIT_UNAVAILABLE = 69;

/** What `run` reaches beyond a command's ports: the daemon's process, log sink, bundle and backend. */
export interface RunnerDaemonPorts {
  /** Signals, uncaught failures and exit, for the shell's `runService`. */
  readonly process: ServiceProcess;
  /** Where the process log's JSON lines go (stdout, for the journal). */
  writeLog(line: string): void;
  /** Where this bundle's `volli` CLI and Code Mode's sandbox are. */
  runtimePaths(): RunnerRuntimePaths;
  /** `convex/browser`'s client and `convex/server`'s references, loaded only once linked. */
  convex(): Promise<ConvexClientModule>;
  /** The `/runner/*` client's fetch: the global one, unless a test scripts it. */
  readonly fetch?: RunnerFetch;
}

/** What a command may reach: the process, and the live ports a test replaces. */
export interface CommandContext {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly uid: number;
  readonly home: string;
  readonly version: string;
  out(text: string): void;
  err(text: string): void;
  /** Aborted on SIGINT/SIGTERM: a command that waits (the device code) stops. */
  readonly signal: AbortSignal;
  /** The `/runner/*` client for a deployment's site URL. */
  linkClient(siteUrl: string): RunnerLinkClient;
  /** What this box says about itself when it links. */
  hostFacts(mode: RunnerPaths["mode"]): RunnerHostFacts;
  /** The deployment this build was released against; `null` for a development build. */
  readonly buildDeployment: RunnerDeployment | null;
  readonly statusProbes: StatusProbes<RunnerStatus>;
  /** The device code's wait between polls; it ends early when `signal` aborts. */
  sleep(ms: number): Promise<void>;
  /** What `update apply` downloads, verifies, extracts, probes and restarts with. */
  readonly update: UpdateDeps;
  /** The whole of stdin, as UTF-8 (git's request to `git-credential`). */
  readStdin(): Promise<string>;
  readonly daemon: RunnerDaemonPorts;
  readonly now?: () => number;
}

export type OptionValue = string | boolean | undefined;

export interface CommandInput {
  readonly values: Readonly<Record<string, OptionValue>>;
  readonly positionals: readonly string[];
}

export interface RunnerCommand {
  readonly name: string;
  readonly summary: string;
  /** What follows `volli-runner <name>` on its usage line. */
  readonly usage: string;
  readonly options: ParseArgsOptionsConfig;
  /** How many positional arguments it takes; none by default. */
  readonly positionals?: number;
  /** A stub takes whatever it is given: it parses nothing. */
  readonly stub?: true;
  run(input: CommandInput, context: CommandContext): Promise<number>;
}

function stub(name: string, summary: string, usage = ""): RunnerCommand {
  return {
    name,
    summary,
    usage,
    options: {},
    stub: true,
    run: async (_input, context) => {
      context.err(`volli-runner: \`${name}\` is not available in this build yet.\n`);
      return EXIT_UNAVAILABLE;
    },
  };
}

export const COMMANDS: readonly RunnerCommand[] = [
  installCommand,
  uninstallCommand,
  {
    name: "link",
    summary: "Link this box to your Volli account: an install token, or a device code.",
    usage: `[--token <vrt_…>] [--name <name>] [--server <url> [--site <url>]] ${PATH_USAGE}`,
    options: {
      token: { type: "string" },
      name: { type: "string" },
      server: { type: "string" },
      site: { type: "string" },
      ...PATH_OPTIONS,
    },
    run: runLink,
  },
  {
    name: "unlink",
    summary: "Forget this box's link (stop the runner first).",
    usage: PATH_USAGE,
    options: PATH_OPTIONS,
    run: runUnlink,
  },
  {
    name: "run",
    summary: "Serve in the foreground until stopped (systemd runs this).",
    usage: PATH_USAGE,
    options: PATH_OPTIONS,
    run: runRun,
  },
  {
    name: "status",
    summary: "Report health as JSON; exit 0 serving, 1 refusing, 3 not serving.",
    usage: PATH_USAGE,
    options: PATH_OPTIONS,
    run: runStatus,
  },
  doctorCommand,
  loginCommand,
  logoutCommand,
  UPDATE_COMMAND,
  stub("logs", "Show the runner's log.", "[-f]"),
  {
    name: "git-credential",
    summary: "Volli's git credential helper, run by git; not for people.",
    usage: `${PATH_USAGE} <get|store|erase>`,
    options: PATH_OPTIONS,
    positionals: 1,
    run: runGitCredential,
  },
  {
    name: "version",
    summary: "Print this runner's version.",
    usage: "",
    options: {},
    run: async (_input, context) => {
      context.out(`${context.version}\n`);
      return 0;
    },
  },
];
