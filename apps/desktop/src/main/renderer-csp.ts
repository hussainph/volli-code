/** Dev-server CSP plus main's launch-time sources for the packaged renderer. */
import type { CloudLaunch } from "@volli/shared";
import { exactOrigin } from "./deployment-config";

/** Exact origins from the chosen launch, never from packaged runtime environment. */
export function launchConnectSources(
  launch: CloudLaunch,
  storageOrigin: string | null,
): readonly string[] {
  if (launch.store === "local") return [];
  const backend = exactOrigin(launch.backendUrl, true);
  const websocket = new URL(backend);
  websocket.protocol = websocket.protocol === "https:" ? "wss:" : "ws:";
  return [
    ...new Set([
      backend,
      websocket.origin,
      // Account config permits HTTP loopback only unpackaged; release inputs require HTTPS.
      ...(storageOrigin === null ? [] : [exactOrigin(storageOrigin, true)]),
    ]),
  ];
}

/** Only main's index document is transformed; assets and the cursor overlay remain untouched. */
export async function withRendererConnections(
  response: Response,
  sources: readonly string[],
): Promise<Response> {
  if (!response.ok || sources.length === 0) return response;
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(withConnectSources(await response.text(), sources), {
    status: response.status,
    headers,
  });
}

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
  // Only the dev server needs static sources. Built pages get their chosen
  // backend and storage origins from main; legacy env must not leak into them.
  const storage = input.serve ? input.env["VOLLI_CLOUD_STORAGE_ORIGIN"] : undefined;
  if (storage === undefined || storage === "") return sources;
  return [...sources, exactOrigin(storage, true)];
}

/**
 * The page with `connect-src 'self' <sources>` added to its CSP meta, or the
 * page as it is when there is nothing to add.
 */
export function withConnectSources(html: string, sources: readonly string[]): string {
  if (sources.length === 0) return html;
  const directive = `connect-src 'self' ${sources.join(" ")}; `;
  return html.replace(
    /(http-equiv="Content-Security-Policy"\s+content=")([^"]*)(")/u,
    (_match, head: string, body: string, tail: string) =>
      `${head}${body.replace(/connect-src[^;]*;\s*/gu, "").replace(/form-action/u, `${directive}form-action`)}${tail}`,
  );
}
