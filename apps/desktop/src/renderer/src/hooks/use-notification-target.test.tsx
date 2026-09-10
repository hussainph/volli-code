// @vitest-environment jsdom
/**
 * What this window tells main it is showing (VC-295 round 4), across the seam
 * that round 3 left open.
 *
 * Tested through the hook against the real stores and the real reveal slot,
 * because the seam IS the subject: the chat plane's blocker draws the Attention
 * a click revealed, and this report has to name the same one. Deriving it from
 * the projection alone meant the row showed `older` while the report said
 * `newer` was visible — so the alert for `newer`, the problem NOT on screen,
 * was suppressed.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import type { NotificationTarget, Project } from "@volli/shared";

import {
  releaseSessionItemReveal,
  requestSessionItemReveal,
  takeSessionItemReveal,
} from "@renderer/chat/session-item-reveal";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";
import { useProjectsStore } from "@renderer/stores/projects";
import { DEFAULT_WORKSPACE_UI, useWorkspaceStore } from "@renderer/stores/workspace";

import { useNotificationTargetReport } from "./use-notification-target";

const PROJECT = "p1";
const TICKET = "t1";
const SESSION = "s1";
const OLDER = "attention-older";
const NEWER = "attention-newer";

let reports: (NotificationTarget | null)[];
let container: HTMLDivElement;
let root: Root;

/** An attention as a ledger fold reports it. */
const attention = (id: string) => ({
  id,
  kind: "adapter_disconnected",
  attachmentId: null,
  detail: null,
  diagnostic: null,
});

function Probe(): null {
  useNotificationTargetReport();
  return null;
}

/** The window: a ticket workspace with this Session's chat tab in front. */
function seedStores(): void {
  useProjectsStore.setState({
    projects: [{ id: PROJECT, name: "Volli" } as Project],
    selectedProjectId: PROJECT,
  });
  useWorkspaceStore.setState({
    byProject: {
      [PROJECT]: {
        ...DEFAULT_WORKSPACE_UI,
        nav: "home",
        openTicketId: TICKET,
        ticketTabs: { [TICKET]: { active: `chat:${SESSION}` } },
      },
    },
  } as never);
  // Two live Attentions; `primary` is the newest, which is what the blocker row
  // draws when no click has said otherwise.
  useChatSessionsStore.setState({
    sessions: {
      [SESSION]: {
        projection: {
          interactions: { active: [], resolved: [] },
          attention: { active: [attention(OLDER), attention(NEWER)], primary: attention(NEWER) },
        },
      },
    },
  } as never);
}

const lastReport = (): NotificationTarget | null => reports.at(-1) ?? null;

beforeEach(() => {
  reports = [];
  (globalThis as unknown as { api: unknown }).api = {
    notifications: {
      setActiveTarget: (target: NotificationTarget | null) => reports.push(target),
    },
  };
  seedStores();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  releaseSessionItemReveal(SESSION);
  takeSessionItemReveal(SESSION);
  useChatSessionsStore.setState({ sessions: {} } as never);
  useWorkspaceStore.setState({ byProject: {} } as never);
  useProjectsStore.setState({ projects: [], selectedProjectId: null });
});

describe("useNotificationTargetReport", () => {
  it("reports the newest Attention while nothing has overridden the row", async () => {
    await act(async () => {
      root.render(<Probe />);
    });

    expect(lastReport()).toEqual({
      kind: "session",
      projectId: PROJECT,
      ticketId: TICKET,
      sessionId: SESSION,
      interactionId: null,
      attentionId: NEWER,
    });
  });

  it("follows the reveal: after a click selects the older Attention, that is what it reports", async () => {
    await act(async () => {
      root.render(<Probe />);
    });

    // The click's request, and the plane claiming it — the same two calls the
    // executor and the chat plane make.
    await act(async () => {
      requestSessionItemReveal(SESSION, { interactionId: null, attentionId: OLDER });
      takeSessionItemReveal(SESSION);
    });

    expect(lastReport()).toMatchObject({ sessionId: SESSION, attentionId: OLDER });
    // The pin: never the primary while the row is drawing something else, or
    // the alert for the problem that is NOT on screen is suppressed.
    expect(lastReport()).not.toMatchObject({ attentionId: NEWER });
  });

  it("goes back to the newest Attention when the plane releases the override", async () => {
    await act(async () => {
      root.render(<Probe />);
    });
    await act(async () => {
      requestSessionItemReveal(SESSION, { interactionId: null, attentionId: OLDER });
      takeSessionItemReveal(SESSION);
    });

    await act(async () => {
      releaseSessionItemReveal(SESSION);
    });

    expect(lastReport()).toMatchObject({ attentionId: NEWER });
  });

  it("ignores a reveal naming an Attention that has since cleared", async () => {
    // The row falls back to the primary in that case, and so does this.
    await act(async () => {
      root.render(<Probe />);
    });

    await act(async () => {
      requestSessionItemReveal(SESSION, { interactionId: null, attentionId: "attention-gone" });
      takeSessionItemReveal(SESSION);
    });

    expect(lastReport()).toMatchObject({ attentionId: NEWER });
  });

  it("follows a revealed question too, when several are open (round 5)", async () => {
    // The plane draws the revealed question in the card slot (or scrolls to
    // its row), so the report names it — not the first open one — and an alert
    // about the first is still delivered.
    useChatSessionsStore.setState({
      sessions: {
        [SESSION]: {
          projection: {
            interactions: { active: [{ id: "ask-1" }, { id: "ask-2" }], resolved: [] },
            attention: { active: [], primary: null },
          },
        },
      },
    } as never);
    await act(async () => {
      root.render(<Probe />);
    });
    expect(lastReport()).toMatchObject({ interactionId: "ask-1", attentionId: null });

    await act(async () => {
      requestSessionItemReveal(SESSION, { interactionId: "ask-2", attentionId: null });
      takeSessionItemReveal(SESSION);
    });

    expect(lastReport()).toMatchObject({ interactionId: "ask-2", attentionId: null });
  });

  it("keeps another Session's reveal out of this window's report", async () => {
    await act(async () => {
      root.render(<Probe />);
    });

    await act(async () => {
      requestSessionItemReveal("other-session", { interactionId: null, attentionId: OLDER });
      takeSessionItemReveal("other-session");
    });

    expect(lastReport()).toMatchObject({ attentionId: NEWER });
    releaseSessionItemReveal("other-session");
  });
});
