import { AGENT_ERROR_CODES } from "@volli/shared";
import type { AgentCommand, AgentError, AgentRequest, AgentResponse } from "@volli/shared";

import { AgentClientError } from "./client";
import { parseCliArgs } from "./parser";
import { exitCodeForError, renderCliError, renderCliSuccess } from "./render";
import { materializeFileArguments } from "./runtime";
import type { ReadTextFile } from "./runtime";

export interface RunCliDependencies {
  env: Readonly<Record<string, string | undefined>>;
  cwd: string;
  stdout(text: string): void;
  stderr(text: string): void;
  readText: ReadTextFile;
  request(socketPath: string, request: AgentRequest): Promise<AgentResponse>;
  launch(timeoutMs: number): Promise<{ alreadyRunning: boolean }>;
}

const EXIT_CLASS_LABEL = {
  1: "1 failure",
  2: "2 usage",
  3: "3 app unreachable (retryable)",
} as const;

/**
 * The fixed error-code vocabulary (decision 6), rendered from
 * {@link AGENT_ERROR_CODES} so `volli help exit-codes` can never drift from
 * the codes agent-commands.ts actually emits.
 */
function exitCodesHelpText(): string {
  const width = Math.max(...AGENT_ERROR_CODES.map((code) => code.length));
  const rows = AGENT_ERROR_CODES.map(
    (code) => `  ${code.padEnd(width)}  ${EXIT_CLASS_LABEL[exitCodeForError(code)]}`,
  );
  return (
    "Exit codes: 0 ok; 1 failure; 2 usage; 3 app unreachable (retryable).\n\n" +
    "Error codes:\n" +
    `${rows.join("\n")}\n`
  );
}

function helpText(topic: unknown): string {
  if (topic === "exit-codes") return exitCodesHelpText();
  if (topic === "json") return "Pass --json to any command for stable structured output.\n";
  if (topic === "addressing") {
    return "Context: explicit flags, then VOLLI_SESSION/VOLLI_TICKET, then cwd. Volli never guesses.\n";
  }
  if (topic === "orchestration") {
    return "Read before writing; work your own board unless instructed; do not chain-spawn agents.\n";
  }
  return "Usage: volli <command> [options]. Try: volli board, volli ticket show VC-12, volli help exit-codes.\n";
}

function clientError(error: unknown): AgentError {
  if (error instanceof AgentClientError) return { code: error.code, message: error.message };
  return {
    code: "MUTATION_FAILED",
    message: error instanceof Error ? error.message : String(error),
  };
}

function writeDegradedIdentify(json: boolean, dependencies: RunCliDependencies): void {
  dependencies.stdout(
    renderCliSuccess(
      "identify",
      {
        project: null,
        ticket: dependencies.env["VOLLI_TICKET"] ?? null,
        session: dependencies.env["VOLLI_SESSION"] ?? null,
        worktreePath: dependencies.cwd,
        socket: dependencies.env["VOLLI_SOCKET"] ?? null,
        appVersion: null,
        degraded: true,
      },
      { json },
    ),
  );
}

/** Runs one CLI invocation and returns its process exit code. */
export async function runCli(
  argv: readonly string[],
  dependencies: RunCliDependencies,
): Promise<0 | 1 | 2 | 3> {
  const parsed = parseCliArgs(argv);
  if (!parsed.ok) {
    dependencies.stderr(`error[USAGE] ${parsed.message}\n`);
    return 2;
  }
  if (parsed.invocation.command === "help") {
    const help = helpText(parsed.invocation.args["topic"]);
    dependencies.stdout(
      parsed.invocation.json ? `${JSON.stringify({ help: help.trimEnd() })}\n` : help,
    );
    return 0;
  }
  if (parsed.invocation.command === "app.launch") {
    try {
      const result = await dependencies.launch(
        typeof parsed.invocation.args["timeout"] === "number"
          ? parsed.invocation.args["timeout"] * 1000
          : 15_000,
      );
      dependencies.stdout(
        renderCliSuccess(
          "app.launch",
          { launched: !result.alreadyRunning, alreadyRunning: result.alreadyRunning },
          { json: parsed.invocation.json },
        ),
      );
      return 0;
    } catch (error) {
      const agentError = clientError(error);
      dependencies.stderr(renderCliError(agentError));
      return exitCodeForError(agentError.code);
    }
  }
  // The parser only emits published commands; local-only help/app launch were handled above.
  const command = parsed.invocation.command as AgentCommand;
  const socketPath = dependencies.env["VOLLI_SOCKET"];
  if (socketPath === undefined) {
    if (command === "identify") {
      writeDegradedIdentify(parsed.invocation.json, dependencies);
      return 0;
    }
    dependencies.stderr(
      renderCliError({
        code: "APP_UNREACHABLE",
        message: "VOLLI_SOCKET is not set. Run the CLI installed by Volli or open a Volli session.",
      }),
    );
    return 3;
  }
  try {
    const invocation = await materializeFileArguments(parsed.invocation, dependencies.readText);
    const request: AgentRequest = {
      v: 1,
      cmd: command,
      args: invocation.args,
      ctx: {
        cwd: dependencies.cwd,
        env: {
          ...(dependencies.env["VOLLI_SOCKET"] ? { socket: dependencies.env["VOLLI_SOCKET"] } : {}),
          ...(dependencies.env["VOLLI_SESSION"]
            ? { session: dependencies.env["VOLLI_SESSION"] }
            : {}),
          ...(dependencies.env["VOLLI_TICKET"] ? { ticket: dependencies.env["VOLLI_TICKET"] } : {}),
        },
      },
    };
    const response = await dependencies.request(socketPath, request);
    if (!response.ok) {
      dependencies.stderr(renderCliError(response.error));
      return exitCodeForError(response.error.code);
    }
    dependencies.stdout(
      renderCliSuccess(invocation.command, response.data, { json: invocation.json }),
    );
    return 0;
  } catch (error) {
    if (
      command === "identify" &&
      error instanceof AgentClientError &&
      error.code === "APP_UNREACHABLE"
    ) {
      writeDegradedIdentify(parsed.invocation.json, dependencies);
      return 0;
    }
    const agentError = clientError(error);
    dependencies.stderr(renderCliError(agentError));
    return exitCodeForError(agentError.code);
  }
}
