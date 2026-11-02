/**
 * The deployment self-check behind `health:deploymentChecks`, run after every
 * `convex deploy` by `scripts/deploy.mjs`. Deterministic: it reads variable
 * names and presence, never prints a value, and makes no key material.
 *
 * A **cloud** check (the default) refuses a deployment that sets
 * `VOLLI_TEST_JWKS` at all (it trusts the test issuer, whose tokens anyone
 * with the fixture's key can mint) or leaves a required variable unset.
 *
 * A **test** check, for the throwaway local backend, allows both. It cannot
 * stand in for the cloud check: on a deployment whose own URL
 * (`CONVEX_CLOUD_URL`, set by Convex) is not loopback it is refused, and the
 * cloud check runs anyway.
 *
 * The GitHub App is optional, but its six variables go together: none set
 * leaves GitHub off (`github.config` answers `configured: false`), while a
 * partial set would silently do the same, so the check names each one missing
 * (`incomplete`).
 */

import { GITHUB_APP_VARIABLES, isGithubVariableSet } from "./github/config";

type DeploymentCheckMode = "cloud" | "test";

/** The variable `auth.config.ts` trusts the test issuer under. */
const TEST_JWKS_VARIABLE = "VOLLI_TEST_JWKS";
/** Set by Convex on every deployment: its client URL. */
const DEPLOYMENT_URL_VARIABLE = "CONVEX_CLOUD_URL";

/**
 * What a cloud deployment cannot serve without: sign-in, runner tokens,
 * secrets, storage. `convex/README.md` ("Deployments") lists the same names.
 */
const REQUIRED_VARIABLES = [
  "WORKOS_CLIENT_ID",
  "VOLLI_RUNNER_SIGNING_KEY",
  "VOLLI_RUNNER_JWKS",
  "VOLLI_SECRETS_ROOT_KEYS",
  "VOLLI_S3_ENDPOINT",
  "VOLLI_S3_BUCKET",
  "VOLLI_S3_ACCESS_KEY_ID",
  "VOLLI_S3_SECRET_ACCESS_KEY",
] as const;

type DeploymentProblemCode = "forbidden" | "incomplete" | "missing" | "test_mode_refused";

// Type aliases, not interfaces: a `ConvexError`'s data must be a Convex `Value`,
// which an interface (no implicit index signature) is not.
type DeploymentProblem = {
  variable: string;
  code: DeploymentProblemCode;
};

type DeploymentReport = {
  ok: boolean;
  mode: DeploymentCheckMode;
  /** Whether the deployment's own URL is loopback; only a loopback one may pass a test check. */
  deployment: "loopback" | "remote";
  problems: DeploymentProblem[];
};

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Whether `url` is an http(s) URL on this machine's loopback interface. */
export function isLoopbackUrl(url: string | undefined): boolean {
  try {
    const parsed = new URL(url ?? "");
    return /^https?:$/.test(parsed.protocol) && LOOPBACK_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * Checks the configuration `read` answers for (the deployment's own
 * `process.env`). `mode` is what the caller asserts the deployment is.
 */
export function checkDeployment(
  mode: DeploymentCheckMode,
  read: (name: string) => string | undefined,
): DeploymentReport {
  const problems: DeploymentProblem[] = [];
  const loopback = isLoopbackUrl(read(DEPLOYMENT_URL_VARIABLE));
  if (mode === "test" && !loopback) {
    problems.push({ variable: DEPLOYMENT_URL_VARIABLE, code: "test_mode_refused" });
  }
  if (mode === "cloud" || !loopback) {
    // `auth.config.ts` trusts any non-empty value, whitespace included.
    if ((read(TEST_JWKS_VARIABLE) ?? "") !== "") {
      problems.push({ variable: TEST_JWKS_VARIABLE, code: "forbidden" });
    }
    for (const variable of REQUIRED_VARIABLES) {
      if ((read(variable) ?? "").trim() === "") problems.push({ variable, code: "missing" });
    }
    const github = GITHUB_APP_VARIABLES.map((variable) => ({
      variable,
      set: isGithubVariableSet(variable, read(variable)),
    }));
    if (github.some(({ set }) => set)) {
      for (const { variable, set } of github) {
        if (!set) problems.push({ variable, code: "incomplete" });
      }
    }
  }
  return {
    ok: problems.length === 0,
    mode,
    deployment: loopback ? "loopback" : "remote",
    problems,
  };
}

const EXPLANATIONS: Record<DeploymentProblemCode, string> = {
  forbidden: "set; it trusts the test issuer, so no cloud deployment may carry it",
  incomplete:
    "unset while other GitHub App variables are set; set all six or none (GitHub stays off until then)",
  missing: "unset; a cloud deployment requires it",
  test_mode_refused: "not loopback; a test check runs only on the local backend",
};

/** One line per problem, for an error message: names and codes, never values. */
export function describeProblems(problems: readonly DeploymentProblem[]): string {
  return problems.map(({ variable, code }) => `${variable} ${EXPLANATIONS[code]}`).join("\n");
}
