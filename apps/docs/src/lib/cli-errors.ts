import { AGENT_ERROR_CODES } from "@volli/shared";

// Keep experimental-only recovery guidance out of the desktop docs in both
// HTML and copied Markdown. The installed CLI still lists its full vocabulary.
const CLOUD_ONLY_ERRORS: ReadonlySet<string> = new Set([
  "OFFLINE",
  "NOT_YET_SYNCED",
  "BUSY",
  "SIGN_IN_REQUIRED",
]);

export const DOCUMENTED_AGENT_ERROR_CODES = AGENT_ERROR_CODES.filter(
  (code) => !CLOUD_ONLY_ERRORS.has(code),
);
