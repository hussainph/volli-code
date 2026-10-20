/** Pure clone admission policy shared by desktop feedback and pre-transport checks. */

/** The longest git URL this Mac sends to a host. */
export const GIT_URL_MAX = 2048;

const SCP_LIKE = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[A-Za-z0-9._~/-]+$/u;

/** Why this Mac will not ask a host to clone `url`, or `null`. Only https, ssh and scp-like. */
export function gitUrlProblem(url: string): string | null {
  if (url.length === 0 || url.length > GIT_URL_MAX) return "length";
  // Whitespace, a control character, or anything a shell or git reads as an option.
  if (/[\s\p{Cc}]/u.test(url) || url.startsWith("-")) return "characters";
  // A query or fragment (or either encoded) is where a token rides: never cloned.
  if (/[?#%]/u.test(url)) return "query";
  if (SCP_LIKE.test(url)) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "not-a-url";
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "ssh:") return "transport";
  // A password in the URL would be printed, logged and copied into every worktree's config.
  if (parsed.password !== "") return "credentials";
  if (parsed.protocol === "https:" && parsed.username !== "") return "credentials";
  if (parsed.hostname === "" || parsed.pathname.length <= 1) return "not-a-repository";
  return null;
}
