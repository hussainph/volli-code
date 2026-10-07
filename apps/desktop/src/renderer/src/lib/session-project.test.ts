import { afterEach, describe, expect, it } from "vite-plus/test";
import type { ChatSessionRecord, SessionListingRow } from "@volli/shared";

import { useProjectSessionsStore } from "@renderer/stores/project-sessions";
import { useTicketSessionRecordsStore } from "@renderer/stores/ticket-session-records";

import { rememberRemoteProject, resetRemoteOwnersForTest } from "./remote-owners";
import {
  forgetSessionProject,
  projectOfSession,
  rememberSessionProject,
  remoteHostOfSession,
} from "./session-project";

afterEach(() => {
  useProjectSessionsStore.setState({ byProject: {} });
  useTicketSessionRecordsStore.setState({ byTicket: {} });
  resetRemoteOwnersForTest();
  for (const id of ["started", "from-rail", "from-ticket", "boxed", "local"]) {
    forgetSessionProject(id);
  }
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

  it("keeps a Session found in a listing after the roster moves on (B1)", () => {
    useProjectSessionsStore.setState({
      byProject: {
        remote: {
          terminal: [],
          chat: [{ sessionId: "from-rail" } as ChatSessionRecord],
          provenance: {},
          read: {},
        },
      },
    });
    expect(projectOfSession("from-rail")).toBe("remote");
    useProjectSessionsStore.setState({ byProject: {} });
    expect(projectOfSession("from-rail")).toBe("remote");
  });

  it("names the host a Session's project was known on, whatever its link does now (B1)", () => {
    rememberSessionProject("boxed", "remote");
    rememberSessionProject("local", "local");
    expect(remoteHostOfSession("boxed")).toBeNull();
    rememberRemoteProject("remote", { hostId: "box", hostName: "hetzner-1" });
    expect(remoteHostOfSession("boxed")).toBe("hetzner-1");
    expect(remoteHostOfSession("local")).toBeNull();
    expect(remoteHostOfSession("unknown")).toBeNull();
  });
});
