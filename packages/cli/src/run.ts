import { errorMessage } from "@volli/shared";
import type { AgentCommand, AgentError, AgentRequest, AgentResponse } from "@volli/shared";

import { AgentClientError } from "./client";
import { bareHelpText, renderHelp } from "./help";
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

function clientError(error: unknown): AgentError {
  if (error instanceof AgentClientError) return { code: error.code, message: error.message };
  return { code: "MUTATION_FAILED", message: errorMessage(error) };
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
  // Bare `volli` prints the complete reference to stderr and exits 2 (usage),
  // so an agent that ran the CLI with no arguments learns the whole surface.
  if (argv.length === 0) {
    dependencies.stderr(bareHelpText());
    return 2;
  }
  const parsed = parseCliArgs(argv);
  if (!parsed.ok) {
    dependencies.stderr(renderCliError({ code: "USAGE", message: parsed.message }));
    return 2;
  }
  if (parsed.invocation.command === "help") {
    // The parser always supplies `path` as a string array for the help command.
    const help = renderHelp(parsed.invocation.args["path"] as string[]);
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
