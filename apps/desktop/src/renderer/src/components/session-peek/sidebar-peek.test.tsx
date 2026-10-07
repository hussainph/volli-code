// @vitest-environment jsdom
/**
 * VC-30 — the peek wiring both sidebars share.
 *
 * These cases pin the four rules the two hand-written copies disagreed about:
 * ONE failure convention for the pull, a refused delivery reported rather than
 * swallowed, exactly which acts read a Session, and a hold taken before any
 * order commit of the same render can land.
 */
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { SessionOrderMember } from "@volli/shared";
import { getChatClient, type InteractionSubmission } from "@volli/session-presentation";

import { forgetSessionProject, rememberSessionProject } from "@renderer/lib/session-project";
import { rememberRemoteProject, resetRemoteOwnersForTest } from "@renderer/lib/remote-owners";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";
import { useHeldSessionOrder, useSessionOrderStore } from "@renderer/stores/session-order";

import {
  createSidebarPeekPorts,
  sessionGlyphName,
  UnreadDot,
  usePeekHold,
  type SidebarPeekSurface,
} from "./sidebar-peek";

vi.mock("@volli/session-presentation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@volli/session-presentation")>()),
  getChatClient: vi.fn(),
}));

const chatClient = vi.mocked(getChatClient);

const CONTENT = {
  sessionId: "s1",
  entries: [{ at: 1, role: "assistant" as const, text: "Ran the suite", tools: [] }],
  question: null,
  turns: 1,
  turnDepth: 0,
  unreadable: 0,
  lastActivityAt: 1,
};

const peekContent = vi.fn(async () => ({ ok: true as const, content: CONTENT }));

/** A decision with the words that could not ride it — the two-act answer (§0.6). */
const SUBMISSION: InteractionSubmission = {
  resolution: { optionIds: ["yes"], response: null },
  message: "and then run the smokes",
};

/** The four things a surface answers for, each a spy — typed as the port takes them. */
function surface() {
  return {
    openRow: vi.fn<SidebarPeekSurface["openRow"]>(),
    openTicket: vi.fn<SidebarPeekSurface["openTicket"]>(),
    showConversation: vi.fn<SidebarPeekSurface["showConversation"]>(),
    setRead: vi.fn<SidebarPeekSurface["setRead"]>(),
  };
}

/** The resident client a card acts through, with both acts answerable per case. */
function client(answers: { resolved?: boolean; delivery?: "delivered" | "recorded" | "refused" }): {
  resolveInteraction: ReturnType<typeof vi.fn>;
  submit: ReturnType<typeof vi.fn>;
} {
  return {
    resolveInteraction: vi.fn(async () => answers.resolved ?? true),
    submit: vi.fn(async () => answers.delivery ?? "delivered"),
  };
}

const adoptChatSession = vi.fn();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  Object.defineProperty(window, "api", {
    configurable: true,
    value: { sessions: { peekContent } },
  });
  useChatSessionsStore.setState({ adoptChatSession });
  useSessionOrderStore.setState({ held: {}, holds: 0 });
});

describe("createSidebarPeekPorts · readContent", () => {
  it("keeps the pull identity when a surface's action ports are rebuilt", () => {
    const first = createSidebarPeekPorts(surface());
    const next = createSidebarPeekPorts(surface());
    expect(next.readContent).toBe(first.readContent);
    expect(next.openSession).not.toBe(first.openSession);
  });

  it("pulls one fold, adopting nothing and reading nothing", async () => {
    const ports = createSidebarPeekPorts(surface());
    const surfaces = surface();
    const read = createSidebarPeekPorts(surfaces);

    await expect(ports.readContent("s1")).resolves.toEqual(CONTENT);
    await read.readContent("s1");

    expect(peekContent).toHaveBeenCalledWith({ sessionId: "s1", refine: false });
    expect(adoptChatSession).not.toHaveBeenCalled();
    // A peek never reads (D6).
    expect(surfaces.setRead).not.toHaveBeenCalled();
  });

  it("refuses a remote Session's peek with the host's words, reading nothing here (VC-713)", async () => {
    rememberSessionProject("remote-session", "remote");
    rememberRemoteProject("remote", { hostId: "box", hostName: "hetzner-1" });
    try {
      await expect(createSidebarPeekPorts(surface()).readContent("remote-session")).rejects.toThrow(
        "Not available on hetzner-1 yet",
      );
      expect(peekContent).not.toHaveBeenCalled();
    } finally {
      forgetSessionProject("remote-session");
      resetRemoteOwnersForTest();
    }
  });

  it("forwards utility refinement only when explicitly requested", async () => {
    const target = surface();
    await expect(createSidebarPeekPorts(target).readContent("s1", true)).resolves.toEqual(CONTENT);
    expect(peekContent).toHaveBeenCalledWith({ sessionId: "s1", refine: true });
    expect(adoptChatSession).not.toHaveBeenCalled();
    expect(target.setRead).not.toHaveBeenCalled();
  });

  it("rejects when the door refuses, rather than answering an empty peek", async () => {
    peekContent.mockResolvedValueOnce({
      ok: false,
      error: "no such session",
    } as unknown as Awaited<ReturnType<typeof peekContent>>);
    const ports = createSidebarPeekPorts(surface());

    // One convention for both sidebars: a refusal is a FAILED card, and
    // `use-peek-content.ts` caches an answer but not a rejection, so the next
    // hover tries again instead of remembering a bridge failure forever.
    await expect(ports.readContent("s1")).rejects.toThrow("no such session");
  });
});

describe("createSidebarPeekPorts · answer", () => {
  it("adopts, resolves, delivers the trailing words, and reads the Session", async () => {
    const acts = client({});
    chatClient.mockReturnValue(acts as unknown as ReturnType<typeof getChatClient>);
    const target = surface();

    await expect(createSidebarPeekPorts(target).answer("s1", "q1", SUBMISSION)).resolves.toBe(true);

    expect(adoptChatSession).toHaveBeenCalledWith("s1");
    expect(acts.resolveInteraction).toHaveBeenCalledWith("q1", SUBMISSION.resolution);
    expect(acts.submit).toHaveBeenCalledWith(
      expect.objectContaining({ text: "and then run the smokes" }),
      "queue",
    );
    expect(target.setRead).toHaveBeenCalledWith("s1", false);
  });

  it("reports a REFUSED trailing message rather than claiming the answer landed", async () => {
    const acts = client({ delivery: "refused" });
    chatClient.mockReturnValue(acts as unknown as ReturnType<typeof getChatClient>);
    const target = surface();

    // The decision landed; the words did not. A card that latched shut on
    // "Sent" here would be reporting an act that did not happen — the left
    // band's hand-rolled path returned `true` for exactly this case.
    await expect(createSidebarPeekPorts(target).answer("s1", "q1", SUBMISSION)).resolves.toBe(
      false,
    );
    expect(target.setRead).not.toHaveBeenCalled();
  });

  it("refuses when the decision itself was not delivered, and sends no words after it", async () => {
    const acts = client({ resolved: false });
    chatClient.mockReturnValue(acts as unknown as ReturnType<typeof getChatClient>);
    const target = surface();

    await expect(createSidebarPeekPorts(target).answer("s1", "q1", SUBMISSION)).resolves.toBe(
      false,
    );
    expect(acts.submit).not.toHaveBeenCalled();
    expect(target.setRead).not.toHaveBeenCalled();
  });

  it("refuses a Session this window can hold no client for", async () => {
    chatClient.mockReturnValue(undefined);
    const target = surface();

    await expect(createSidebarPeekPorts(target).answer("s1", "q1", SUBMISSION)).resolves.toBe(
      false,
    );
    expect(target.setRead).not.toHaveBeenCalled();
  });

  it("answers a bare decision with no trailing message", async () => {
    const acts = client({});
    chatClient.mockReturnValue(acts as unknown as ReturnType<typeof getChatClient>);
    const target = surface();

    await expect(
      createSidebarPeekPorts(target).answer("s1", "q1", {
        resolution: { optionIds: ["yes"], response: null },
        message: null,
      }),
    ).resolves.toBe(true);

    expect(acts.submit).not.toHaveBeenCalled();
    expect(target.setRead).toHaveBeenCalledWith("s1", false);
  });
});

describe("createSidebarPeekPorts · sendMessage", () => {
  it("adopts, submits, and reads the Session", async () => {
    const acts = client({});
    chatClient.mockReturnValue(acts as unknown as ReturnType<typeof getChatClient>);
    const target = surface();

    await expect(createSidebarPeekPorts(target).sendMessage("s1", "hello")).resolves.toBe(true);

    expect(adoptChatSession).toHaveBeenCalledWith("s1");
    expect(acts.submit).toHaveBeenCalledWith(expect.objectContaining({ text: "hello" }), "queue");
    expect(target.setRead).toHaveBeenCalledWith("s1", false);
  });

  it("reports a refusal, and reads nothing", async () => {
    const acts = client({ delivery: "refused" });
    chatClient.mockReturnValue(acts as unknown as ReturnType<typeof getChatClient>);
    const target = surface();

    await expect(createSidebarPeekPorts(target).sendMessage("s1", "hello")).resolves.toBe(false);
    expect(target.setRead).not.toHaveBeenCalled();
  });

  it("refuses without a client", async () => {
    chatClient.mockReturnValue(undefined);
    const target = surface();

    await expect(createSidebarPeekPorts(target).sendMessage("s1", "hello")).resolves.toBe(false);
    expect(target.setRead).not.toHaveBeenCalled();
  });
});

describe("createSidebarPeekPorts · the acts that read", () => {
  it("opens a row through the surface's own activation, and reads it", () => {
    const target = surface();

    createSidebarPeekPorts(target).openSession("chat:s1");

    expect(target.openRow).toHaveBeenCalledWith("chat:s1");
    expect(target.setRead).toHaveBeenCalledWith("s1", false);
  });

  it("opens a folder row without inventing a Session to read", () => {
    const target = surface();

    createSidebarPeekPorts(target).openSession("ticket:t1");

    expect(target.openRow).toHaveBeenCalledWith("ticket:t1");
    expect(target.setRead).not.toHaveBeenCalled();
  });

  it("shows the conversation overlay, and reads the Session", () => {
    const target = surface();

    createSidebarPeekPorts(target).viewConversation("s1");

    expect(target.showConversation).toHaveBeenCalledWith("s1");
    expect(target.setRead).toHaveBeenCalledWith("s1", false);
  });

  it("passes a ticket and an explicit read straight through", () => {
    const target = surface();
    const ports = createSidebarPeekPorts(target);

    ports.openTicket("t1");
    ports.setRead("s1", true);

    expect(target.openTicket).toHaveBeenCalledWith("t1");
    expect(target.setRead).toHaveBeenCalledWith("s1", true);
  });
});

describe("usePeekHold", () => {
  let root: Root | null = null;
  let container: HTMLElement | null = null;

  const MEMBERS: readonly SessionOrderMember[] = [
    { id: "a1", phase: "resting" },
    { id: "a2", phase: "working" },
  ];

  function Band({ holding, order }: { holding: boolean; order?: boolean }) {
    // Declared in the band's own order: the commit effect first, the hold
    // after it. Layout effects run before passive ones either way, which is
    // the whole point of the case below.
    useHeldSessionOrder("project:p1", order === true ? MEMBERS : []);
    usePeekHold(holding);
    return null;
  }

  async function render(node: React.ReactElement): Promise<void> {
    await act(async () => {
      root?.render(node);
    });
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    if (root !== null) await act(async () => root?.unmount());
    container?.remove();
    root = null;
    container = null;
  });

  it("takes the hold while holding, and releases it when it stops", async () => {
    await render(<Band holding />);
    expect(useSessionOrderStore.getState().holds).toBe(1);

    await render(<Band holding={false} />);
    expect(useSessionOrderStore.getState().holds).toBe(0);
  });

  it("releases the hold on unmount, which is what lands the pending moves", async () => {
    await render(<Band holding />);
    expect(useSessionOrderStore.getState().holds).toBe(1);

    await act(async () => root?.unmount());
    root = null;

    expect(useSessionOrderStore.getState().holds).toBe(0);
  });

  it("takes the hold before a commit of the same render can land", async () => {
    // A reviewer found moves landing as the pointer arrived: the hold was a
    // passive effect, and `useHeldSessionOrder`'s commit is one too, so a band
    // that began holding in the same commit committed first and moved a row out
    // from under the pointer. Held first, the band commits nothing at all.
    await render(<Band holding order />);

    expect(useSessionOrderStore.getState().holds).toBe(1);
    expect(useSessionOrderStore.getState().held["project:p1"]).toBeUndefined();
  });
});

describe("UnreadDot", () => {
  it("draws the blue dot and says its word out of band", () => {
    const html = renderToStaticMarkup(<UnreadDot />);

    expect(html).toContain("data-unread-dot");
    expect(html).toContain("bg-info");
    expect(html).toContain("Unread");
  });
});

describe("sessionGlyphName", () => {
  it("names the vendor alone where the row carries no state", () => {
    expect(sessionGlyphName("Claude Code", null)).toBe("Claude Code");
  });

  it("collapses every busy state into one word", () => {
    expect(sessionGlyphName("Claude Code", "working")).toBe("Claude Code · Working");
    expect(sessionGlyphName("Claude Code", "setup")).toBe("Claude Code · Working");
    expect(sessionGlyphName("Claude Code", "starting")).toBe("Claude Code · Working");
  });

  it("keeps waiting and a died turn apart from the resting states", () => {
    expect(sessionGlyphName("anthropic", "waiting")).toBe("anthropic · Waiting for you");
    expect(sessionGlyphName("anthropic", "interrupted")).toBe("anthropic · Interrupted");
    expect(sessionGlyphName("anthropic", "error")).toBe("anthropic · Interrupted");
    expect(sessionGlyphName("Chat", "idle")).toBe("Chat · Idle");
    expect(sessionGlyphName("Chat", "ready")).toBe("Chat · Idle");
    expect(sessionGlyphName("Claude Code", "parked")).toBe("Claude Code · Parked");
    expect(sessionGlyphName("Claude Code", "exited")).toBe("Claude Code · Exited");
    expect(sessionGlyphName("Claude Code", "stopped")).toBe("Claude Code · Stopped");
  });
});
