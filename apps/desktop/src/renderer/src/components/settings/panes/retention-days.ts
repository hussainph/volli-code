/** Retention accepts decimal whole days, never fractions or exponent notation. */
export function parseRetentionDays(text: string): number | null {
  const trimmed = text.trim();
  const parsed = /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : null;
}
