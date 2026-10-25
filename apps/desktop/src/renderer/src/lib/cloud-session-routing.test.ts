// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { LOCAL_LAUNCH } from "@volli/shared";
import { adoptLaunch } from "@renderer/stores/launch";
import { chatTransportFor, sessionCommandFor, sessionPictureFor } from "@renderer/chat/transport";
import { renameChatSession } from "@renderer/chat/rename";
import { markSessionRead } from "@renderer/stores/session-read-mark";
import { subscribeProjectSessionActivity } from "@renderer/stores/project-sessions";
import { subscribeTicketSessionActivity } from "@renderer/stores/ticket-session-records";
import {
  sessionListingReaderForProject,
  sessionListingReaderForTicket,
} from "./session-listing-reader";
import { createSidebarPeekPorts } from "@renderer/components/session-peek/sidebar-peek";

const toast = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: Object.assign(toast, { error: vi.fn() }) }));
afterEach(() => {
  adoptLaunch(LOCAL_LAUNCH);
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("cloud Session routing", () => {
  it("never falls back to local Session doors, including before the cloud client connects", async () => {
    adoptLaunch({ store: "cloud", userId: "u", backendUrl: "https://example.convex.cloud" });
    const local = vi.fn();
    vi.stubGlobal("api", {
      sessions: {
        onActivity: local,
        rename: local,
        setRead: local,
        peekContent: local,
        list: local,
        listForTicket: local,
      },
    });
    expect(await sessionListingReaderForProject("p").list({ projectId: "p" })).toMatchObject({
      ok: false,
    });
    expect(
      await sessionListingReaderForTicket("unknown").listForTicket({ ticketId: "unknown" }),
    ).toMatchObject({ ok: false });
    const transport = chatTransportFor("p");
    await expect(transport.rpc.session.snapshot.query({ sessionId: "s" })).rejects.toThrow(
      "not connected",
    );
    await expect(
      sessionCommandFor("p")({
        commandId: "c",
        sessionId: "s",
        command: { kind: "session.interrupt" },
      } as never),
    ).rejects.toThrow("Not available yet in cloud");
    await expect(sessionPictureFor("p")({ sessionId: "s", name: "p" } as never)).rejects.toThrow(
      "Not available yet in cloud",
    );
    subscribeProjectSessionActivity()();
    subscribeTicketSessionActivity()();
    expect(await renameChatSession("s", "New title")).toBe(false);
    const write = vi.fn();
    await markSessionRead(
      { sessionId: "s", unread: false },
      { readState: () => ({ unreadSince: null }), write },
    );
    expect(write).not.toHaveBeenCalled();
    const peek = createSidebarPeekPorts({
      openRow: vi.fn(),
      openTicket: vi.fn(),
      showConversation: vi.fn(),
      setRead: vi.fn(),
    });
    await expect(peek.readContent("s")).rejects.toThrow("Not available yet in cloud");
    expect(await peek.answer("s", "i", {} as never)).toBe(false);
    expect(local).not.toHaveBeenCalled();
  });
});
