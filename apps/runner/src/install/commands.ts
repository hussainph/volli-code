import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { CommandContext, CommandInput, RunnerCommand } from "../commands";
import { PATH_OPTIONS } from "../shell/paths";
import { installLayout } from "./layout";
import { installRunner, type InstallPorts } from "./manage";
import { confirmPurge, runTool } from "./tools";
import { revokeRunner, uninstallRunner } from "./uninstall";

const modeOptions = { user: { type: "boolean" }, system: { type: "boolean" } } as const;

/** The live adapter is small; tests drive the same management functions with real temporary files. */
export function liveInstallPorts(): InstallPorts {
  return {
    run: runTool,
    platform: process.platform,
    systemd: existsSync("/run/systemd/system"),
    systemInstallPresent: existsSync("/etc/systemd/system/volli-runner.service"),
    ownRelease: resolve(dirname(process.execPath), ".."),
    confirmPurge,
  };
}

export async function runManagedCommand(
  kind: "install" | "uninstall",
  input: CommandInput,
  context: CommandContext,
  ports: InstallPorts = liveInstallPorts(),
): Promise<number> {
  try {
    if (kind === "uninstall" && input.values["revoke-only"])
      return await revokeRunner(input, context);
    if (input.values["data-dir"] !== undefined || input.values["config-dir"] !== undefined) {
      throw new Error(
        "Managed uninstall uses the installed layout, not --data-dir or --config-dir.",
      );
    }
    const layout = installLayout(input, context);
    return await (kind === "install"
      ? installRunner(input, context, layout, ports)
      : uninstallRunner(input, context, layout, ports));
  } catch (error) {
    context.err(`volli-runner: ${(error as Error).message}\n`);
    return 1;
  }
}

export const installCommand: RunnerCommand = {
  name: "install",
  summary: "Install this Linux release, link it, and start it under systemd.",
  usage:
    "[--user|--system] [--from <release>] [--token <token>] [--name <name>] [--server <url>] [--channel stable|canary] [--no-start] [--no-link]",
  options: {
    ...modeOptions,
    from: { type: "string" },
    token: { type: "string" },
    name: { type: "string" },
    server: { type: "string" },
    site: { type: "string" },
    channel: { type: "string" },
    version: { type: "string" },
    "no-start": { type: "boolean" },
    "no-link": { type: "boolean" },
  },
  run: (input, context) => runManagedCommand("install", input, context),
};

export const uninstallCommand: RunnerCommand = {
  name: "uninstall",
  summary: "Remove the runner; keep working copies and encryption keys unless --purge --yes.",
  usage: "[--user|--system] [--keep-data|--purge] [--yes]",
  options: {
    ...modeOptions,
    "keep-data": { type: "boolean" },
    purge: { type: "boolean" },
    yes: { type: "boolean" },
    // Credential-owner child only: no deletion, and no credential on stdout or argv.
    "revoke-only": { type: "boolean" },
    ...PATH_OPTIONS,
  },
  run: (input, context) => runManagedCommand("uninstall", input, context),
};
