// Keep HTML extraction workers on this pure policy leaf, not the shared barrel.
import { admitWebTarget } from "../../../shared/src/web-target-policy";

/** An explicit same-origin subresource, not permission to read it. Ignores HTML base elements. */
export function sameOriginIconUrl(href: string, finalPageUrl: string): string | null {
  // Reject ambiguity before URL normalisation can discard control characters.
  if (
    href.length === 0 ||
    href.length > 2048 ||
    href.includes("?") ||
    href.includes("#") ||
    Array.from(href).some(
      (character) =>
        character.charCodeAt(0) <= 0x20 || character.charCodeAt(0) === 0x7f || character === "\\",
    )
  )
    return null;
  try {
    const page = new URL(finalPageUrl);
    const url = new URL(href, page);
    if (url.origin !== page.origin || url.username || url.password || url.search || url.hash)
      return null;
    const admission = admitWebTarget(url.href);
    return admission.outcome === "admit" ? admission.target.url : null;
  } catch {
    return null;
  }
}
