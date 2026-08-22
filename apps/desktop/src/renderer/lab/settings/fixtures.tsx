/**
 * LAB CHROME, not part of the proposal.
 *
 * `kit.tsx` grew `AsyncSection` because the audit found the prototype had no
 * vocabulary for what every real pane is: asynchronous, failable, and empty
 * before it is full. Then every pane passed `ready(...)` and the loading, error
 * and empty branches were never rendered once — a vocabulary nobody could see
 * is a vocabulary nobody reviewed.
 *
 * So the lab drives them. One control in the lab chrome switches every
 * collection on both surfaces through the four states, which is the only way to
 * judge whether the empty copy is any good and whether the error is actionable.
 *
 * The app will not import this: in production each pane's state comes from its
 * own IPC call. What the app inherits is the SHAPE — `AsyncState<T>` — and the
 * fact that every pane was designed against all four of its cases.
 */
import * as React from "react";

import type { AsyncState } from "./kit";

export type FixtureMode = "ready" | "loading" | "error" | "empty";

const FixtureContext = React.createContext<FixtureMode>("ready");

export function FixtureProvider({
  mode,
  children,
}: {
  mode: FixtureMode;
  children: React.ReactNode;
}) {
  return <FixtureContext.Provider value={mode}>{children}</FixtureContext.Provider>;
}

/**
 * Turn a fixture into whichever state the lab is currently showing.
 *
 * `empty` returns the empty array rather than a flag, because a pane's empty
 * branch is chosen by `isEmpty(data)` — the same predicate production will use.
 * Faking it any other way would test a path the app does not have.
 */
export function useFixture<T>(data: T, emptyValue: T): AsyncState<T> {
  const mode = React.useContext(FixtureContext);
  const [retried, setRetried] = React.useState(false);

  switch (mode) {
    case "loading":
      return { status: "loading" };
    case "error":
      // Retry flips to ready, so the error's affordance is a real one rather
      // than a drawing of a button.
      return retried
        ? { status: "ready", data }
        : {
            status: "error",
            message: "Couldn't read this. Check the folder still exists.",
            onRetry: () => setRetried(true),
          };
    case "empty":
      return { status: "ready", data: emptyValue };
    default:
      return { status: "ready", data };
  }
}
