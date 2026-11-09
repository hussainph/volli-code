/** Only an edge that hides more content fades. A flush first/last row stays legible. */
export function scrollEdgeMask({
  atTop,
  atBottom,
}: {
  atTop: boolean;
  atBottom: boolean;
}): string | undefined {
  if (atTop && atBottom) return undefined;
  const head = atTop ? "currentColor 0" : "transparent 0, currentColor 12px";
  const tail = atBottom ? "currentColor 100%" : "currentColor calc(100% - 12px), transparent 100%";
  return `linear-gradient(to bottom, ${head}, ${tail})`;
}
