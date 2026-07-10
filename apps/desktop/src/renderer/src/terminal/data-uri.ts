/**
 * The terminal font is bundled into the JS as a base64 `data:` URI (via Vite's
 * `?inline`), not shipped as a separate asset — so it loads identically under
 * the Vite dev server and the packaged `file://` build, with no `fetch()` that
 * the app's strict CSP / the `file://` origin would block. restty's text-shaper
 * wants the raw font bytes, so we decode the base64 payload here. Pure and
 * DOM-light (only `atob`) so the decoding is unit-testable.
 */

/**
 * Decode a `data:...;base64,XXXX` URI to its bytes. Throws on a URI that is not
 * base64-encoded — we only ever hand it Vite `?inline` output, so a non-base64
 * URI is a build-wiring bug worth surfacing loudly rather than rendering blank.
 */
export function decodeBase64DataUri(uri: string): Uint8Array {
  const comma = uri.indexOf(",");
  if (!uri.startsWith("data:") || comma === -1) {
    throw new Error("Not a data: URI");
  }
  const meta = uri.slice(5, comma);
  if (!meta.includes(";base64")) {
    throw new Error("data: URI is not base64-encoded");
  }
  const binary = atob(uri.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
