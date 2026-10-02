/**
 * Desktop preference vocabulary shared by the host and its Client Surface.
 * No database, Electron, Node, or DOM dependencies belong here.
 */
export const AUTHORITY_SHADOW_REVIEW_ENABLED_KEY = "volli:authority-shadow-review-enabled";

/** Only durable JSON true opts into background review; missing or invalid stays off. */
export function parseAuthorityShadowReviewEnabled(raw: string | undefined): boolean {
  try {
    return raw !== undefined && JSON.parse(raw) === true;
  } catch {
    return false;
  }
}
