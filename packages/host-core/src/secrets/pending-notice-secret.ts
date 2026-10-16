/**
 * A live notice must not quote a credential before the punctuation that lets
 * the shared redactor recognize it arrives (URL userinfo's @, JWT segments,
 * or the rest of an AWS key). All candidates own only the current suffix;
 * complete contexts still use the shared original-source spans.
 */
export function pendingNoticeSecretStart(text: string): number | null {
  let start: number | null = null;
  const authority = text.match(/:\/\/[^\s/\\?#"'<>]*$/);
  if (authority !== null && authority[0].length > 3) start = authority.index! + 3;

  // Scan the trailing candidate once. Retrying an anchored greedy regex at
  // every eyJ/AKIA-like prefix could rescan a repetitive near miss quadratically.
  let word = text.length;
  while (word > 0 && isTokenUnit(text.charCodeAt(word - 1))) word -= 1;
  for (let at = word; at < text.length; at += 1) {
    if (at > 0 && isWordUnit(text.charCodeAt(at - 1))) continue;
    if (text.startsWith("eyJ", at) || text.startsWith("AKIA", at) || text.startsWith("ASIA", at)) {
      start = start === null ? at : Math.min(start, at);
      break;
    }
  }
  return start;
}

function isWordUnit(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95
  );
}

function isTokenUnit(code: number): boolean {
  return isWordUnit(code) || code === 45 || code === 46;
}
