import * as React from "react";
import { cn } from "@renderer/lib/utils";

/**
 * A filesystem path that wraps after a separator, never inside a name:
 * `/Users/me/code/` then `kintsugi`, not `…/ki` then `ntsugi`. Each `/` is
 * followed by a `<wbr>`, which the line breaker prefers; `anywhere` stays only
 * as the last resort for a single segment wider than the box.
 */
export function PathText({ path, className }: { path: string; className?: string }) {
  // Each segment keyed by the prefix it ends, which is unique within a path.
  let prefix = "";
  const segments = path.split(/(?<=\/)/).map((part) => {
    prefix += part;
    return { part, key: prefix, last: prefix === path };
  });
  return (
    <span className={cn("min-w-0 font-mono [overflow-wrap:anywhere]", className)}>
      {segments.map(({ part, key, last }) => (
        <React.Fragment key={key}>
          {part}
          {last ? null : <wbr />}
        </React.Fragment>
      ))}
    </span>
  );
}
