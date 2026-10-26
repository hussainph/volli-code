/**
 * `convex deploy` with the deployment self-check around it; `deploy.mjs` runs
 * it with the pinned CLI (`pnpm -C convex deploy:checked`).
 *
 * 1. Before the push, refuses a target that sets `VOLLI_TEST_JWKS`: the auth
 *    config is evaluated at push time, so pushing would trust the test issuer.
 *    `convex env get` prints a set value on stdout (captured and discarded,
 *    never printed) and an unset one as a notice on stderr, exiting 0 both
 *    ways; any other exit means it could not tell, and nothing is pushed.
 * 2. Pushes `functions/`, codegen off: `_generated/` is committed and CI holds
 *    it equal to the source.
 * 3. Runs `health:deploymentChecks` on the same target and fails when it
 *    refuses. The new code is live by then: fix what it names and re-run.
 *
 * All three commands get the same environment and no flags of the caller's,
 * so they cannot select different deployments. The target is one of:
 *
 * - a `prod:` or `dev:` deploy key (`CONVEX_DEPLOY_KEY`), which names one
 *   deployment (a preview key would let `deploy` create one `run` never sees);
 * - a self-hosted backend (`CONVEX_SELF_HOSTED_URL` + `_ADMIN_KEY`).
 *
 * Only a key's kind prefix is read. The other selectors are blanked, so an env
 * file cannot fill them back in. `--test` runs the test check, and only
 * against a loopback self-hosted backend; the deployment refuses it elsewhere too.
 */

import { isLoopbackUrl } from "../functions/lib/deploymentChecks.ts";

/** Runs the pinned `convex` CLI; `capture` collects stdout instead of printing it. */
export type ConvexCli = (
  args: string[],
  env: NodeJS.ProcessEnv,
  capture: boolean,
) => Promise<{ code: number; stdout: string }>;

const filled = (value: string | undefined) => (value ?? "").trim() !== "";

/** The exit code: 0 deployed and checked, 2 a usage or target error, else the failing step's. */
export async function deployChecked(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  cli: ConvexCli,
  log: (line: string) => void,
): Promise<number> {
  if (argv.length > 1 || (argv.length === 1 && argv[0] !== "--test")) {
    log("usage: deploy.mjs [--test]  (the target comes from the environment)");
    return 2;
  }
  const mode = argv.length === 1 ? "test" : "cloud";
  const deployKey = env["CONVEX_DEPLOY_KEY"] ?? "";
  const selfHosted =
    filled(env["CONVEX_SELF_HOSTED_URL"]) && filled(env["CONVEX_SELF_HOSTED_ADMIN_KEY"]);
  if (filled(deployKey) === selfHosted) {
    log("Name one target: CONVEX_DEPLOY_KEY, or CONVEX_SELF_HOSTED_URL and _ADMIN_KEY.");
    return 2;
  }
  if (filled(deployKey) && !/^(prod|dev):/.test(deployKey)) {
    log("CONVEX_DEPLOY_KEY must be a prod: or dev: deploy key, naming one deployment.");
    return 2;
  }
  if (mode === "test" && !(selfHosted && isLoopbackUrl(env["CONVEX_SELF_HOSTED_URL"]))) {
    log("--test runs only against a loopback self-hosted backend.");
    return 2;
  }
  const blanked = selfHosted
    ? { CONVEX_DEPLOY_KEY: "" }
    : { CONVEX_SELF_HOSTED_URL: "", CONVEX_SELF_HOSTED_ADMIN_KEY: "" };
  const target = { ...env, ...blanked, CONVEX_DEPLOYMENT: "", CONVEX_URL: "" };

  if (mode === "cloud") {
    const probe = await cli(["env", "get", "VOLLI_TEST_JWKS"], target, true);
    // `auth.config.ts` trusts any non-empty value, so only the printed newline is dropped.
    if (probe.code !== 0 || probe.stdout.replace(/\r?\n$/, "") !== "") {
      log(
        probe.code !== 0
          ? "Could not read the target's VOLLI_TEST_JWKS; not deploying."
          : "The target sets VOLLI_TEST_JWKS, which trusts the test issuer. Unset it, then deploy.",
      );
      return 1;
    }
  }
  const deployed = await cli(["deploy", "--codegen", "disable"], target, false);
  if (deployed.code !== 0) return deployed.code;
  const check = ["run", "health:deploymentChecks", JSON.stringify({ mode })];
  const checked = await cli(check, target, false);
  if (checked.code !== 0) log("Deployed, but the self-check refused it: fix what it names.");
  return checked.code;
}
