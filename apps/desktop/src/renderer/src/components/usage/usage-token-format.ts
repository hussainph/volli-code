/** Compact cumulative usage, shared by every usage face and class detail. */
export function formatUsageTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens < 0) return "0";
  const count = Math.round(tokens);
  const units = ["", "K", "M", "B", "T"];
  let unit = 0;
  while (unit < units.length - 1 && count / 1000 ** unit >= 1000) unit += 1;
  const value = count / 1000 ** unit;
  const rounded = value < 10 ? Math.round(value * 10) / 10 : Math.round(value);
  // Promote rounded boundaries rather than printing 1000K or 1000M.
  if (rounded >= 1000 && unit < units.length - 1) return `1${units[unit + 1]}`;
  return `${unit === 0 ? count : rounded}${units[unit]}`;
}

export function tokenCountLabel(tokens: number): string {
  const count = Number.isFinite(tokens) ? Math.max(0, Math.round(tokens)) : 0;
  return `${count.toLocaleString("en-US")} tokens`;
}
