// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { LOCAL_LAUNCH, type Ticket } from "@volli/shared";
import { toast } from "sonner";
import { fakeCloud } from "@renderer/stores/cloud-board/fake-cloud.test-support";
import { ConvexAutomationSource } from "@renderer/stores/cloud-automations/source";
import { P, A, R, U, T, run } from "@renderer/stores/cloud-automations/fixtures.test-support";
import { installCloudAutomationSource } from "@renderer/stores/automation-source";
import { adoptLaunch } from "@renderer/stores/launch";
import { useCloudPlacesStore } from "@renderer/lib/cloud-places";
import { useBoardStore } from "@renderer/stores/board";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";
import { runAutomationOnTicket } from "./run-automation";
vi.mock("sonner", () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }));
vi.mock("@renderer/components/hosts/use-hosts", () => ({ guardWrite: () => true }));
let source: ConvexAutomationSource;
const adopt = useChatSessionsStore.getState().adoptChatSession;
beforeEach(() => {
  vi.clearAllMocks();
  adoptLaunch({ store: "cloud", userId: U, backendUrl: "http://127.0.0.1:1" });
  useCloudPlacesStore.setState({ thisRunnerId: R });
  const ticket: Ticket = {
    id: T,
    projectId: P,
    ticketNumber: 12,
    title: "Ticket",
    body: "",
    status: "doing",
    priority: "medium",
    labels: [],
    usesWorktree: true,
    preferredHarnessId: "claude-code",
    order: 0,
    worktreePath: null,
    branch: null,
    baseBranch: null,
    prUrl: null,
    createdAt: 1,
    updatedAt: 1,
  };
  useBoardStore.setState({ ticketsByProject: { [P]: [ticket] } });
  useChatSessionsStore.setState({ adoptChatSession: vi.fn() });
});
afterEach(() => {
  source?.close();
  installCloudAutomationSource(null);
  adoptLaunch(LOCAL_LAUNCH);
  useChatSessionsStore.setState({ adoptChatSession: adopt });
});
it("keeps Run context while queued and offers Open session only after real intake", async () => {
  const cloud = fakeCloud();
  source = new ConvexAutomationSource(cloud.session);
  installCloudAutomationSource(source);
  const outcome = runAutomationOnTicket({
    target: { kind: "automation", automationId: A },
    ticketId: T,
    automationName: "Review",
    ticketDisplayId: "VC-12",
    modelOverride: null,
  });
  cloud.mutations[0]!.resolve({
    runId: A,
    sessionId: T,
    runner: { id: R, name: "Ada’s Mac", status: "online", statusChangedAt: 1 },
  });
  expect(await outcome).toBe("started");
  expect(toast.info).toHaveBeenCalledWith(
    "Review on VC-12 · Starting… on Ada’s Mac",
    expect.any(Object),
  );
  expect(toast.success).not.toHaveBeenCalled();
  cloud.answer(
    "automations:runState",
    { runId: A },
    run({ status: "started", sessionAccess: "starting" }),
  );
  expect(toast.success).not.toHaveBeenCalled();
  cloud.answer(
    "automations:runState",
    { runId: A },
    run({ status: "started", sessionAccess: "ready" }),
  );
  expect(toast.success).toHaveBeenCalledWith(
    "Review started on VC-12",
    expect.objectContaining({ action: expect.objectContaining({ label: "Open session" }) }),
  );
  expect(cloud.watchers("automations:runState", { runId: A })).toBe(0);
});
it("names an asleep runner without claiming that a Session already started", async () => {
  const cloud = fakeCloud();
  source = new ConvexAutomationSource(cloud.session);
  installCloudAutomationSource(source);
  const outcome = runAutomationOnTicket({
    target: { kind: "automation", automationId: A },
    ticketId: T,
    automationName: "Review",
    ticketDisplayId: "VC-12",
    modelOverride: null,
  });
  cloud.mutations[0]!.resolve({
    runId: A,
    sessionId: T,
    runner: { id: R, name: "Ada’s Mac", status: "asleep", statusChangedAt: 1 },
  });
  await outcome;
  expect(toast.info).toHaveBeenCalledWith(
    "Review on VC-12 · Waiting for Ada’s Mac (asleep)",
    expect.any(Object),
  );
  expect(toast.success).not.toHaveBeenCalled();
  cloud.answer(
    "automations:runState",
    { runId: A },
    run({ status: "failed", error: "Choose a model" }),
  );
  expect(toast.error).toHaveBeenCalledWith(
    "Review couldn’t start: Choose a model",
    expect.any(Object),
  );
});
