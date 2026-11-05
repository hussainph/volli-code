import * as React from "react";
import { ArrowDownIcon, SendIcon, LayersIcon, AutomationIcon } from "@renderer/components/ui/icon";

import type { SessionUsageSummary } from "@volli/shared";
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover";
import { UsageTokenCount, tokenCountLabel } from "./usage-token-count";
import { cn } from "@renderer/lib/utils";
import {
  totalUsageTokens,
  usageBarSegments,
  type UsageClassId,
} from "@renderer/usage/usage-format";
import "./usage-instrument.css";

const CLASS_STYLE: Record<UsageClassId, React.CSSProperties> = {
  cacheRead: {
    "--usage-ink": "var(--info)",
    "--usage-on-ink": "var(--info-foreground)",
  } as React.CSSProperties,
  input: {
    "--usage-ink": "var(--primary)",
    "--usage-on-ink": "var(--primary-foreground)",
  } as React.CSSProperties,
  cacheWrite: {
    "--usage-ink": "var(--attention)",
    "--usage-on-ink": "var(--attention-foreground)",
  } as React.CSSProperties,
  output: {
    "--usage-ink": "var(--positive)",
    "--usage-on-ink": "var(--positive-foreground)",
  } as React.CSSProperties,
};
const ICONS = {
  cacheRead: LayersIcon,
  input: ArrowDownIcon,
  cacheWrite: AutomationIcon,
  output: SendIcon,
};

type Segment = ReturnType<typeof usageBarSegments>[number];
function TokenSegment({ segment, total }: { segment: Segment; total: number }) {
  const [open, setOpen] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancel = () => {
    if (timer.current) clearTimeout(timer.current);
  };
  React.useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const show = () => {
    cancel();
    setOpen(true);
  };
  const hide = () => {
    cancel();
    timer.current = setTimeout(() => setOpen(false), 150);
  };
  const share = ((segment.tokens / total) * 100).toFixed(1);
  const label = `${segment.label}: ${tokenCountLabel(segment.tokens)}, ${share}% of tokens`;
  const Icon = ICONS[segment.id];
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          title={label}
          style={{ ...CLASS_STYLE[segment.id], flexGrow: segment.tokens, flexBasis: 0 }}
          className="usage-token-segment min-w-px outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          onPointerEnter={show}
          onPointerLeave={hide}
          onFocus={show}
          onBlur={hide}
          onClick={(event) => {
            event.preventDefault();
            show();
          }}
        />
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="center"
        collisionPadding={16}
        aria-label={segment.label}
        style={CLASS_STYLE[segment.id]}
        className="usage-token-popover w-60 overflow-hidden p-0"
        onPointerEnter={cancel}
        onPointerLeave={hide}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <div className="usage-token-cap flex justify-center p-4">
          <Icon className="size-8" />
        </div>
        <div className="flex flex-col items-center gap-2 p-4 text-center">
          <h3 className="text-ui font-semibold">{segment.label}</h3>
          <UsageTokenCount tokens={segment.tokens} className="text-title" />
          <span className="text-ui tabular-nums text-muted-foreground">{share}% of tokens</span>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** Interactive except when the drawing is already inside a button. */
export const UsageBar = React.memo(function UsageBar({
  summary,
  className,
  interactive = true,
}: {
  summary: SessionUsageSummary;
  className?: string;
  interactive?: boolean;
}) {
  const segments = React.useMemo(() => usageBarSegments(summary), [summary]);
  if (segments.length === 0) return null;
  const label = segments
    .map((segment) => `${segment.label}: ${tokenCountLabel(segment.tokens)}`)
    .join(", ");
  const total = totalUsageTokens(summary);
  return (
    <span
      role={interactive ? "group" : "img"}
      aria-label={`Token classes: ${label}`}
      className={cn(
        "flex h-8 w-full gap-px overflow-hidden rounded-control shadow-control",
        className,
      )}
    >
      {segments.map((segment) =>
        interactive ? (
          <TokenSegment key={segment.id} segment={segment} total={total} />
        ) : (
          <span
            key={segment.id}
            style={{ ...CLASS_STYLE[segment.id], flexGrow: segment.tokens, flexBasis: 0 }}
            className="usage-token-segment min-w-px"
            title={`${segment.label}: ${tokenCountLabel(segment.tokens)}`}
          />
        ),
      )}
    </span>
  );
});

export function UsageClassRows({ summary }: { summary: SessionUsageSummary }) {
  const segments = usageBarSegments(summary);
  if (segments.length === 0) return null;
  const total = totalUsageTokens(summary);
  return (
    <dl className="flex flex-col gap-2">
      {segments.map((segment) => (
        <div key={segment.id} className="flex items-center gap-2">
          <span
            aria-hidden
            style={{ background: `var(--usage-ink)`, ...CLASS_STYLE[segment.id] }}
            className="size-2 shrink-0 rounded-full"
          />
          <dt
            title={segment.label}
            className="min-w-0 flex-1 truncate text-ui text-muted-foreground"
          >
            {segment.label}
          </dt>
          <dd className="flex shrink-0 items-baseline gap-2 text-ui text-foreground">
            <UsageTokenCount tokens={segment.tokens} />
            <span className="w-12 text-right text-label tabular-nums text-muted-foreground">
              {((segment.tokens / total) * 100).toFixed(1)}%
            </span>
          </dd>
        </div>
      ))}
    </dl>
  );
}
