/**
 * The GitHub App `test:backend`'s backend is configured with (its global
 * setup only; `with-backend --deploy` sets none): fixed test values and an
 * API base on a dead loopback port, so a reconcile a test delivery schedules
 * fails fast instead of reaching github.com. Tests sign webhook bodies with
 * {@link TEST_GITHUB_WEBHOOK_SECRET}.
 */

export const TEST_GITHUB_APP_ID = "1001";
export const TEST_GITHUB_WEBHOOK_SECRET = "fixture-webhook-secret";

export const TEST_GITHUB_ENV: Record<string, string> = {
  GITHUB_APP_ID: TEST_GITHUB_APP_ID,
  GITHUB_APP_SLUG: "volli-fixture",
  GITHUB_APP_CLIENT_ID: "Iv1.fixture",
  GITHUB_APP_CLIENT_SECRET: "fixture-client-secret",
  // Not a key: an App JWT signed with it fails, and the reconcile logs it.
  GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----",
  GITHUB_WEBHOOK_SECRETS: TEST_GITHUB_WEBHOOK_SECRET,
  GITHUB_API_URL: "http://127.0.0.1:9",
  GITHUB_WEB_URL: "http://127.0.0.1:9",
};
