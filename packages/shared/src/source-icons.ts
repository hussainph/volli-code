/** Machine-local transcript decoration. Never part of a Session event or tool result. */
export const SOURCE_ICON_ORIGIN_LIMIT = 32;

export interface SourceIconsWatchInput {
  sessionId: string;
  origins: string[];
}

export interface SourceIconsSnapshot {
  icons: Array<{
    origin: string;
    pictureId: string | null;
    /** Required even when this origin has no cached image. */
    registrableDomain: string | null;
  }>;
}

/** Display input validation only; this does not authorize a network read. */
export function isCanonicalSourceOrigin(origin: string): boolean {
  if (origin.length > 2048) return false;
  try {
    const url = new URL(origin);
    return (url.protocol === "http:" || url.protocol === "https:") && url.origin === origin;
  } catch {
    return false;
  }
}
