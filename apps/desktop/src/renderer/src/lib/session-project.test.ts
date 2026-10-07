import { afterEach, describe, expect, it } from "vite-plus/test";
import type { ChatSessionRecord, SessionListingRow } from "@volli/shared";

import { useExperimentsStore } from "@renderer/stores/experiments";
import { useHostConnectionStore } from "@renderer/stores/host-connection";
import { createFakeHostSource, hostSnapshot, remoteHost } from "@renderer/stores/host-sources";
import { useProjectSessionsStore } from "@renderer/stores/project-sessions";
import { useTicketSessionRecordsStore } from "@renderer/stores/ticket-session-records";

import {
  forgetSessionProject,
  projectOfSession,
  rememberSessionProject,
  remoteHostOfSession,
} from "./session-project";

afterEach(() => {
  useProjectSessionsStore.setState({ byProject: {} });
  useTicketSessionRecordsStore.setState({ byTicket: {} });
  useExperimentsStore.setState({ snapshot: null });
});

describe("a Session's project (VC-713)", () => {
  it("is what the chat store recorded, then what the listings name, else nothing", () => {
    rememberSessionProject("started", "remote");
    useProjectSessionsStore.setState({
      byProject: {
        local: { terminal: [], chat: [], provenance: {}, read: {} },
        remote: {
          terminal: [],
          chat: [{ sessionId: "from-rail" } as ChatSessionRecord],
          provenance: {},
          read: {},
        },
      },
    });
    useTicketSessionRecordsStore.setState({
      byTicket: {
        t1: [
          { kind: "terminal", record: { id: "pty" } } as SessionListingRow,
          {
            kind: "chat",
            record: { sessionId: "from-ticket", projectId: "remote" },
          } as SessionListingRow,
        ],
      },
    });
    expect(projectOfSession("started")).toBe("remote");
    expect(projectOfSession("from-rail")).toBe("remote");
    expect(projectOfSession("from-ticket")).toBe("remote");
    expect(projectOfSession("pty")).toBeNull();
    forgetSessionProject("started");
    expect(projectOfSession("started")).toBeNull();
  });

  it("names the remote host only with cloud on, and never for This Mac's", () => {
    rememberSessionProject("boxed", "remote");
    rememberSessionProject("local", "local");
    expect(remoteHostOfSession("boxed")).toBeNull();
    useExperimentsStore.setState({
      snapshot: { cloud: { enabled: true, source: "storage" } } as never,
    });
    const detach = useHostConnectionStore
      .getState()
      .attach(
        createFakeHostSource(hostSnapshot([remoteHost("box", "hetzner-1")], { remote: "box" })),
      );
    try {
      expect(remoteHostOfSession("boxed")).toBe("hetzner-1");
      expect(remoteHostOfSession("local")).toBeNull();
      expect(remoteHostOfSession("unknown")).toBeNull();
    } finally {
      detach();
      forgetSessionProject("boxed");
      forgetSessionProject("local");
    }
  });
});
