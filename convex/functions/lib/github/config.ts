/**
 * The GitHub App this deployment talks to, read from deployment variables.
 *
 * Nothing about the App is stored in the database: its id, slug, client id
 * and secret, private key and webhook secrets are Convex environment
 * variables, set once per environment (the owner's checklist is in
 * `convex/README.md`, "GitHub App"). `GITHUB_API_URL` and `GITHUB_WEB_URL`
 * default to github.com; tests point them at a fake GitHub.
 */

import { ConvexError } from "convex/values";

import { parseWebhookSecrets, type GithubErrorCode } from "@volli/shared/cloud";

export interface GithubAppConfig {
  readonly appId: string;
  readonly slug: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /** PKCS#8 PEM (`openssl pkcs8 -topk8 -nocrypt`), what WebCrypto imports. */
  readonly privateKey: string;
  /** Current first, then the previous one during a rotation. */
  readonly webhookSecrets: readonly string[];
  readonly apiUrl: string;
  readonly webUrl: string;
  /** The Convex site the App's callback, setup and webhook URLs point at. */
  readonly siteUrl: string;
}

const GITHUB_ENV = {
  appId: "GITHUB_APP_ID",
  slug: "GITHUB_APP_SLUG",
  clientId: "GITHUB_APP_CLIENT_ID",
  clientSecret: "GITHUB_APP_CLIENT_SECRET",
  privateKey: "GITHUB_APP_PRIVATE_KEY",
  webhookSecrets: "GITHUB_WEBHOOK_SECRETS",
  apiUrl: "GITHUB_API_URL",
  webUrl: "GITHUB_WEB_URL",
} as const;

function read(name: string): string {
  const value = process.env[name];
  return typeof value === "string" ? value.trim() : "";
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/u, "");
}

export function githubError(code: GithubErrorCode, message: string, extra: object = {}) {
  return new ConvexError({ code, message, ...extra });
}

/** The App's configuration, or `null` while any required variable is unset. */
export function readGithubConfig(): GithubAppConfig | null {
  const appId = read(GITHUB_ENV.appId);
  const slug = read(GITHUB_ENV.slug);
  const clientId = read(GITHUB_ENV.clientId);
  const clientSecret = read(GITHUB_ENV.clientSecret);
  // A PEM set through `npx convex env set` may arrive with literal `\n`s.
  const privateKey = read(GITHUB_ENV.privateKey).replace(/\\n/gu, "\n");
  const webhookSecrets = parseWebhookSecrets(read(GITHUB_ENV.webhookSecrets));
  // Convex sets `CONVEX_SITE_URL` on every deployment.
  const siteUrl = read("CONVEX_SITE_URL");
  if (
    appId === "" ||
    slug === "" ||
    clientId === "" ||
    clientSecret === "" ||
    privateKey === "" ||
    webhookSecrets.length === 0 ||
    siteUrl === ""
  ) {
    return null;
  }
  return {
    appId,
    slug,
    clientId,
    clientSecret,
    privateKey,
    webhookSecrets,
    apiUrl: trimSlash(read(GITHUB_ENV.apiUrl) || "https://api.github.com"),
    webUrl: trimSlash(read(GITHUB_ENV.webUrl) || "https://github.com"),
    siteUrl: trimSlash(siteUrl),
  };
}

/** The App's configuration, or `github_not_configured`. */
export function requireGithubConfig(): GithubAppConfig {
  const config = readGithubConfig();
  if (config === null) {
    throw githubError(
      "github_not_configured",
      "GitHub isn't set up on this Volli Cloud deployment yet.",
    );
  }
  return config;
}
