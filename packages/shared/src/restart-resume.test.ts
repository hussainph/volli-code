import { describe, expect, it } from "vite-plus/test";

import {
  isRestartResumeCommandId,
  RECOVERED_TURN_INTERRUPTED_DETAIL,
  restartResumeCommandId,
} from "./restart-resume";

describe("the frozen restart-resume derivations (VC-450)", () => {
  it("scopes the command by attachment and turn, under a suffix readers recognise", () => {
    const id = restartResumeCommandId("attachment-1", "turn-1");
    expect(id).toBe("attachment-1:turn-1:restart-resume");
    expect(isRestartResumeCommandId(id)).toBe(true);
    expect(isRestartResumeCommandId("schedule-1:resume")).toBe(false);
    expect(isRestartResumeCommandId("command-1")).toBe(false);
  });

  it("keeps the recovery warning's durable sentence", () => {
    expect(RECOVERED_TURN_INTERRUPTED_DETAIL).toBe(
      "A recovered Pi turn ended before its completion marker was committed.",
    );
  });
});
