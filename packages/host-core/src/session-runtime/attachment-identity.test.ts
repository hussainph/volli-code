import { describe, expect, it, vi } from "vite-plus/test";

import { createAttachmentIdentities } from "./attachment-identity";

function harness() {
  let minted = 0;
  const mint = vi.fn(() => `tok-${++minted}`);
  const revoke = vi.fn();
  const ticketDisplayIdOf = vi.fn((ticketId: string) => (ticketId === "t-1" ? "VC-270" : null));
  const identities = createAttachmentIdentities({ mint, revoke, ticketDisplayIdOf });
  return { identities, mint, revoke, ticketDisplayIdOf };
}

const attachment = { sessionId: "session-1", attachmentId: "attachment-1", ticketId: "t-1" };

describe("createAttachmentIdentities", () => {
  it("mints one token per attachment and hands every caller the same identity", () => {
    // The registry retires an attachment's previous token on every mint, so
    // a second mint for the shell host would silently break the token the
    // execute tool already exported. One mint, one object, two callers.
    const { identities, mint, ticketDisplayIdOf } = harness();

    const forExecute = identities.resolve(attachment);
    const forShells = identities.resolve(attachment);

    expect(forShells).toBe(forExecute);
    expect(forExecute).toEqual({
      sessionId: "session-1",
      ticketDisplayId: "VC-270",
      sessionToken: "tok-1",
    });
    expect(mint).toHaveBeenCalledTimes(1);
    expect(mint).toHaveBeenCalledWith({ sessionId: "session-1", attachmentId: "attachment-1" });
    expect(ticketDisplayIdOf).toHaveBeenCalledTimes(1);
  });

  it("keeps attachments apart, so a reattachment mints afresh without touching a live one", () => {
    const { identities, mint } = harness();
    const first = identities.resolve(attachment);
    const second = identities.resolve({ ...attachment, attachmentId: "attachment-2" });

    expect(second).not.toBe(first);
    expect(second.sessionToken).toBe("tok-2");
    expect(mint).toHaveBeenCalledTimes(2);
  });

  it("revokes and forgets on release, and a later resolve for the same attachment mints again", () => {
    const { identities, mint, revoke } = harness();
    identities.resolve(attachment);

    identities.release("attachment-1");
    expect(revoke).toHaveBeenCalledWith("attachment-1");
    // Releasing what was never resolved is a no-op on this side; the
    // registry's own revoke is already a no-op for an unknown attachment.
    identities.release("attachment-9");
    expect(revoke).toHaveBeenCalledTimes(2);

    expect(identities.resolve(attachment).sessionToken).toBe("tok-2");
    expect(mint).toHaveBeenCalledTimes(2);
  });

  it("carries no ticket display id for a ticketless Session, and none for a ticket it cannot name", () => {
    const { identities, ticketDisplayIdOf } = harness();
    expect(identities.resolve({ ...attachment, ticketId: null }).ticketDisplayId).toBeNull();
    expect(ticketDisplayIdOf).not.toHaveBeenCalled();
    expect(
      identities.resolve({ ...attachment, attachmentId: "a-2", ticketId: "t-gone" })
        .ticketDisplayId,
    ).toBeNull();
  });
});
