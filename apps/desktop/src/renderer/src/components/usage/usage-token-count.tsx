import { cn } from "@renderer/lib/utils";
import { formatUsageTokens, tokenCountLabel } from "./usage-token-format";
export { tokenCountLabel } from "./usage-token-format";

/** Compact on the face, exact on hover and in the accessible reading. */

export function UsageTokenCount({
  tokens,
  className,
  unit = false,
}: {
  tokens: number;
  className?: string;
  unit?: boolean;
}) {
  const label = tokenCountLabel(tokens);
  return (
    <span title={label} aria-label={label} className={cn("tabular-nums", className)}>
      {formatUsageTokens(tokens)}
      {unit ? " tokens" : ""}
    </span>
  );
}
