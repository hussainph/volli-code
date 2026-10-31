import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { DEFAULT_KICKOFF_MESSAGE, LOCAL_LAUNCH, type ModelSelection } from "@volli/shared";
import { getFunctionName } from "convex/server";
import { toast } from "sonner";
import * as cloudClient from "@renderer/lib/cloud-client";
import { adoptLaunch } from "@renderer/stores/launch";
import { useChatDraftsStore } from "@renderer/stores/chat-drafts";
import { submitRunnerDraft } from "@renderer/components/chat/runner-picker-start";
import { startRunnerKickoff } from "./runner-kickoff";

const landing = vi.hoisted(() => ({
  openChatTab: vi.fn(),
  setProvisionalActive: vi.fn(),
  openTicketView: vi.fn(),
  select: vi.fn(),
}));
vi.mock("@renderer/stores/chat-sessions", () => ({
  useChatSessionsStore: { getState: () => landing },
}));
vi.mock("@renderer/stores/projects", () => ({
  useProjectsStore: { getState: () => landing },
}));
vi.mock("@renderer/stores/project-ui", () => ({
  useProjectUiStore: { getState: () => landing },
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

const projectId = "20000000-0000-4000-8000-000000000001";
const ticketId = "20000000-0000-4000-8000-000000000002";
const runner = {
  id: "20000000-0000-4000-8000-000000000003",
  name: "Linux",
  kind: "byo",
  status: "offline",
  statusChangedAt: 1,
  providers: ["anthropic"],
  version: "1",
  upgradeRequired: false,
};
const model: ModelSelection = { providerId: "anthropic", modelId: "opus", reasoningLevel: "high" };
const chat = {
  title: "ONE-1",
  refineTitle: true as const,
  message: DEFAULT_KICKOFF_MESSAGE,
  model,
};
let writes: string[];
let mutation: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.clearAllMocks();
  adoptLaunch({
    store: "cloud",
    userId: "user",
    backendUrl: "https://example.convex.cloud",
    siteUrl: "https://example.convex.site",
  });
  writes = [];
  vi.stubGlobal("window", {
    api: {
      appState: {
        set: vi.fn(async (_key, value: string) => {
          writes.push(value);
          return { ok: true };
        }),
      },
    },
  });
  useChatDraftsStore.setState({ drafts: {} });
  mutation = vi.fn(async () => ({ sessionId: "backend-session" }));
  vi.spyOn(cloudClient, "cloudSession").mockReturnValue({
    client: { mutation, connectionState: () => ({ isWebSocketConnected: true }) },
  } as unknown as cloudClient.CloudSession);
});
afterEach(() => {
  adoptLaunch(LOCAL_LAUNCH);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("persists the chosen runner and held kickoff before C2, then opens its Draft", async () => {
  mutation.mockImplementationOnce(async () => {
    expect(
      writes.some(
        (value) => value.includes("runnerStart") && value.includes(DEFAULT_KICKOFF_MESSAGE),
      ),
    ).toBe(true);
    return { sessionId: "backend-session" };
  });
  const id = await startRunnerKickoff(projectId, ticketId, chat, runner);
  expect(id).not.toBeNull();
  const provisional = useChatDraftsStore.getState().drafts[id!]!.provisional!;
  expect(provisional.runnerChoice).toEqual({ id: runner.id, name: runner.name });
  expect(provisional.runnerStart?.sessionId).toBe("backend-session");
  expect(landing.openChatTab).toHaveBeenCalledWith(ticketId, id);
  expect(landing.setProvisionalActive).toHaveBeenCalledWith(ticketId, id);
  expect(landing.select).not.toHaveBeenCalled();
  expect(landing.openTicketView).not.toHaveBeenCalled();
  const [reference, args] = mutation.mock.calls[0]!;
  expect(getFunctionName(reference)).toBe("sessionStarts:startOn");
  expect(args).toEqual({
    clientRequestId: provisional.operationId,
    runnerId: runner.id,
    projectId,
    ticketId,
    model,
    body: expect.any(String),
  });
  expect(JSON.parse(args.body)).toEqual({
    id: expect.any(String),
    role: "user",
    parts: [{ type: "text", text: DEFAULT_KICKOFF_MESSAGE }],
  });
});

it("keeps a lost reply on the Draft and retries the same request, not a second ticket", async () => {
  mutation.mockRejectedValueOnce(new Error("Lost reply"));
  const id = await startRunnerKickoff(projectId, ticketId, chat, runner);
  expect(id).not.toBeNull();
  expect(toast.error).toHaveBeenCalledWith("Couldn't start chat: Lost reply");
  expect(useChatDraftsStore.getState().drafts[id!]!.held[0]?.text).toBe(DEFAULT_KICKOFF_MESSAGE);
  await submitRunnerDraft(id!);
  expect(mutation.mock.calls[1]![1]).toEqual(mutation.mock.calls[0]![1]);
  expect(landing.openChatTab).toHaveBeenCalledTimes(1);
});

it("refuses a local launch without opening or submitting a cloud start", async () => {
  adoptLaunch(LOCAL_LAUNCH);
  expect(await startRunnerKickoff(projectId, ticketId, chat, runner)).toBeNull();
  expect(mutation).not.toHaveBeenCalled();
  expect(landing.openChatTab).not.toHaveBeenCalled();
  expect(toast.error).toHaveBeenCalled();
});
