import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { parseHarnessId } from "@volli/shared";
import type { HarnessId } from "@volli/shared";

import {
  listHarnessChannels,
  recordHarnessChannelEvent,
  recordHarnessLaunch,
} from "./harness-channel-repo";
import { openTestDb, type TestDb } from "./test-helpers";

let fixture: TestDb;

/** A registered harness's id, minted the only way one can be. */
const REGISTERED = parseHarnessId("my-harness") as HarnessId;

beforeEach(() => {
  fixture = openTestDb();
});

afterEach(() => {
  fixture.cleanup();
});

describe("harness_channel", () => {
  it("has nothing to say about a harness nobody has launched", () => {
    expect(listHarnessChannels(fixture.db)).toEqual([]);
  });

  it("records a launch with no delivery against it yet", () => {
    recordHarnessLaunch(fixture.db, "claude-code", 1000);
    expect(listHarnessChannels(fixture.db)).toEqual([
      { harnessId: "claude-code", lastLaunchAt: 1000, lastEventAt: null },
    ]);
  });

  it("records an event whose launch it never saw", () => {
    recordHarnessChannelEvent(fixture.db, "codex", 1000);
    expect(listHarnessChannels(fixture.db)).toEqual([
      { harnessId: "codex", lastLaunchAt: null, lastEventAt: 1000 },
    ]);
  });

  it("keeps the two columns independent, so a relaunch does not erase the last delivery", () => {
    recordHarnessLaunch(fixture.db, "claude-code", 1000);
    recordHarnessChannelEvent(fixture.db, "claude-code", 1200);
    recordHarnessLaunch(fixture.db, "claude-code", 5000);
    expect(listHarnessChannels(fixture.db)).toEqual([
      { harnessId: "claude-code", lastLaunchAt: 5000, lastEventAt: 1200 },
    ]);
  });

  it("keeps only the newest stamp of each kind", () => {
    recordHarnessLaunch(fixture.db, "opencode", 1000);
    recordHarnessLaunch(fixture.db, "opencode", 2000);
    recordHarnessChannelEvent(fixture.db, "opencode", 2100);
    recordHarnessChannelEvent(fixture.db, "opencode", 2200);
    expect(listHarnessChannels(fixture.db)).toEqual([
      { harnessId: "opencode", lastLaunchAt: 2000, lastEventAt: 2200 },
    ]);
  });

  it("keys every harness separately, built-in and registered alike", () => {
    recordHarnessLaunch(fixture.db, "cursor", 1000);
    recordHarnessLaunch(fixture.db, REGISTERED, 1100);
    recordHarnessChannelEvent(fixture.db, REGISTERED, 1200);
    expect(listHarnessChannels(fixture.db)).toEqual([
      { harnessId: "cursor", lastLaunchAt: 1000, lastEventAt: null },
      { harnessId: "my-harness", lastLaunchAt: 1100, lastEventAt: 1200 },
    ]);
  });

  // Only reachable by hand-editing the file: every write above goes through a
  // parsed id. An unreadable row is dropped rather than thrown at boot.
  it("drops a row whose id could no longer name a harness", () => {
    recordHarnessLaunch(fixture.db, "claude-code", 1000);
    fixture.db.prepare("INSERT INTO harness_channel (harness_id) VALUES ('Not A Slug')").run();
    expect(listHarnessChannels(fixture.db)).toEqual([
      { harnessId: "claude-code", lastLaunchAt: 1000, lastEventAt: null },
    ]);
  });
});
