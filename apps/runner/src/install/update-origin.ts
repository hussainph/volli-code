export const DEFAULT_RELEASE_ORIGIN = "https://github.com/hussainph/volli-code/releases/download/";

/** Bootstrap passes one containing release URL; updates use its validated parent. */
export function updateOrigin(base: string | undefined, version: string): string | undefined {
  if (base === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new Error("Invalid runner release base URL.");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(
      "Runner releases require HTTPS, or HTTP on loopback, without credentials, a query or a fragment.",
    );
  }
  const pathname = url.pathname.replace(/\/+$/u, "");
  const suffix = `/v${version}`;
  if (!pathname.endsWith(suffix))
    throw new Error("Runner release base must name this release's /v<version> directory.");
  url.pathname = `${pathname.slice(0, -suffix.length)}/`;
  return url.href;
}
