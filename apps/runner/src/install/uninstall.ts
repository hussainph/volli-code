import { existsSync, lstatSync, readlinkSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

import { createRunnerTokenSource } from "@volli/host-core/cloud-runner";

import type { CommandContext, CommandInput } from "../commands";
import { fileRunnerLinkStore, LINK_FILE_NAME, LINK_KEY_FILE_NAME } from "../link/file-store";
import { RUNNER } from "../shell/identity";
import { acquireInstanceLock } from "../shell/instance-lock";
import { pathsFor } from "../shell/paths";
import { UNIT, type InstallLayout } from "./layout";
import { asRunner, systemctl, type InstallPorts } from "./manage";
import { mustRun } from "./tools";
import { workAtRisk } from "./work";

/** Child-process seam: runs under the credential owner's uid, after the service stops. */
export async function revokeRunner(
  input: CommandInput,
  context: CommandContext,
  request: typeof fetch = fetch,
): Promise<number> {
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
          const response = await request(`${stored.deployment.url}/api/mutation`, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ path: "runners:unlinkSelf", args: {}, format: "json" }),
            signal: AbortSignal.timeout(15_000),
          });
          const body = (await response.json()) as { status?: string };
          if (!response.ok || body.status !== "success") throw new Error("unlink failed");
        }
      }
    } catch {
      context.err(
        "Could not remove this runner from Volli Cloud. Remove it in Volli → Settings → Runners.\n",
      );
    }
    await store.clear();
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
    for (const path of workAtRisk(layout.dataDir, ports.run))
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
    existsSync(layout.root) ||
    existsSync(unit) ||
    existsSync(join(layout.configDir, LINK_FILE_NAME));
  if (ports.systemd && existsSync(unit)) {
    mustRun(ports.run, "systemctl", systemctl(layout, ["disable", "--now", UNIT]));
  }
  if (existsSync(join(layout.configDir, LINK_FILE_NAME))) {
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
      ],
      true,
    );
  }
  // A foreground process is not stopped by systemctl: never delete beneath it.
  const lock = existsSync(layout.dataDir) ? acquireInstanceLock(RUNNER, layout.dataDir) : null;
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
    if (layout.mode === "system" && existsSync(join(layout.dataDir, "runner.lock"))) {
      mustRun(ports.run, "chown", ["volli:volli", join(layout.dataDir, "runner.lock")]);
    }
  }
  if (input.values.purge) {
    changed = existsSync(layout.dataDir) || existsSync(layout.configDir) || changed;
    rmSync(layout.dataDir, { recursive: true, force: true });
    rmSync(layout.configDir, { recursive: true, force: true });
    if (layout.mode === "system" && ports.run("id", ["-u", "volli"]).status === 0) {
      const home = mustRun(ports.run, "getent", ["passwd", "volli"]).stdout.trim().split(":")[5];
      if (home === layout.dataDir) mustRun(ports.run, "userdel", ["volli"]);
      else context.err("Kept the volli account: its home belongs to another installation.\n");
    }
  }
  context.out(`${JSON.stringify({ changed, keptData: !input.values.purge })}\n`);
  if (!input.values.purge)
    context.out(`Kept ${layout.dataDir} and encryption keys in ${layout.configDir}.\n`);
  return 0;
}
