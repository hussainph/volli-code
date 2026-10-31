/**
 * `volli-runner update`:
 *
 * - `update`: what this install is running, what is staged, and the last
 *   outcome, as JSON.
 * - `update --now [--to <version>]`: ask the running daemon to update now, to
 *   Volli's target or to `<version>`: it stages, drains for at most 30
 *   minutes and restarts on the new release. Writes the install root, so a
 *   system install needs sudo.
 * - `update apply`: the update unit's entry (`volli-runner-update.service`):
 *   act on the daemon's request once (`apply.ts`). Not for people.
 */
import { join, resolve } from "node:path";

import type { CommandContext, CommandInput, RunnerCommand } from "../commands";
import { PATH_OPTIONS, pathsFor, stringOption } from "../shell/paths";
import { applyUpdate, currentVersion, type ApplyPorts } from "./apply";
import { readUpdateConfig, type UpdateConfig } from "./config";
import { readDaemonStatus, readUpdaterState, writeNowRequest } from "./files";
import { defaultInstallRoot, RUNNER_UNIT, updateLayout, type UpdateLayout } from "./layout";
import { isReleaseVersion } from "./manifest";
import type { ProvenanceVerifier } from "./provenance";

/** What `update apply` reaches beyond the files: the live ones are `live.ts`'s, wired in `main.ts`. */
export interface UpdateDeps {
  readonly arch: string;
  fetchText: ApplyPorts["fetchText"];
  download: ApplyPorts["download"];
  extract: ApplyPorts["extract"];
  probe: ApplyPorts["probe"];
  restart(mode: UpdateLayout["mode"], unit: string): Promise<void>;
  provenance(cachePath: string): ProvenanceVerifier;
}

function layoutFor(input: CommandInput, context: CommandContext): UpdateLayout {
  const paths = pathsFor(input.values, context);
  const root = stringOption(input.values, "install-root");
  return updateLayout(
    paths.mode,
    root === undefined
      ? defaultInstallRoot(paths.mode, context.home, context.env)
      : resolve(context.cwd, root),
    paths.dataDir,
  );
}

function config(layout: UpdateLayout, context: CommandContext): UpdateConfig | null {
  try {
    return readUpdateConfig(layout);
  } catch (error) {
    context.err(`volli-runner: ${(error as Error).message}\n`);
    return null;
  }
}

async function apply(layout: UpdateLayout, context: CommandContext): Promise<number> {
  const settings = config(layout, context);
  if (settings === null) return 1;
  const deps = context.update;
  const clock = context.now ?? Date.now;
  const ports: ApplyPorts = {
    arch: deps.arch,
    fetchText: deps.fetchText,
    download: deps.download,
    provenance:
      settings.provenance === "required" ? deps.provenance(join(layout.cacheDir, "tuf")) : null,
    extract: deps.extract,
    probe: deps.probe,
    restart: () => deps.restart(layout.mode, RUNNER_UNIT),
    readStatus: () => readDaemonStatus(layout.dataDir),
    alive: (pid) => context.statusProbes.alive(pid),
    now: () => new Date(clock()),
    sleep: (ms) => context.sleep(ms),
    log: (line) => context.err(`volli-runner update: ${line}\n`),
  };
  const result = await applyUpdate(ports, { layout, origins: [settings.releaseOrigin] });
  context.out(`${JSON.stringify(result)}\n`);
  return result.kind === "idle" || result.kind === "staged" || result.kind === "applied" ? 0 : 1;
}

function show(layout: UpdateLayout, context: CommandContext): number {
  const settings = config(layout, context);
  if (settings === null) return 1;
  let state;
  try {
    state = readUpdaterState(layout.stateFile);
  } catch (error) {
    context.err(`volli-runner: ${(error as Error).message}\n`);
    return 1;
  }
  const report = {
    version: context.version,
    installRoot: layout.installRoot,
    current: currentVersion(layout),
    staged: state.staged,
    previous: state.previous,
    bad: state.bad,
    lastOutcome: state.outcomes.at(-1) ?? null,
    releaseOrigin: settings.releaseOrigin,
    provenance: settings.provenance,
  };
  context.out(`${JSON.stringify(report, null, 2)}\n`);
  return 0;
}

function now(input: CommandInput, layout: UpdateLayout, context: CommandContext): number {
  const to = stringOption(input.values, "to") ?? null;
  if (to !== null && !isReleaseVersion(to)) {
    context.err(
      `volli-runner: --to takes a release version like 0.3.1, not ${JSON.stringify(to)}.\n`,
    );
    return 2;
  }
  if (currentVersion(layout) === null) {
    context.err(
      `volli-runner: no installed runner at ${layout.installRoot}; updates need a runner \`install\` put in place.\n`,
    );
    return 1;
  }
  try {
    writeNowRequest(layout.nowFile, to, new Date((context.now ?? Date.now)()));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    context.err(
      code === "EACCES" || code === "EPERM"
        ? `volli-runner: ${layout.installRoot} is root's; run this with sudo.\n`
        : `volli-runner: ${(error as Error).message}\n`,
    );
    return 1;
  }
  context.out(
    `Asked the runner to update to ${to ?? "Volli's release"} now. It finishes running turns ` +
      "(30 minutes at most), restarts on the new release, and rolls back if that release " +
      "does not come online. `volli-runner update` shows how it went.\n",
  );
  return 0;
}

export const UPDATE_COMMAND: RunnerCommand = {
  name: "update",
  summary: "Update now (--now, --to <version>), or show the update state.",
  usage:
    "[--now] [--to <version>] [--install-root <dir>] [--data-dir <dir>] [--config-dir <dir>] | apply",
  options: {
    now: { type: "boolean" },
    to: { type: "string" },
    "install-root": { type: "string" },
    ...PATH_OPTIONS,
  },
  positionals: 1,
  run: async (input, context) => {
    const layout = layoutFor(input, context);
    const [verb] = input.positionals;
    if (verb === "apply") return apply(layout, context);
    if (verb !== undefined) {
      context.err(
        `volli-runner: update takes \`apply\` or no argument, not ${JSON.stringify(verb)}.\n`,
      );
      return 2;
    }
    if (input.values.now === true || input.values.to !== undefined)
      return now(input, layout, context);
    return show(layout, context);
  },
};
