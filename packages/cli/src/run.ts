import { existsSync } from "node:fs";

import {
  declaredPreviewContract,
  errorMessage,
  isAgentMutationPlan,
  makeAgentError,
  memoizedPathExists,
  MUTATION_PLAN_CONTRACT,
  verbEntry,
  requiredSessionEnvTools,
  SESSION_ENV_TOOLS,
  workspaceDependenciesStatus,
} from "@volli/shared";
import type {
  AgentCommand,
  AgentError,
  AgentHelpRuntime,
  AgentHelpSurface,
  AgentRequest,
  AgentResponse,
} from "@volli/shared";

import { agentRequestEnv, AgentClientError } from "./client";
import { bareHelpText, resolveHelp } from "./help";
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
  /** Bounded optional read used only to enrich otherwise-local help. */
  helpRequest?(socketPath: string, request: AgentRequest): Promise<AgentResponse>;
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
  if (error instanceof AgentClientError) return makeAgentError(error.code, error.message);
  return makeAgentError("MUTATION_FAILED", errorMessage(error));
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
          requiredTools: requiredSessionEnvTools(dependencies.cwd, dependencies.cwd, pathExists),
          dependencies: workspaceDependenciesStatus(dependencies.cwd, dependencies.cwd, pathExists),
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

/**
 * Why a `dryRun` request may not be sent yet, or null when it is safe. An app
 * that predates the preview contract ignores the unknown argument and executes
 * the real write — the one outcome a preview promises can never happen — so
 * the CLI confirms the running build declares the contract before sending. The
 * preflight is fail-closed: an unreadable or silent `identify` refuses the
 * preview rather than gambling a durable write on it.
 *
 * It asks the capability question only. A context-shaped `identify` resolves a
 * Project and Session, so `volli notify --dry-run` run from an unregistered
 * directory would be refused with PROJECT_REQUIRED while the same command
 * without `--dry-run` succeeded — a confident refusal about something the verb
 * never needed. `capabilities` opts out of that resolution; an older app that
 * ignores the argument answers a context identify with no `previewContract`,
 * so opting out costs nothing that keeps the gate closed.
 */
async function previewContractRefusal(
  socketPath: string,
  request: AgentRequest,
  dependencies: RunCliDependencies,
): Promise<AgentError | null> {
  const response = await dependencies.request(socketPath, {
    v: 1,
    cmd: "identify",
    args: { capabilities: true },
    ctx: request.ctx,
  });
  if (!response.ok) return response.error;
  if ((declaredPreviewContract(response.data) ?? 0) >= MUTATION_PLAN_CONTRACT) return null;
  const data =
    typeof response.data === "object" && response.data !== null
      ? (response.data as Record<string, unknown>)
      : {};
  const appVersion = typeof data["appVersion"] === "string" ? ` ${data["appVersion"]}` : "";
  return makeAgentError(
    "SOCKET_PROTOCOL",
    `The running app${appVersion} does not declare the side-effect preview contract, so --dry-run was refused before an older build could execute it as a real write.`,
  );
}

function parsedHelpSurface(value: unknown, sessionId: string): AgentHelpSurface | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const surface = value as Record<string, unknown>;
  const role = surface["role"];
  const tools = surface["tools"];
  if (
    (role !== "project" && role !== "ticket" && role !== "subagent") ||
    !Array.isArray(tools) ||
    !tools.every((tool) => typeof tool === "string")
  ) {
    return null;
  }
  return { sessionId, role, tools };
}

/**
 * Optional read for role-aware help and the running app version. Every failure
 * degrades to static help; it never turns discovery into an app dependency.
 */
async function readHelpRuntime(dependencies: RunCliDependencies): Promise<AgentHelpRuntime> {
  const socketPath = dependencies.env["VOLLI_SOCKET"];
  const sessionId = dependencies.env["VOLLI_SESSION"];
  if (socketPath === undefined) {
    return {
      appVersion: null,
      surface: null,
      surfaceUnknownReason:
        sessionId === undefined
          ? null
          : "VOLLI_SOCKET is absent, so the frozen Agent Tool Surface cannot be read",
    };
  }
  const request: AgentRequest = {
    v: 1,
    cmd: "identify",
    // The one caller that wants the frozen Agent Tool Surface asks for it, so
    // plain `volli identify` never pays to fold a Session ledger it will not read.
    args: { agentSurface: true },
    ctx: {
      cwd: dependencies.cwd,
      // The socket path and Session id are stated rather than read: both were
      // resolved above through this function's own fallbacks.
      env: agentRequestEnv(dependencies.env, {
        socket: socketPath,
        ...(sessionId === undefined ? {} : { session: sessionId }),
      }),
    },
  };
  try {
    const response = await (dependencies.helpRequest ?? dependencies.request)(socketPath, request);
    if (!response.ok) {
      return {
        appVersion: null,
        surface: null,
        surfaceUnknownReason:
          sessionId === undefined
            ? null
            : `${response.error.code}: ${response.error.reason ?? response.error.message}`,
      };
    }
    const data =
      typeof response.data === "object" && response.data !== null && !Array.isArray(response.data)
        ? (response.data as Record<string, unknown>)
        : {};
    const appVersion = typeof data["appVersion"] === "string" ? data["appVersion"] : null;
    const surface =
      sessionId === undefined ? null : parsedHelpSurface(data["agentSurface"], sessionId);
    return {
      appVersion,
      surface,
      surfaceUnknownReason:
        sessionId === undefined || surface !== null
          ? null
          : "the running app did not return this Session's frozen Agent Tool Surface",
    };
  } catch (error) {
    return {
      appVersion: null,
      surface: null,
      surfaceUnknownReason:
        sessionId === undefined ? null : `the optional app read failed: ${errorMessage(error)}`,
    };
  }
}

export function teachingErrorForParseResult(
  parsed: Extract<ReturnType<typeof parseCliArgs>, { ok: false }>,
  runtime: AgentHelpRuntime | null,
  lookup: typeof verbEntry = verbEntry,
): AgentError {
  if (parsed.code !== "WRONG_DOOR" || parsed.verb === undefined) {
    return makeAgentError(parsed.code, parsed.message);
  }
  const entry = lookup(parsed.verb);
  if (entry === undefined || !entry.accessModes.includes("tool")) {
    return makeAgentError(parsed.code, parsed.message);
  }
  if (runtime?.surface !== null && runtime?.surface !== undefined) {
    const carried = runtime.surface.tools.includes(entry.key);
    const roleReason = carried
      ? ` This ${runtime.surface.role} Session's frozen tool surface carries ${entry.key}.`
      : ` This ${runtime.surface.role} Session's frozen tool surface does not carry ${entry.key}.`;
    const next = carried
      ? `Call the named ${entry.key} tool through this Session's Agent Tool Surface.`
      : `Use a Session whose frozen Agent Tool Surface carries ${entry.key}; do not bypass the refusal through process or database workarounds.`;
    return makeAgentError("WRONG_DOOR", `${parsed.message}${roleReason}`, next);
  }
  const unknown = runtime?.surfaceUnknownReason;
  return makeAgentError(
    "WRONG_DOOR",
    `${parsed.message} Tool availability is unknown${unknown ? ` because ${unknown}` : " outside a resolved Session"}.`,
  );
}

/**
 * Renders one parse refusal. A wrong door onto a TOOL alone pays for the
 * optional Role read, because it is the one refusal whose teaching depends on
 * live facts — whether this Session's frozen Agent Tool Surface carries the
 * verb. Every other parse error stays local and instant.
 *
 * The tool test is not a micro-optimization; it is what keeps the round-trip
 * honest. VC-163 introduced the first verb on NO agent surface
 * (`ticket.archive`), and for that one there is no bundle membership to report:
 * `teachingErrorForParseResult` returns before it looks at the runtime, so
 * reading one would be spending a socket call to answer a question the refusal
 * does not ask.
 */
export async function renderParseRefusal(
  parsed: Extract<ReturnType<typeof parseCliArgs>, { ok: false }>,
  argv: readonly string[],
  dependencies: RunCliDependencies,
): Promise<0 | 1 | 2 | 3> {
  const teachableByRole =
    parsed.code === "WRONG_DOOR" &&
    parsed.verb !== undefined &&
    verbEntry(parsed.verb)?.accessModes.includes("tool") === true;
  const runtime = teachableByRole ? await readHelpRuntime(dependencies) : null;
  const error = teachingErrorForParseResult(parsed, runtime);
  dependencies.stderr(renderCliError(error, { json: argv.includes("--json") }));
  return exitCodeForError(error.code);
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
  if (!parsed.ok) return renderParseRefusal(parsed, argv, dependencies);
  if (parsed.invocation.command === "help") {
    const runtime = await readHelpRuntime(dependencies);
    const resolved = resolveHelp(parsed.invocation.args["path"] as string[], undefined, {
      runtime,
    });
    if (!resolved.ok) {
      dependencies.stderr(renderCliError(resolved.error, { json: parsed.invocation.json }));
      return exitCodeForError(resolved.error.code);
    }
    dependencies.stdout(
      parsed.invocation.json
        ? `${JSON.stringify({ help: resolved.text.trimEnd() })}\n`
        : resolved.text,
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
      dependencies.stderr(renderCliError(agentError, { json: parsed.invocation.json }));
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
      renderCliError(
        makeAgentError(
          "APP_UNREACHABLE",
          "VOLLI_SOCKET is not set, so this command cannot reach the Volli app.",
          "Run `volli app launch` from a Volli-installed shell or open a Volli Session, then retry once.",
        ),
        { json: parsed.invocation.json },
      ),
    );
    return 3;
  }
  try {
    const invocation = await materializeFileArguments(parsed.invocation, dependencies.readText);
    // `doctor` is the one command whose arguments are measurements rather than
    // intent: what this process can see from inside the environment under test,
    // which main has no way to observe and must not reconstruct.
    const args =
      command === "doctor" && invocation.args["dryRun"] !== true
        ? { ...invocation.args, ...(await doctorObservation(dependencies)) }
        : invocation.args;
    const request: AgentRequest = {
      v: 1,
      cmd: command,
      args,
      ctx: { cwd: dependencies.cwd, env: agentRequestEnv(dependencies.env) },
    };
    if (args["dryRun"] === true) {
      const refusal = await previewContractRefusal(socketPath, request, dependencies);
      if (refusal !== null) {
        dependencies.stderr(renderCliError(refusal, { json: invocation.json }));
        return exitCodeForError(refusal.code);
      }
    }
    const first = await dependencies.request(socketPath, request);
    // `doctor --fix` is two requests, and it has to be. An observation is
    // measured before it is sent, so the one that travelled with the repair
    // request describes the world the repair was about to change — and main,
    // rendering the checks against it, tells a user who has just regenerated
    // the wrappers to go and regenerate the wrappers. The second request
    // measures again, now that they exist, and carries no `fix`, so nothing is
    // repaired twice and what gets printed is the world the repair left behind.
    let response = first;
    if (
      first.ok &&
      command === "doctor" &&
      invocation.args["fix"] === true &&
      invocation.args["dryRun"] !== true
    ) {
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
      dependencies.stderr(renderCliError(response.error, { json: invocation.json }));
      return exitCodeForError(response.error.code);
    }
    // Belt and braces behind the preflight: a preview that came back as
    // anything but the shared plan means the app may have run the real write,
    // and rendering it as a success would launder that into a preview.
    if (args["dryRun"] === true && !isAgentMutationPlan(response.data)) {
      const error = makeAgentError(
        "SOCKET_PROTOCOL",
        `The app answered a --dry-run ${command} without the shared preview plan, so durable state may have changed despite the preview intent.`,
        null,
      );
      dependencies.stderr(renderCliError(error, { json: invocation.json }));
      return exitCodeForError(error.code);
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
    dependencies.stderr(renderCliError(agentError, { json: parsed.invocation.json }));
    return exitCodeForError(agentError.code);
  }
}
