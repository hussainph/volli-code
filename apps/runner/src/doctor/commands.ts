/**
 * `volli-runner doctor [--json] [--data-dir <dir>] [--config-dir <dir>]`.
 *
 * The one command a person runs when a box will not take a Session: it checks
 * what a runner needs — the link, the platform, git, disk, systemd and linger,
 * the deployment, github.com and the model providers, the box's clock, and the
 * model sign-ins it has — and prints the single fix for each check that is not
 * met (`checks.ts`). Nothing it reports is a credential, and it never signs
 * anything in: a check it cannot make is `unknown`, with the command that
 * answers it.
 *
 * Exit 0 when no check failed, 1 when one did, so an installer or a CI lane
 * can gate on it. `--json` prints the same report for a script.
 */
import type { CommandContext, CommandInput, RunnerCommand } from "../commands";
import { PATH_OPTIONS, pathsFor, PATH_USAGE } from "../shell/paths";
import { doctorReport, installModeOf, runChecks } from "./checks";
import { LIVE_DOCTOR_PORTS, type DoctorPorts } from "./ports";
import { renderDoctor } from "./render";

/** The registry entry, over the live box. `commands.ts` imports this one. */
export const doctorCommand: RunnerCommand = doctorCommandWith(LIVE_DOCTOR_PORTS);

/**
 * The same command over given ports. A test drives a scripted box through it;
 * `doctorCommand` is the row the registry lists.
 */
export function doctorCommandWith(ports: DoctorPorts): RunnerCommand {
  return {
    name: "doctor",
    summary: "Check this box against what a runner needs, and print each fix.",
    usage: `${PATH_USAGE} [--json]`,
    options: { ...PATH_OPTIONS, json: { type: "boolean" } },
    run: (input, context) => runDoctor(input, context, ports),
  };
}

export async function runDoctor(
  input: CommandInput,
  context: CommandContext,
  ports: DoctorPorts,
): Promise<number> {
  const paths = pathsFor(input.values, context);
  // The unit states its mode; a nonroot service account still runs a system install.
  const host = context.hostFacts(installModeOf(context.env, paths.mode));
  const checks = await runChecks({ host, context, paths, ports });
  const report = doctorReport(host, checks);
  context.out(
    input.values["json"] === true ? `${JSON.stringify(report, null, 2)}\n` : renderDoctor(report),
  );
  return report.counts.fail > 0 ? 1 : 0;
}
