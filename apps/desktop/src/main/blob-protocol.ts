/**
 * Serving Blob bytes back to the renderer over the `volli-blob:` scheme
 * (VC-50, `docs/plans/attachments.md`).
 *
 * This is the half of the pipeline that makes an attachment survivable. The
 * transcript and the Ticket body hold `volli-blob:<hash>` and nothing else, so
 * an image in a reopened chat resolves through the store rather than through a
 * worktree that retention may since have pruned. Dev and packaged behave
 * identically, because neither is reading a checkout.
 *
 * The response-building lives here, apart from `index.ts`'s Electron
 * lifecycle, so the status codes are unit-testable without a running app.
 * `index.ts` keeps only `registerSchemesAsPrivileged` and the `protocol.handle`
 * that delegates here.
 */
import { parseBlobUrl } from "@volli/shared";
import { readBlob } from "./blob-store";

export interface BlobProtocolDeps {
  blobsRoot: string;
  /**
   * The media type recorded for this hash, or `undefined` when no `blobs` row
   * names it. Injected rather than taking a `Database` so the handler can be
   * tested without one, and so the protocol layer never learns SQL.
   */
  lookupMime: (hash: string) => string | undefined;
}

/**
 * Headers every Blob response carries, whatever its type.
 *
 * `default-src 'none'` matters more than it looks: an attachment is
 * user-supplied content served from a privileged scheme, and an SVG is a
 * document that can reference other things. It cannot script inside an `<img>`,
 * but a CSP that permits nothing is the guarantee rather than the assumption.
 * `nosniff` holds Chromium to the media type we recorded at import instead of
 * letting it re-guess from the bytes.
 *
 * The cache is immutable and effectively permanent because the URL is a hash of
 * the content: this exact URL cannot ever name different bytes, so there is no
 * staleness to protect against.
 */
const BASE_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy": "default-src 'none'",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "public, max-age=31536000, immutable",
};

/**
 * Resolves one `volli-blob:` request.
 *
 * Three outcomes, and each is a real distinction rather than a generic failure:
 * 400 when the URL is not a well-formed Blob URL (the page asked for something
 * that could never exist), 404 when it is well-formed but the store has no such
 * bytes (a collected Blob, or a database restored without its files), and 200
 * with the bytes. The handler is fed whatever the renderer asks for, so it
 * answers rather than throws — a throw here would take down the scheme for
 * every later request, not just the bad one.
 */
export function blobProtocolResponse(deps: BlobProtocolDeps, url: string): Response {
  const hash = parseBlobUrl(url);
  if (hash === null) {
    return new Response("Not a blob URL", { status: 400, headers: BASE_HEADERS });
  }
  let bytes: Uint8Array;
  try {
    bytes = readBlob(deps.blobsRoot, hash);
  } catch {
    // Deliberately catching rather than pre-checking existence: between a check
    // and a read the file can be collected, and a 404 is the honest answer to
    // both "never had it" and "no longer has it".
    return new Response("No such blob", { status: 404, headers: BASE_HEADERS });
  }
  // Copied out to its own ArrayBuffer rather than passed as the Buffer.
  // `readFileSync` can hand back a view into Node's shared allocation pool, and
  // a Response built over that view's `.buffer` would expose the entire pool —
  // other files' bytes included — to the renderer.
  const body = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return new Response(body, {
    status: 200,
    headers: {
      ...BASE_HEADERS,
      "Content-Type": deps.lookupMime(hash) ?? "application/octet-stream",
    },
  });
}
