import { expect, test } from "vite-plus/test";

import * as cloud from "./index";

test("the cloud entry point exposes each module", () => {
  for (const name of [
    "readActor",
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
    "decideMemberChange",
    "decideMoveTickets",
    "decideCreateProject",
    "boardIntentDigest",
    "parseRunnerCapabilities",
    "migrationDocument",
    "foldCloudSessionState",
    "extractGithubEvent",
  ]) {
    expect(typeof (cloud as Record<string, unknown>)[name]).toBe("function");
  }
});
