import { isAbsolute, relative, resolve } from "node:path";

export const PACKAGED_RENDERER_SCHEME = "volli-app";
export const PACKAGED_RENDERER_PROTOCOL = `${PACKAGED_RENDERER_SCHEME}:`;
export const PACKAGED_RENDERER_HOST = "bundle";
export const PACKAGED_RENDERER_ORIGIN = `${PACKAGED_RENDERER_SCHEME}://${PACKAGED_RENDERER_HOST}`;
export const PACKAGED_RENDERER_ENTRY_URL = `${PACKAGED_RENDERER_ORIGIN}/index.html`;

/**
 * Resolves one app-protocol request to a renderer asset.
 *
 * The scheme is deliberately a single-host, read-only view of `rendererRoot`.
 * The URL is decoded before containment is checked so encoded separators cannot
 * smuggle `..` across the root boundary.
 */
export function resolvePackagedRendererAsset(
  requestUrl: string,
  rendererRoot: string,
): string | null {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }
  if (
    url.protocol !== PACKAGED_RENDERER_PROTOCOL ||
    url.host !== PACKAGED_RENDERER_HOST ||
    url.username !== "" ||
    url.password !== ""
  ) {
    return null;
  }

  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  if (
    !pathname.startsWith("/") ||
    pathname.startsWith("//") ||
    pathname.includes("\\") ||
    pathname.includes("\0")
  ) {
    return null;
  }

  const requestPath = pathname === "/" ? "index.html" : pathname.slice(1);
  const segments = requestPath.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return null;
  }

  const root = resolve(rendererRoot);
  const assetPath = resolve(root, requestPath);
  const relativePath = relative(root, assetPath);
  if (
    relativePath === "" ||
    relativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    relativePath === ".." ||
    isAbsolute(relativePath)
  ) {
    return null;
  }
  return assetPath;
}
