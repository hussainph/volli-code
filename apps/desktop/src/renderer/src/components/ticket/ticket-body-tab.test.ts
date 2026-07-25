import { describe, expect, it } from "vite-plus/test";

import { TICKET_BODY_TAB_ID, isTicketBodyTabId, normalizeTicketBodyTabId } from "./ticket-body-tab";

describe("normalizeTicketBodyTabId", () => {
  it('resolves the legacy persisted "doc" key to the Ticket Body tab id', () => {
    expect(normalizeTicketBodyTabId("doc")).toBe(TICKET_BODY_TAB_ID);
    expect(isTicketBodyTabId("doc")).toBe(true);
  });
});
