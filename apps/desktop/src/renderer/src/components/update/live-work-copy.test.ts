import { describe, expect, it } from "vite-plus/test";

import { liveWorkLines } from "./live-work-copy";

describe("liveWorkLines", () => {
  it("says nothing when nothing is at stake", () => {
    expect(liveWorkLines({ busyCommands: [], openAgentSessions: 0, unsavedDrafts: [] })).toEqual(
      [],
    );
  });

  it("names each surface separately, with counts — never one blended 'live sessions' number", () => {
    expect(
      liveWorkLines({
        busyCommands: ["claude", "pnpm"],
        openAgentSessions: 1,
        unsavedDrafts: ["notes.md"],
      }),
    ).toEqual([
      "2 terminals are running foreground work (claude, pnpm). Restarting ends them.",
      "1 agent Session has a turn open. Restarting interrupts it.",
      "“notes.md” has unsaved changes. Restarting discards them.",
    ]);
  });

  it("singular terminal names its one process", () => {
    expect(
      liveWorkLines({ busyCommands: ["claude"], openAgentSessions: 0, unsavedDrafts: [] }),
    ).toEqual(["1 terminal is running “claude”. Restarting ends it."]);
  });

  it("plural agent Sessions and a truncated draft list stay readable", () => {
    expect(
      liveWorkLines({
        busyCommands: [],
        openAgentSessions: 3,
        unsavedDrafts: ["a.md", "b.md", "c.md", "d.md", "e.md", "f.md"],
      }),
    ).toEqual([
      "3 agent Sessions have turns open. Restarting interrupts them.",
      "6 files have unsaved changes (a.md, b.md, c.md, d.md, and 2 more). Restarting discards them.",
    ]);
  });

  it("a handful of drafts is named in full — no truncation below the cap", () => {
    expect(
      liveWorkLines({ busyCommands: [], openAgentSessions: 0, unsavedDrafts: ["a.md", "b.md"] }),
    ).toEqual(["2 files have unsaved changes (a.md, b.md). Restarting discards them."]);
  });

  it("duplicate process names collapse in the list but keep the true count", () => {
    expect(
      liveWorkLines({
        busyCommands: ["claude", "claude"],
        openAgentSessions: 0,
        unsavedDrafts: [],
      }),
    ).toEqual(["2 terminals are running foreground work (claude). Restarting ends them."]);
  });
});
