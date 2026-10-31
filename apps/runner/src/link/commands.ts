/**
 * `volli-runner link` and `volli-runner unlink`.
 *
 *   volli-runner link [--token <vrt_…>] [--name <name>] [--server <url> [--site <url>]]
 *   volli-runner unlink
 *
 * **link** with an install token (`--token`, else `VOLLI_RUNNER_TOKEN`)
 * makes one request and saves the link; without one it prints a device
 * code to approve in Volli (Settings → Runners → Link a runner) and waits for
 * the answer, until the code expires or the command is interrupted. Both go
 * through host-core's `linkWithInstallToken` / `linkWithDeviceCode` against
 * the deployment `deployment.ts` resolves, and both save into the sealed file
 * (`file-store.ts`) with that deployment. A box that is already linked is
 * refused: `unlink` first, so a live runner is never orphaned by accident
 * (and the store itself refuses to replace one runner's link with
 * another's, should two `link`s race). `--name` names the runner for an
 * install token; a device code's name is chosen in Volli when it is approved.
 * It does not need the runner stopped: an unlinked runner holds no
 * credential to race.
 *
 * **unlink** forgets the link on this box only (the runner still shows in
 * Settings until it is removed there). It takes the data directory's
 * instance lock, so it refuses while the runner runs: a running runner
 * would write its next rotated credential straight back.
 */
import { existsSync } from "node:fs";

import {
  linkWithDeviceCode,
  linkWithInstallToken,
  RunnerHttpError,
} from "@volli/host-core/cloud-runner";

import type { CommandContext, CommandInput } from "../commands";
import type { BootError } from "../shell/boot-error";
import { RUNNER } from "../shell/identity";
import { acquireInstanceLock } from "../shell/instance-lock";
import { pathsFor, stringOption } from "../shell/paths";
import { resolveDeployment } from "./deployment";
import { fileRunnerLinkStore } from "./file-store";

/** What `status` says of the link on disk: never the credential. */
export type LinkOnDisk =
  | {
      readonly state: "linked";
      readonly runnerId: string;
      readonly name: string;
      readonly server: string;
    }
  | { readonly state: "unlinked" }
  | { readonly state: "unreadable"; readonly error: string };

export async function describeLinkOnDisk(configDir: string): Promise<LinkOnDisk> {
  try {
    const stored = await fileRunnerLinkStore({ configDir }).read();
    if (stored === null) return { state: "unlinked" };
    return {
      state: "linked",
      runnerId: stored.link.runnerId,
      name: stored.link.name,
      server: stored.deployment.url,
    };
  } catch (error) {
    return { state: "unreadable", error: (error as Error).message };
  }
}

export async function runLink(input: CommandInput, context: CommandContext): Promise<number> {
  const paths = pathsFor(input.values, context);
  const flag = (name: string): string | undefined => stringOption(input.values, name)?.trim();
  const usage = (message: string): number => {
    context.err(`volli-runner: ${message}\n`);
    return 2;
  };
  const token = flag("token") ?? nonEmpty(context.env["VOLLI_RUNNER_TOKEN"]);
  const name = flag("name");
  if (token === "") return usage("--token is empty.");
  if (name === "") return usage("--name is empty.");
  // A device code's name is the one the person picks in Volli when approving it.
  if (name !== undefined && token === undefined) return usage("--name needs --token.");
  let deployment;
  try {
    // The environment's site goes with the environment's server, never a flag's.
    const server = flag("server");
    deployment = resolveDeployment(
      server === undefined
        ? {
            server: nonEmpty(context.env["VOLLI_SERVER"]),
            site: flag("site") ?? nonEmpty(context.env["VOLLI_SERVER_SITE"]),
            baked: context.buildDeployment,
          }
        : { server, site: flag("site"), baked: context.buildDeployment },
    );
  } catch (error) {
    return usage((error as Error).message);
  }
  const store = fileRunnerLinkStore({ configDir: paths.configDir, deployment });
  let existing;
  try {
    existing = await store.read();
  } catch (error) {
    context.err(
      `volli-runner: ${(error as Error).message} ` +
        "Run `volli-runner unlink` to forget it, then link again.\n",
    );
    return 1;
  }
  if (existing !== null) {
    context.err(
      `volli-runner: this box is already linked as ${existing.link.name} ` +
        `(${existing.link.runnerId}) to ${existing.deployment.url}. ` +
        "Run `volli-runner unlink` first to link it again.\n",
    );
    return 1;
  }
  const client = context.linkClient(deployment.siteUrl);
  const host = context.hostFacts(paths.mode);
  try {
    if (token !== undefined) {
      const link = await linkWithInstallToken({
        client,
        store,
        host,
        installToken: token,
        name: name ?? null,
      });
      context.out(`Linked ${link.name} (${link.runnerId}) to ${deployment.url}.\n`);
      return 0;
    }
    const outcome = await linkWithDeviceCode({
      client,
      store,
      host,
      signal: context.signal,
      sleep: context.sleep,
      ...(context.now === undefined ? {} : { now: context.now }),
      showCode: (userCode) =>
        context.out(
          `To link this box, open Volli → Settings → Runners → Link a runner and enter:\n\n` +
            `    ${userCode}\n\nWaiting for approval…\n`,
        ),
    });
    if (outcome.status === "linked") {
      context.out(`Linked ${outcome.link.name} (${outcome.link.runnerId}) to ${deployment.url}.\n`);
      return 0;
    }
    context.err(`volli-runner: ${DEVICE_OUTCOMES[outcome.status]}\n`);
    // An interrupt exits as one does in a shell: 128 + SIGINT.
    return outcome.status === "cancelled" ? 130 : 1;
  } catch (error) {
    context.err(`volli-runner: could not link: ${linkFailure(error)}\n`);
    return 1;
  }
}

const DEVICE_OUTCOMES = {
  denied: "the link was declined in Volli.",
  expired: "the code expired before it was approved. Run `volli-runner link` again.",
  cancelled: "linking was cancelled.",
} as const;

function linkFailure(error: unknown): string {
  if (error instanceof RunnerHttpError) {
    return error.code === "unavailable"
      ? `the server could not be reached (${error.message}). Try again.`
      : `${error.message} (${error.code}).`;
  }
  return (error as Error).message;
}

export async function runUnlink(input: CommandInput, context: CommandContext): Promise<number> {
  const paths = pathsFor(input.values, context);
  // No data directory, no runner has ever run here to race.
  let lock = null;
  try {
    if (existsSync(paths.dataDir)) lock = acquireInstanceLock(RUNNER, paths.dataDir);
  } catch (error) {
    const message = (error as BootError).message;
    context.err(
      (error as BootError).reason === "already-running"
        ? `volli-runner: ${message} Stop it before unlinking.\n`
        : `volli-runner: ${message}\n`,
    );
    return 1;
  }
  try {
    const store = fileRunnerLinkStore({ configDir: paths.configDir });
    let stored;
    try {
      stored = await store.read();
    } catch {
      // A link this build cannot open is still forgotten: that is what was asked.
      stored = undefined;
    }
    await store.clear();
    context.out(
      stored === null
        ? "This box is not linked.\n"
        : `Forgot this box's link${stored === undefined ? "" : ` as ${stored.link.name} (${stored.link.runnerId})`}. ` +
            "Remove it in Volli → Settings → Runners as well.\n",
    );
    return 0;
  } finally {
    lock?.release();
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === "" ? undefined : value.trim();
}
