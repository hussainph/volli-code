import { expect, test } from "vite-plus/test";

import * as cloud from "./index";

test("the cloud entry point exposes each module", () => {
  for (const name of [
    "readActor",
    "readActivityEvent",
    "isBoardEventKind",
    "parseGatewayGrantClaims",
    "parseId",
    "isJobKind",
    "positionBetween",
    "transcriptPackKey",
    "renderTicketKey",
    "canSeeSession",
    "decideMemberChange",
    "decideMoveTickets",
    "decideCreateProject",
    "boardIntentDigest",
    "parseRunnerCapabilities",
    "migrationDocument",
  ]) {
    expect(typeof (cloud as Record<string, unknown>)[name]).toBe("function");
  }
});
