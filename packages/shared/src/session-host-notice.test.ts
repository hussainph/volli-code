import { describe, expect, it } from "vite-plus/test";

import {
  SESSION_HOST_NOTICE_METADATA_KIND,
  sessionHostNoticeMetadata,
} from "./session-host-notice";

describe("sessionHostNoticeMetadata", () => {
  it("wraps a Subagent Session fact in the shared host marker", () => {
    const notice = {
      kind: "subagent",
      childSessionId: "session-child",
      title: "Review the tests",
      state: "completed",
      reason: null,
    } as const;

    expect(sessionHostNoticeMetadata(notice)).toEqual({
      kind: SESSION_HOST_NOTICE_METADATA_KIND,
      notice,
    });
  });

  it("wraps a Browser Tab hold fact in the same marker, so clients read one envelope", () => {
    const notice = {
      kind: "browser-hold",
      tabId: "3f9c0a2e-6f1b-4f0a-9a1e-0d2c4b6a8e10",
      tabTitle: "Ticket VC-330",
      tabHostname: "volli.dev",
      action: "person-took",
    } as const;

    expect(sessionHostNoticeMetadata(notice)).toEqual({
      kind: SESSION_HOST_NOTICE_METADATA_KIND,
      notice,
    });
  });
});
