import * as React from "react";

/** View-only selection; Session identity, navigation and durable read state stay separate. */
export function selectNavigatorRange(input: {
  ordered: readonly string[];
  selected: ReadonlySet<string>;
  anchor: string | null;
  target: string;
  range: boolean;
  toggle: boolean;
}): { selected: ReadonlySet<string>; anchor: string } {
  if (input.range && input.anchor !== null) {
    const a = input.ordered.indexOf(input.anchor),
      b = input.ordered.indexOf(input.target);
    if (a >= 0 && b >= 0)
      return {
        selected: new Set([
          ...(input.toggle ? input.selected : []),
          ...input.ordered.slice(Math.min(a, b), Math.max(a, b) + 1),
        ]),
        anchor: input.anchor,
      };
  }
  const selected = new Set(input.toggle ? input.selected : []);
  if (input.toggle && selected.has(input.target)) selected.delete(input.target);
  else selected.add(input.target);
  return { selected, anchor: input.target };
}

export interface SessionSelectionActions {
  sessionIds: ReadonlySet<string>;
  setRead(unread: boolean): void;
}
export const SessionSelectionContext = React.createContext<SessionSelectionActions | null>(null);
