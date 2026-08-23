import { existsSync } from "node:fs";

import {
  errorMessage,
  memoizedPathExists,
  requiredSessionEnvTools,
  SESSION_ENV_TOOLS,
  workspaceDependenciesStatus,
} from "@volli/shared";
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
  /** What this process sees of its own environment — `volli doctor`'s evidence. */
  observe(): Promise<Record<string, unknown>>;
  /**
   * Whether a path exists on disk — the degraded `identify` env block walks
   * the cwd for a package workspace. Optional because most callers have no
   * filesystem to script; defaults to the real one.
   */
  pathExists?(path: string): boolean;
}

function clientError(error: unknown): AgentError {
  if (error instanceof AgentClientError) return { code: error.code, message: error.message };
  return { code: "MUTATION_FAILED", message: errorMessage(error) };
}

/**
 * The degraded `identify` that answers without main. The CLI process lives in
 * the session environment, so the env block it reports is measured, not
 * synthesized — the same tool resolutions the doctor observation carries,
 * extracted here so the measured census is one list in one place. BOTH
 * provenance fields stay `null`: only main knows what its two adoption passes did, and a
 * CLI claiming either would be the plausible wrong answer this whole feature
 * exists to remove. `null` is not `pending` — one says nobody could ask, the
 * other says the app asked and has not finished.
 */
async function writeDegradedIdentify(
  json: boolean,
  dependencies: RunCliDependencies,
): Promise<void> {
  let observed: Record<string, unknown> = {};
  try {
    observed = await dependencies.observe();
  } catch {
    // A broken observation degrades to an env block of unknowns, never to a
    // failed identify — the one command that must answer without the app.
  }
  const observedResolved = (observed["resolved"] ?? {}) as Record<string, unknown>;
  const tools = {} as Record<string, string | null>;
  for (const tool of SESSION_ENV_TOOLS) {
    const resolved = observedResolved[tool];
    tools[tool] = typeof resolved === "string" ? resolved : null;
  }
  // Both workspace questions below walk the same ancestors; one memo makes
  // that one stat per path and one consistent moment.
  const pathExists = memoizedPathExists(dependencies.pathExists ?? existsSync);
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
        env: {
          path: dependencies.env["PATH"] ?? "",
          provenance: null,
          interactiveProvenance: null,
          tools,
          // Which of them this workspace actually implies — a disk question,
          // so the degraded block answers it as confidently as main does.
          requiredTools: requiredSessionEnvTools(dependencies.cwd, pathExists),
          dependencies: workspaceDependenciesStatus(dependencies.cwd, pathExists),
        },
        degraded: true,
      },
      { json },
    ),
  );
}

/**
 * The doctor observation, plus the one fact about the environment under test
 * that is not on `PATH`: which tools this workspace implies (VC-157). It
 * belongs on the caller's side of the doctor split for the same reason every
 * other measurement does — this process stands in the directory being audited,
 * and main reconstructing a workspace it cannot see is exactly the confident
 * wrong answer the command exists to avoid.
 */
async function doctorObservation(
  dependencies: RunCliDependencies,
): Promise<Record<string, unknown>> {
  return {
    ...(await dependencies.observe()),
    requiredTools: requiredSessionEnvTools(
      dependencies.cwd,
      memoizedPathExists(dependencies.pathExists ?? existsSync),
    ),
  };
}

/** The same arguments with the repair dropped — a re-check must not repair again. */
function omitFix(args: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...args };
  delete rest["fix"];
  return rest;
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
      await writeDegradedIdentify(parsed.invocation.json, dependencies);
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
    // `doctor` is the one command whose arguments are measurements rather than
    // intent: what this process can see from inside the environment under test,
    // which main has no way to observe and must not reconstruct.
    const args =
      command === "doctor"
        ? { ...invocation.args, ...(await doctorObservation(dependencies)) }
        : invocation.args;
    const request: AgentRequest = {
      v: 1,
      cmd: command,
      args,
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
    const first = await dependencies.request(socketPath, request);
    // `doctor --fix` is two requests, and it has to be. An observation is
    // measured before it is sent, so the one that travelled with the repair
    // request describes the world the repair was about to change — and main,
    // rendering the checks against it, tells a user who has just regenerated
    // the wrappers to go and regenerate the wrappers. The second request
    // measures again, now that they exist, and carries no `fix`, so nothing is
    // repaired twice and what gets printed is the world the repair left behind.
    let response = first;
    if (first.ok && command === "doctor" && invocation.args["fix"] === true) {
      // The second request carries the calling Session's fresh observation, but
      // the repair result exists only on the first. Preserve both facts: a
      // Session already running still reports its startup PATH, while main's
      // repair report names the PATH new Sessions will receive.
      const pathRepair = (first.data as { pathRepair?: unknown }).pathRepair;
      const rechecked = await dependencies.request(socketPath, {
        ...request,
        args: { ...omitFix(invocation.args), ...(await doctorObservation(dependencies)) },
      });
      response = rechecked.ok
        ? {
            ...rechecked,
            data: { ...(rechecked.data as Record<string, unknown>), pathRepair },
          }
        : rechecked;
    }
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
      await writeDegradedIdentify(parsed.invocation.json, dependencies);
      return 0;
    }
    const agentError = clientError(error);
    dependencies.stderr(renderCliError(agentError));
    return exitCodeForError(agentError.code);
  }
}
