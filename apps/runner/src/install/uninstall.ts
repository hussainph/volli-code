import { existsSync, lstatSync, readdirSync, readlinkSync, rmdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

import { createCloudFunctionsClient, createRunnerTokenSource } from "@volli/host-core/cloud-runner";

import type { CommandContext, CommandInput } from "../commands";
import { fileRunnerLinkStore, LINK_FILE_NAME, LINK_KEY_FILE_NAME } from "../link/file-store";
import { RUNNER } from "../shell/identity";
import { acquireInstanceLock } from "../shell/instance-lock";
import { pathsFor } from "../shell/paths";
import { UNIT, type InstallLayout } from "./layout";
import { asRunner, systemctl, type InstallPorts } from "./manage";
import { mustRun } from "./tools";
import { workAtRisk } from "./work";
import { purgeOwnedTree } from "./purge";

/** Child-process seam: runs under the credential owner's uid, after the service stops. */
export async function revokeRunner(
  input: CommandInput,
  context: CommandContext,
  request: typeof fetch = fetch,
): Promise<number> {
  if (context.uid === 0)
    throw new Error("The credential helper must run as the service user, never root.");
  if (input.values.purge && !input.values.yes)
    throw new Error("The purge helper requires confirmed --yes.");
  const paths = pathsFor(input.values, context);
  const lock = existsSync(paths.dataDir) ? acquireInstanceLock(RUNNER, paths.dataDir) : null;
  try {
    const store = fileRunnerLinkStore({ configDir: paths.configDir });
    try {
      const stored = await store.read();
      if (stored !== null) {
        const source = createRunnerTokenSource({
          store,
          client: context.linkClient(stored.deployment.siteUrl),
        });
        const token = await source.token();
        if (token !== null) {
          const backend = createCloudFunctionsClient({
            url: stored.deployment.url,
            fetch: request,
            timeoutMs: 15_000,
          });
          await backend.call("mutation", "runners:unlinkSelf", {}, token);
        }
      }
    } catch {
      context.err(
        "Could not remove this runner from Volli Cloud. Remove it in Volli → Settings → Runners.\n",
      );
    }
    await store.clear();
    if (input.values.purge) {
      lock?.release();
      // Root never recursively traverses an agent-writable tree. The credential
      // owner empties it; root may only rmdir the now-empty managed directories.
      for (const path of [paths.dataDir, paths.configDir]) {
        if (existsSync(path)) {
          try {
            for (const name of readdirSync(path)) purgeOwnedTree(join(path, name));
          } catch {
            throw new Error(
              `Could not purge ${path}. Restore this service user's write access to the remaining contents, then rerun uninstall --purge.`,
            );
          }
        }
      }
    }
    return 0;
  } finally {
    lock?.release();
  }
}

export async function uninstallRunner(
  input: CommandInput,
  context: CommandContext,
  layout: InstallLayout,
  ports: InstallPorts,
): Promise<number> {
  if (input.values.purge && input.values["keep-data"])
    throw new Error("Choose --keep-data or --purge, not both.");
  if (ports.platform !== "linux") throw new Error("Managed uninstall requires Linux.");
  if (input.values.purge) {
    // Working copies are agent-controlled. Never interpret their git config as root.
    const probeGit: typeof ports.run = (command, args) =>
      layout.mode === "system"
        ? ports.run("runuser", ["-u", "volli", "--", command, ...args])
        : ports.run(command, args);
    for (const path of workAtRisk(layout.dataDir, probeGit))
      context.err(`Uncommitted, unpushed or unverifiable work: ${path}\n`);
    const warning = `Permanently delete working copies, local model logins and secrets under ${layout.dataDir} and ${layout.configDir}?`;
    if (!input.values.yes && !ports.confirmPurge(warning)) {
      context.err(
        "Purge cancelled. Back up your work, then confirm on the terminal or repeat with --purge --yes.\n",
      );
      return 2;
    }
  }
  // Never stop a service or unlink a CLI owned by another install.
  const cli = join(layout.binDir, "volli-runner");
  const cliStat = lstatSync(cli, { throwIfNoEntry: false });
  if (
    cliStat !== undefined &&
    (!cliStat.isSymbolicLink() ||
      resolve(layout.binDir, readlinkSync(cli)) !== join(layout.root, "current/bin/volli-runner"))
  ) {
    throw new Error(`${cli} is not this install's managed link; move it aside first.`);
  }
  const unit = join(layout.unitDir, UNIT);
  let changed =
    cliStat !== undefined ||
    existsSync(layout.root) ||
    existsSync(unit) ||
    existsSync(join(layout.configDir, LINK_FILE_NAME)) ||
    existsSync(join(layout.configDir, LINK_KEY_FILE_NAME));
  if (ports.systemd && existsSync(unit)) {
    mustRun(ports.run, "systemctl", systemctl(layout, ["disable", "--now", UNIT]));
  }
  const hasServiceAccount =
    layout.mode === "system" && ports.run("id", ["-u", "volli"]).status === 0;
  if (
    layout.mode === "system" &&
    !hasServiceAccount &&
    input.values.purge &&
    (existsSync(layout.dataDir) || existsSync(layout.configDir))
  ) {
    throw new Error(
      `The volli account is missing. Restore it with the data directory's original uid, then rerun uninstall --purge. Data is kept at ${layout.dataDir}.`,
    );
  }
  if (hasServiceAccount && input.values.purge) {
    const processes = ports.run("pgrep", ["-u", "volli"]).status;
    if (processes === 0)
      throw new Error(
        "Stop the remaining processes owned by volli, then rerun uninstall --purge. Data has not been purged.",
      );
    if (processes !== 1)
      throw new Error(
        "Could not check service processes. Install procps (pgrep), then rerun uninstall --purge.",
      );
  }
  if (
    (layout.mode === "user" && existsSync(join(layout.configDir, LINK_FILE_NAME))) ||
    (hasServiceAccount && (existsSync(layout.dataDir) || existsSync(layout.configDir)))
  ) {
    asRunner(
      layout,
      context,
      ports.run,
      [
        "uninstall",
        "--revoke-only",
        "--data-dir",
        layout.dataDir,
        "--config-dir",
        layout.configDir,
        ...(layout.mode === "system" && input.values.purge ? ["--purge", "--yes"] : []),
      ],
      true,
    );
  }
  if (
    layout.mode === "system" &&
    !hasServiceAccount &&
    existsSync(join(layout.configDir, LINK_FILE_NAME))
  ) {
    context.err(
      "The service account is missing; remote unlink was skipped. Remove this runner in Volli → Settings → Runners.\n",
    );
  }
  // A foreground process is not stopped by systemctl: never delete beneath it.
  const lock =
    layout.mode === "user" && existsSync(layout.dataDir)
      ? acquireInstanceLock(RUNNER, layout.dataDir)
      : null;
  try {
    for (const path of [unit, cli]) {
      // lstat also sees a dangling managed symlink after an interrupted uninstall.
      try {
        const stat = lstatSync(path);
        if (stat.isDirectory()) throw new Error(`${path} unexpectedly is a directory.`);
        rmSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (ports.systemd) mustRun(ports.run, "systemctl", systemctl(layout, ["daemon-reload"]));
    for (const file of [LINK_FILE_NAME, LINK_KEY_FILE_NAME])
      rmSync(join(layout.configDir, file), { force: true });
    rmSync(layout.root, { recursive: true, force: true });
  } finally {
    lock?.release();
  }
  if (input.values.purge) {
    let removeAccount = false;
    if (hasServiceAccount) {
      const home = mustRun(ports.run, "getent", ["passwd", "volli"]).stdout.trim().split(":")[5];
      if (home === layout.dataDir) {
        removeAccount = true;
      } else context.err("Kept the volli account: its home belongs to another installation.\n");
    }
    changed = existsSync(layout.dataDir) || existsSync(layout.configDir) || changed;
    for (const path of [layout.dataDir, layout.configDir]) {
      if (layout.mode === "system") {
        if (existsSync(path)) {
          try {
            rmdirSync(path);
          } catch {
            throw new Error(
              `Managed directory was not emptied: ${path}. Restore the service user's write access and rerun uninstall --purge.`,
            );
          }
        }
      } else if (existsSync(path)) purgeOwnedTree(path);
    }
    if (removeAccount) mustRun(ports.run, "userdel", ["volli"]);
  }
  context.out(`${JSON.stringify({ changed, keptData: !input.values.purge })}\n`);
  if (!input.values.purge)
    context.out(`Kept ${layout.dataDir} and encryption keys in ${layout.configDir}.\n`);
  return 0;
}
