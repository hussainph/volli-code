/** `volli-runner`'s command line: argv to one entry of the command registry. */
import { parseArgs } from "node:util";

import type { CommandInput, OptionValue, RunnerCommand } from "./commands";

/** Exit code 2: the command line is wrong; the usage follows the message. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export type ParsedArgv =
  | { readonly kind: "help"; readonly command: RunnerCommand | null }
  | { readonly kind: "command"; readonly command: RunnerCommand; readonly input: CommandInput };

const HELP = new Set(["--help", "-h"]);

export function parseRunnerArgv(
  argv: readonly string[],
  commands: readonly RunnerCommand[],
): ParsedArgv {
  const find = (name: string): RunnerCommand => {
    const command = commands.find((entry) => entry.name === name);
    if (command === undefined) throw new UsageError(`Unknown command ${JSON.stringify(name)}.`);
    return command;
  };
  const [first, ...rest] = argv;
  if (first === undefined || HELP.has(first)) return { kind: "help", command: null };
  if (first === "help") {
    if (rest.length > 1) throw new UsageError("help takes at most one command.");
    return { kind: "help", command: rest[0] === undefined ? null : find(rest[0]) };
  }
  if (first === "--version" || first === "-v") {
    return { kind: "command", command: find("version"), input: { values: {}, positionals: [] } };
  }
  const command = find(first);
  if (rest.some((arg) => HELP.has(arg))) return { kind: "help", command };
  if (command.stub === true) {
    return { kind: "command", command, input: { values: {}, positionals: rest } };
  }
  let parsed;
  try {
    parsed = parseArgs({
      args: [...rest],
      options: command.options,
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  const allowed = command.positionals ?? 0;
  if (parsed.positionals.length > allowed) {
    throw new UsageError(
      `${command.name} takes ${allowed === 0 ? "no" : `at most ${allowed}`} positional ` +
        `argument${allowed === 1 ? "" : "s"}; got ${parsed.positionals.join(" ")}.`,
    );
  }
  return {
    kind: "command",
    command,
    input: {
      values: parsed.values as Readonly<Record<string, OptionValue>>,
      positionals: parsed.positionals,
    },
  };
}

/** `volli-runner --help`, or one command's help. */
export function usage(commands: readonly RunnerCommand[], command: RunnerCommand | null): string {
  if (command !== null) {
    return `Usage: volli-runner ${command.name}${command.usage === "" ? "" : ` ${command.usage}`}\n\n${command.summary}\n`;
  }
  const width = Math.max(...commands.map((entry) => entry.name.length));
  const lines = commands.map((entry) => `  ${entry.name.padEnd(width)}  ${entry.summary}`);
  return (
    "Usage: volli-runner <command> [options]\n\n" +
    `Commands:\n${lines.join("\n")}\n\n` +
    "Run `volli-runner help <command>` for a command's options.\n"
  );
}
