// oxlint-disable no-underscore-dangle -- Vite `define` constants use the
// double-underscore convention so plain identifiers are never rewritten.
/**
 * Which Volli Cloud deployment this runner links to.
 *
 * An install token does not name its deployment, so a release bakes one in:
 * the public `VOLLI_BUILD_CONVEX_URL` / `VOLLI_BUILD_CONVEX_SITE_URL` release
 * inputs desktop reads too (vite.config.ts). `--server <url>` (or
 * `VOLLI_SERVER`) overrides it, for a staging deployment or a local backend;
 * a development build has none baked and links only that way. The runner
 * needs both of a deployment's origins: its Convex URL for the live
 * connection and its HTTP actions origin (the site URL) for `/runner/*`. A
 * `*.convex.cloud` server's site is the matching `*.convex.site`; any other
 * server names its site with `--site <url>` (or `VOLLI_SERVER_SITE`).
 *
 * The deployment a runner linked to is recorded with its link
 * (`file-store.ts`), so later commands and the daemon follow the link, not
 * the flags.
 */

declare const __VOLLI_RUNNER_BUILD_DEPLOYMENT__: { url: string; siteUrl: string } | null;

export interface RunnerDeployment {
  /** The Convex deployment URL (`https://<name>.convex.cloud`). */
  readonly url: string;
  /** Its HTTP actions origin (`https://<name>.convex.site`), where `/runner/*` lives. */
  readonly siteUrl: string;
}

/** A server value no runner can link to; the sentence names the fix. */
export class DeploymentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeploymentError";
  }
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * `raw` as an exact origin: HTTPS, or HTTP to a loopback address (a local
 * backend), with no credentials, path, query or fragment.
 */
export function exactOrigin(raw: string, label: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DeploymentError(`${label} ${JSON.stringify(raw)} is not a URL.`);
  }
  const secure =
    url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.has(url.hostname));
  if (
    !secure ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new DeploymentError(
      `${label} ${JSON.stringify(raw)} must be an https:// origin (http:// only to a loopback ` +
        "address), with no path.",
    );
  }
  return url.origin;
}

/** The deployment a `*.convex.cloud` URL's site is, or `null` for any other host. */
function conventionalSite(url: string): string | null {
  const parsed = new URL(url);
  if (!parsed.hostname.endsWith(".convex.cloud")) return null;
  parsed.hostname = `${parsed.hostname.slice(0, -".convex.cloud".length)}.convex.site`;
  return parsed.origin;
}

export interface DeploymentChoice {
  /** `--server`, else `VOLLI_SERVER`. */
  readonly server?: string | undefined;
  /** `--site`, else `VOLLI_SERVER_SITE`. */
  readonly site?: string | undefined;
  /** What this build was released against; `null` for a development build. */
  readonly baked: RunnerDeployment | null;
}

export function resolveDeployment(choice: DeploymentChoice): RunnerDeployment {
  if (choice.server === undefined) {
    if (choice.site !== undefined) throw new DeploymentError("--site needs --server.");
    if (choice.baked === null) {
      throw new DeploymentError(
        "This build of volli-runner names no Volli server; pass --server <url>.",
      );
    }
    return {
      url: exactOrigin(choice.baked.url, "The built-in server"),
      siteUrl: exactOrigin(choice.baked.siteUrl, "The built-in server's site"),
    };
  }
  const url = exactOrigin(choice.server, "--server");
  if (choice.site !== undefined) return { url, siteUrl: exactOrigin(choice.site, "--site") };
  const siteUrl = conventionalSite(url);
  if (siteUrl === null) {
    throw new DeploymentError(
      `--server ${url} is not a *.convex.cloud deployment, so its site is unknown; ` +
        "pass --site <url> too.",
    );
  }
  return { url, siteUrl };
}

/** The deployment this build was released against, as vite.config.ts baked it. */
export const BUILD_DEPLOYMENT: RunnerDeployment | null = __VOLLI_RUNNER_BUILD_DEPLOYMENT__;
