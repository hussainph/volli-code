/**
 * A command context for tests: output captured, the box's facts fixed, and
 * the `/runner/*` client real (host-core's, with its codecs) over a scripted
 * `fetch` that answers each path from `routes`.
 */
import { createRunnerLinkClient } from "@volli/host-core/cloud-runner";
import { RUNNER_HTTP_PATHS, type RunnerHostFacts } from "@volli/shared/cloud";

import type { CommandContext } from "../commands";
import type { RunnerStatus } from "../shell/runner-status";
import type { StatusProbes } from "../shell/status";

export type Route = (body: unknown) => { status?: number; body: unknown } | Promise<never>;

export interface TestContext extends CommandContext {
  readonly stdout: () => string;
  readonly stderr: () => string;
  /** Every request, in order: its path and body. */
  readonly requests: { path: string; body: unknown; siteUrl: string }[];
}

export const HOST: RunnerHostFacts = {
  hostname: "hetzner-1",
  platform: { os: "linux", distro: "debian 12", kernel: "6.1.0", arch: "x64", glibc: "2.36" },
  installMode: "user",
};

export const NOT_RUNNING: StatusProbes<RunnerStatus> = {
  read: () => null,
  alive: () => false,
  accepts: () => Promise.resolve(false),
};

export function testContext(options: {
  root: string;
  routes?: Partial<Record<keyof typeof RUNNER_HTTP_PATHS, Route>>;
  env?: Record<string, string>;
  signal?: AbortSignal;
  statusProbes?: StatusProbes<RunnerStatus>;
  buildDeployment?: CommandContext["buildDeployment"];
  now?: () => number;
}): TestContext {
  let stdout = "";
  let stderr = "";
  const requests: TestContext["requests"] = [];
  const byPath = new Map<string, Route | undefined>(
    Object.entries(RUNNER_HTTP_PATHS).map(([key, path]) => [
      path,
      options.routes?.[key as keyof typeof RUNNER_HTTP_PATHS],
    ]),
  );
  return {
    env: options.env ?? {},
    cwd: options.root,
    uid: 1000,
    home: options.root,
    version: "9.9.9-test",
    out: (text) => {
      stdout += text;
    },
    err: (text) => {
      stderr += text;
    },
    signal: options.signal ?? new AbortController().signal,
    linkClient: (siteUrl) =>
      createRunnerLinkClient({
        siteUrl,
        fetch: async (url, init) => {
          const path = new URL(url).pathname;
          const body = JSON.parse(String(init.body)) as unknown;
          requests.push({ path, body, siteUrl });
          const route = byPath.get(path);
          if (route === undefined) throw new Error(`no route for ${path}`);
          const answer = await route(body);
          return new Response(JSON.stringify(answer.body), {
            status: answer.status ?? 200,
            headers: { "content-type": "application/json" },
          });
        },
      }),
    hostFacts: (mode) => ({ ...HOST, installMode: mode }),
    buildDeployment:
      options.buildDeployment === undefined
        ? {
            url: "https://baked-deployment.convex.cloud",
            siteUrl: "https://baked-deployment.convex.site",
          }
        : options.buildDeployment,
    statusProbes: options.statusProbes ?? NOT_RUNNING,
    sleep: () => Promise.resolve(),
    ...(options.now === undefined ? {} : { now: options.now }),
    stdout: () => stdout,
    stderr: () => stderr,
    requests,
  };
}
