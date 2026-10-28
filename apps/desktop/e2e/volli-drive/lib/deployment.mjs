/** Real-deployment setup for isolated, unpackaged volli-drive instances.
 * Public inputs only; no ambient target, deploy credentials or release-var writes.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { packagedCloudConfig } from "../../../src/main/deployment-config.ts";

const FIELDS = {
  workosClientId: "VOLLI_BUILD_WORKOS_CLIENT_ID",
  convexUrl: "VOLLI_BUILD_CONVEX_URL",
  siteUrl: "VOLLI_BUILD_CONVEX_SITE_URL",
  storageOrigin: "VOLLI_BUILD_STORAGE_ORIGIN",
};

function publicConfig(input) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("deployment profile must be an object");
  if (Object.keys(input).some((key) => !["name", ...Object.keys(FIELDS)].includes(key)))
    throw new Error("deployment profile accepts only name and the four public values");
  for (const key of Object.keys(FIELDS)) {
    if (typeof input[key] !== "string" || input[key].trim() === "")
      throw new Error(`deployment needs public value ${key}`);
  }
  const config = packagedCloudConfig(
    Object.fromEntries(Object.entries(FIELDS).map(([key, env]) => [env, input[key]])),
  );
  return {
    workosClientId: config.workosClientId,
    convexUrl: config.backendUrl,
    siteUrl: config.siteUrl,
    storageOrigin: config.storageOrigin,
  };
}

function assertSelection(name, confirmedProd) {
  if (typeof confirmedProd !== "boolean")
    throw new Error("production requires the bare --confirm-prod flag (no value)");
  if (!["dev", "staging", "prod"].includes(name))
    throw new Error("--deployment must be dev, staging or prod");
  if (name === "prod" && confirmedProd !== true)
    throw new Error("production requires --deployment prod --confirm-prod");
  if (name !== "prod" && confirmedProd !== false)
    throw new Error("--confirm-prod is only valid with --deployment prod");
}

/** No profile fallback for partial flags: one complete, explicit source wins. */
export async function readDeployment(flags, repo) {
  const hasValues = Object.keys(FIELDS).some((key) => flags[key] !== undefined);
  if (flags.deployment === undefined) {
    if (hasValues || flags.confirmProd !== undefined)
      throw new Error("deployment values and --confirm-prod require --deployment");
    return null;
  }
  const name = flags.deployment;
  const confirmedProd = flags.confirmProd ?? false;
  assertSelection(name, confirmedProd);
  if (flags.cloud || flags.remoteAcceptance || flags.cloudSubject || flags.cloudEmail)
    throw new Error(
      "--deployment cannot be combined with cloud fixture or remote acceptance flags",
    );
  if ((flags.build !== undefined && flags.build !== "dev") || flags.app)
    throw new Error("--deployment: not yet safe; dev builds only (no packaged apps)");
  let input;
  if (hasValues) {
    input = Object.fromEntries(Object.keys(FIELDS).map((key) => [key, flags[key]]));
  } else {
    const path = join(repo, ".scratch", "deployments", `${name}.json`);
    let json;
    try {
      json = await readFile(path, "utf8");
    } catch {
      throw new Error(`cannot read deployment profile ${path}; supply it or all four public flags`);
    }
    try {
      input = JSON.parse(json);
    } catch {
      // Do not echo the parser's source excerpt: a mistyped file may contain a secret.
      throw new Error(`invalid JSON in deployment profile ${path}`);
    }
    if (input?.name !== name)
      throw new Error("deployment profile name must match --deployment (prod cannot be an alias)");
  }
  return { name, confirmedProd, ...publicConfig(input) };
}

/** Rechecked by the shared launch gate in BOTH CLI and supervisor, before spawn. */
export function assertDeploymentLaunch(spec) {
  const target = spec.deployment;
  if (target == null) return;
  assertSelection(target.name, target.confirmedProd);
  if (spec.build !== "dev" || spec.appBinary)
    throw new Error("real deployments require an unpackaged dev build");
  if (spec.cloud || spec.remoteAcceptance)
    throw new Error("real deployments cannot use fixture credentials or remote acceptance");
  const { confirmedProd: _, ...input } = target;
  publicConfig(input);
}

/** Added only after the normal harness environment: containment and keychain traps stay intact. */
export function deploymentElectronEnv(target) {
  return {
    VOLLI_EXPERIMENTAL: "cloud",
    VOLLI_ACCOUNT_PROVIDER: "workos",
    VOLLI_WORKOS_CLIENT_ID: target.workosClientId,
    VOLLI_CONVEX_URL: target.convexUrl,
    VOLLI_CONVEX_SITE_URL: target.siteUrl,
    VOLLI_CLOUD_STORAGE_ORIGIN: target.storageOrigin,
    // Quit/restart through the Tray, just as for a loopback cloud launch.
    VOLLI_SMOKE_MENU_BAR_HOST: "1",
  };
}

/** Read the recorded browser request, never follow it or synthesize authentication. */
export function recordedWorkosSignIn(jsonl, clientId) {
  for (const line of jsonl.split("\n").filter(Boolean).toReversed()) {
    try {
      const entry = JSON.parse(line);
      const url = new URL(entry.args?.[0]);
      if (
        entry.method === "openExternal" &&
        url.origin === "https://api.workos.com" &&
        url.pathname === "/user_management/authorize" &&
        url.searchParams.get("client_id") === clientId
      )
        return url.href;
    } catch {
      // Other requests or partial recorder lines are not authorization URLs.
    }
  }
  throw new Error("no recorded WorkOS sign-in URL; click a sign-in button in the app first");
}
