/**
 * The loopback test behind the deployment self-check's test-mode fence.
 *
 * `scripts/deploy.ts` imports this module under plain Node (`deploy:checked`
 * runs `node scripts/deploy.mjs`), which resolves no extensionless import:
 * keep it free of imports.
 */

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
