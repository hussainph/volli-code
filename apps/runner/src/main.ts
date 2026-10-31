/**
 * `volli-runner`: the Volli runner for a Linux box. See README.md.
 *
 * The process edge only: argv through the command registry (`commands.ts`),
 * the live context (this process's environment and output, the `/runner/*`
 * HTTP client, this box's facts, the status probes), and the exit code. An
 * interrupt aborts a command that waits; a second one exits at once.
 */
import { homedir } from "node:os";

import { createRunnerLinkClient, runnerHostFacts } from "@volli/host-core/cloud-runner";

import { parseRunnerArgv, usage, UsageError } from "./args";
import { COMMANDS, type CommandContext } from "./commands";
import { BUILD_DEPLOYMENT } from "./link/deployment";
import { RUNNER_LIVE_PROBES } from "./shell/runner-status";
import { abortableSleep } from "./shell/sleep";
import { RUNNER_VERSION } from "./shell/version";

async function main(): Promise<number> {
  let parsed;
  try {
    parsed = parseRunnerArgv(process.argv.slice(2), COMMANDS);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`volli-runner: ${error.message}\n\n${usage(COMMANDS, null)}`);
    return 2;
  }
  if (parsed.kind === "help") {
    process.stdout.write(usage(COMMANDS, parsed.command));
    return 0;
  }
  const interrupt = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      if (interrupt.signal.aborted) process.exit(130);
      interrupt.abort();
    });
  }
  const context: CommandContext = {
    env: process.env,
    cwd: process.cwd(),
    uid: process.getuid!(),
    home: homedir(),
    version: RUNNER_VERSION,
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
    signal: interrupt.signal,
    linkClient: (siteUrl) => createRunnerLinkClient({ siteUrl }),
    hostFacts: (mode) => runnerHostFacts(mode),
    buildDeployment: BUILD_DEPLOYMENT,
    statusProbes: RUNNER_LIVE_PROBES,
    // The device code's wait ends early on an interrupt, so it stops at once.
    sleep: (ms) => abortableSleep(ms, interrupt.signal),
  };
  return parsed.command.run(parsed.input, context);
}

void main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`volli-runner: ${(error as Error).message}\n`);
    process.exit(1);
  },
);
