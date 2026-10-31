/**
 * `volli-runner status [--data-dir <dir>] [--config-dir <dir>]`: one JSON
 * report of the daemon (from its status file and liveness, `runner-status.ts`)
 * and of the link on disk (`link/file-store.ts`), which a stopped runner has
 * too. Exits with the daemon's verdict: 0 serving, 1 refusing, 3 not serving.
 */
import type { CommandContext, CommandInput } from "../commands";
import { describeLinkOnDisk } from "../link/commands";
import { pathsFor } from "./paths";
import { checkRunnerStatus } from "./runner-status";
import { statusExitCode } from "./status";

export async function runStatus(input: CommandInput, context: CommandContext): Promise<number> {
  const paths = pathsFor(input.values, context);
  const report = await checkRunnerStatus(paths.dataDir, context.statusProbes);
  const link = await describeLinkOnDisk(paths.configDir);
  context.out(`${JSON.stringify({ ...report, link }, null, 2)}\n`);
  return statusExitCode(report.verdict);
}
