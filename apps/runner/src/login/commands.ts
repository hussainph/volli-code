import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { piSignIn, providerSignInMethods, type PiModelAccess } from "@volli/agent-runtime";
import { ModelAccessSignInService } from "@volli/host-core/session-runtime";

import type { CommandContext, CommandInput, RunnerCommand } from "../commands";
import { PATH_OPTIONS, PATH_USAGE, pathsFor, type RunnerPaths } from "../shell/paths";
import { runnerModelAccess, runnerModelKeyPath } from "./model-access";
import { renderLogin, type LoginTerminal } from "./renderer";
import { loginTerminal } from "./terminal";

export interface LoginPorts {
  models(paths: RunnerPaths, context: CommandContext): PiModelAccess;
  terminal(context: CommandContext): LoginTerminal;
  asServiceUser(
    command: string,
    input: CommandInput,
    paths: RunnerPaths,
    context: CommandContext,
  ): number;
}

const LIVE: LoginPorts = {
  models: (paths, context) => runnerModelAccess({ ...paths, env: context.env }),
  terminal: (context) => loginTerminal(context.err),
  asServiceUser,
};

export const loginCommand: RunnerCommand = {
  name: "login",
  summary: "Sign in on this runner. Keys are read without echo, from /dev/tty or stdin.",
  usage: `[provider] [--api-key] [--status] ${PATH_USAGE}`,
  positionals: 1,
  options: { "api-key": { type: "boolean" }, status: { type: "boolean" }, ...PATH_OPTIONS },
  run: (input, context) => runModelCommand("login", input, context),
};

export const logoutCommand: RunnerCommand = {
  name: "logout",
  summary: "Remove this runner's stored sign-in; ambient credentials are unchanged.",
  usage: `<provider> ${PATH_USAGE}`,
  positionals: 1,
  options: PATH_OPTIONS,
  run: (input, context) => runModelCommand("logout", input, context),
};

export async function runModelCommand(
  command: "login" | "logout",
  input: CommandInput,
  context: CommandContext,
  ports: LoginPorts = LIVE,
): Promise<number> {
  const providerId = input.positionals[0];
  if (
    (command === "logout" && providerId === undefined) ||
    (input.values["status"] === true && input.values["api-key"] === true)
  ) {
    context.err("Specify a provider for logout; --status cannot be combined with --api-key.\n");
    return 2;
  }
  const paths = pathsFor(input.values, {
    ...context,
    uid: context.env["VOLLI_RUNNER_INSTALL_MODE"] === "system" ? 0 : context.uid,
  });
  // Root must never create root-owned credentials or run a provider flow.
  if (context.uid === 0) return ports.asServiceUser(command, input, paths, context);
  try {
    const access = ports.models(paths, context);
    await access.catalogReady;
    const provider = providerId === undefined ? undefined : access.models.getProvider(providerId);
    if (providerId !== undefined && provider === undefined) {
      context.err("Unknown provider. Run `volli-runner login` to list provider ids.\n");
      return 2;
    }
    if (command === "login" && input.values["status"] === true) {
      const stored = await access.credentials.list();
      const shown =
        providerId === undefined ? stored : stored.filter((row) => row.providerId === providerId);
      for (const row of shown)
        context.out(
          `${row.providerId}: stored ${row.type === "api_key" ? "API key" : "OAuth sign-in"}\n`,
        );
      if (shown.length === 0) context.out("No stored model sign-ins.\n");
      return 0;
    }
    if (provider === undefined) {
      for (const row of access.models.getProviders()) {
        const methods = providerSignInMethods(row);
        if (methods.length > 0)
          context.out(`${row.id}: ${methods.map((method) => method.label).join(" / ")}\n`);
      }
      context.out("Run `volli-runner login <provider>`; add --api-key to store an API key.\n");
      return 0;
    }
    const pi = piSignIn(access.models, { deviceId: () => runnerDeviceId(paths.dataDir) });
    if (command === "logout") {
      const result = await new ModelAccessSignInService({ pi }).signOut(provider.id);
      if (!result.ok) {
        context.err(
          "Could not remove the stored sign-in. Check the runner's secret key and permissions.\n",
        );
        return 1;
      }
      context.out(
        `Removed stored sign-in for ${provider.id}. Ambient credentials are unchanged.\n`,
      );
      return 0;
    }
    const type =
      input.values["api-key"] === true || !pi.offers(provider.id, "oauth") ? "api-key" : "oauth";
    return await renderLogin(pi, provider.id, type, ports.terminal(context), context.signal);
  } catch {
    // No provider/SDK exception crosses the terminal boundary with credential bytes.
    context.err(
      "Model sign-in unavailable. Check the runner's secret key, permissions and provider setup.\n",
    );
    return 1;
  }
}

/** Root launches the exact same command as the service account, keeping stdin on the pipe/tty. */
export function asServiceUser(
  command: string,
  input: CommandInput,
  paths: RunnerPaths,
  context: CommandContext,
): number {
  const args = [
    "-u",
    "volli",
    "--",
    "env",
    "VOLLI_RUNNER_INSTALL_MODE=system",
    `VOLLI_SECRET_KEY_FILE=${runnerModelKeyPath({ ...paths, env: context.env })}`,
    process.execPath,
    process.argv[1]!,
    command,
    ...input.positionals,
    "--data-dir",
    paths.dataDir,
    "--config-dir",
    paths.configDir,
  ];
  if (input.values["api-key"] === true) args.push("--api-key");
  if (input.values["status"] === true) args.push("--status");
  const child = spawnSync("runuser", args, { stdio: "inherit" });
  if (child.error !== undefined)
    context.err(
      "Could not switch to the volli service user. Run login as that user with the service's data/config directories.\n",
    );
  return child.status ?? 1;
}

export function runnerDeviceId(dataDir: string): string {
  const path = join(dataDir, "model-device-id");
  try {
    writeFileSync(path, randomUUID(), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const id = readFileSync(path, "utf8");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id))
    throw new Error("Invalid model device id.");
  return id;
}
