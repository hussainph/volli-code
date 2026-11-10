/** React owns only the observed-time escalation; vocabulary and transcript selection stay pure. */
import * as React from "react";
import {
  escalateTurnActivity,
  selectTurnActivity,
  type TurnActivity,
  type TurnActivityInput,
} from "./turn-activity";

/** Pass the SessionView already read by ChatPlane; no additional store or backend fields. */
export function useTurnActivity(sessionId: string, input: TurnActivityInput): TurnActivity | null {
  const { messages, working, turnActive, projection, liveCompaction } = input;
  const selected = React.useMemo(
    () =>
      selectTurnActivity(sessionId, { messages, working, turnActive, projection, liveCompaction }),
    [sessionId, messages, working, turnActive, projection, liveCompaction],
  );
  const key = selected?.key;
  const kind = selected?.activity;
  // The token changes only on a real activity transition, not on streamed argument/text frames.
  const token = React.useMemo(() => ({ key, kind }), [key, kind]);
  const [elapsed, setElapsed] = React.useState<typeof token | null>(null);
  React.useEffect(() => {
    if (kind !== "reason" && kind !== "run") return;
    const timer = setTimeout(() => setElapsed(token), 20_000);
    return () => clearTimeout(timer);
  }, [kind, token]);
  // No start timestamp exists for reasoning. Measure the activity's observed dwell, never turn age.
  return selected !== null && elapsed === token ? escalateTurnActivity(selected) : selected;
}
