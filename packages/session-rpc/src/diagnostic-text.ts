const MAX_DIAGNOSTIC_FIELD_LENGTH = 1_000;

/** Removes values that could expose credentials, prompts, provider bodies, or local paths. */
export function sanitizeDiagnosticText(value: string): string {
  return truncateDiagnostic(
    value
      .replace(
        /\b(authorization)\b\s*(?:[:=]\s*|\s+)[^\r\n,;)}\]]+/gi,
        (_match, label: string) => `${label}: [REDACTED]`,
      )
      .replace(
        /\b(bearer|token|api[_-]?key|password|secret)\b\s*(?:[:=]\s*|\s+)[^\s,;)}\]]+/gi,
        (_match, label: string) => `${label}: [REDACTED]`,
      )
      .replace(
        /\b(prompt|messages?|parts?|provider(?:[_-]?payload)?)\b\s*[:=]\s*(?:\[[^\]]*\]|\{[^}]*\}|"[^"]*"|'[^']*'|\S+)/gi,
        (_match, label: string) => `${label}: [REDACTED]`,
      )
      .replace(/(?:\/Users\/[^/\s]+|\/home\/[^/\s]+|~)(?:\/[^\s,;)}\]]*)?/g, "[HOME]"),
  );
}

function truncateDiagnostic(value: string): string {
  return value.length <= MAX_DIAGNOSTIC_FIELD_LENGTH
    ? value
    : `${value.slice(0, MAX_DIAGNOSTIC_FIELD_LENGTH - 1)}…`;
}
