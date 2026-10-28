import { expect, test } from "vite-plus/test";

import * as cloud from "./index";

test("the cloud entry point exposes each module", () => {
  for (const name of [
    "readActor",
    "readAgentTokenClaims",
    "reviewRequestee",
    "readActivityEvent",
    "isBoardEventKind",
    "parseGatewayGrantClaims",
    "parseId",
    "isJobKind",
    "positionBetween",
    "transcriptPackKey",
    "parseStreamChunkOps",
    "renderTicketKey",
    "canSeeSession",
    "decideAutomationChange",
    "decideArming",
    "decideScheduleArming",
    "decideScheduleFire",
    "decideAutomationRunRouting",
    "decideMemberChange",
    "decideMoveTickets",
    "decideCreateProject",
    "boardIntentDigest",
    "parseRunnerCapabilities",
    "migrationDocument",
    "foldCloudSessionState",
    "extractGithubEvent",
    "sessionPlaceState",
    "runnerPlaceAvailability",
  ]) {
    expect(typeof (cloud as Record<string, unknown>)[name]).toBe("function");
  }
});
