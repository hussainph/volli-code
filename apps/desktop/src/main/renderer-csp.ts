/**
 * Where the main window may open a connection (VC-889), templated into its
 * Content-Security-Policy at build time (`vite.config.ts`).
 *
 * The page's own CSP names no `connect-src`, so it falls back to
 * `default-src 'self'`: a packaged build reaches nothing but its own origin.
 * The only Volli Cloud backend a build can reach today is the pinned local
 * fixture an unpackaged build runs against, so the dev server (and a build
 * asked for it with `VOLLI_CLOUD_LOOPBACK=1`) adds the loopback. When a cloud
 * deployment exists, its exact origin joins here, and nothing broader.
 */

/** The loopback a local backend listens on. */
export const LOOPBACK_CONNECT_SOURCES = Object.freeze([
  "http://127.0.0.1:*",
  "ws://127.0.0.1:*",
  "http://localhost:*",
  "ws://localhost:*",
]);

/** What this build adds to `'self'`: the loopback for the dev server or when asked, else nothing. */
export function rendererConnectSources(input: {
  readonly serve: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
}): readonly string[] {
  const sources =
    input.serve || input.env["VOLLI_CLOUD_LOOPBACK"] === "1" ? LOOPBACK_CONNECT_SOURCES : [];
  // Public build configuration, never an S3 credential or a wildcard. Signed
  // transcript GETs reach precisely this bucket origin in a packaged build.
  const storage = input.env["VOLLI_CLOUD_STORAGE_ORIGIN"];
  if (storage === undefined || storage === "") return sources;
  const url = new URL(storage);
  if (
    url.protocol !== "https:" ||
    !/^[a-z0-9.-]+$/u.test(url.hostname) ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("VOLLI_CLOUD_STORAGE_ORIGIN must be an exact HTTPS origin");
  }
  return [...sources, url.origin];
}

/**
 * The page with `connect-src 'self' <sources>` added to its CSP meta, or the
 * page as it is when there is nothing to add.
 */
export function withConnectSources(html: string, sources: readonly string[]): string {
  if (sources.length === 0) return html;
  const directive = `connect-src 'self' ${sources.join(" ")}; `;
  return html.replace(
    /(http-equiv="Content-Security-Policy"\s+content=")([^"]*?)(form-action)/u,
    (_match, head: string, body: string, tail: string) => `${head}${body}${directive}${tail}`,
  );
}
