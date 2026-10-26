/** Public release inputs only. Never put a deploy key, signing key or S3 credential here. */
export interface PackagedCloudConfig {
  readonly workosClientId: string;
  readonly backendUrl: string;
  readonly siteUrl: string;
  readonly storageOrigin: string;
}

/** Exact origins are also safe to interpolate into a CSP (no paths, credentials or wildcards). */
export function exactOrigin(raw: string, allowLoopback = false): string {
  const url = new URL(raw);
  const loopback = allowLoopback && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  if (
    (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) ||
    !/^[a-z0-9.-]+$/u.test(url.hostname) ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("Expected an exact HTTPS origin (HTTP is allowed only for a local fixture)");
  }
  return url.origin;
}

/** Evaluated by the build, not at packaged runtime. An incomplete release must fail, not ship half-wired. */
export function packagedCloudConfig(
  env: Readonly<Record<string, string | undefined>>,
): PackagedCloudConfig | null {
  const names = [
    "VOLLI_BUILD_WORKOS_CLIENT_ID",
    "VOLLI_BUILD_CONVEX_URL",
    "VOLLI_BUILD_CONVEX_SITE_URL",
    "VOLLI_BUILD_STORAGE_ORIGIN",
  ] as const;
  const values = names.map((name) => env[name]?.trim() ?? "");
  if (values.every((value) => value === "")) return null;
  if (values.some((value) => value === ""))
    throw new Error(`Set all or none of ${names.join(", ")}`);
  const [workosClientId, backend, site, storage] = values as [string, string, string, string];
  if (!/^client_[A-Za-z0-9_-]+$/u.test(workosClientId))
    throw new Error("VOLLI_BUILD_WORKOS_CLIENT_ID must be a public WorkOS client id");
  return {
    workosClientId,
    backendUrl: exactOrigin(backend),
    siteUrl: exactOrigin(site),
    storageOrigin: exactOrigin(storage),
  };
}
