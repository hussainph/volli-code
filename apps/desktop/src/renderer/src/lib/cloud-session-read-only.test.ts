import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { LOCAL_LAUNCH } from "@volli/shared";
import { adoptLaunch } from "@renderer/stores/launch";
const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  guard: vi.fn(() => true),
  writable: vi.fn(() => true),
  connected: null as boolean | null,
}));
vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("@renderer/components/hosts/use-hosts", () => ({
  guardWrite: mocks.guard,
  useCanWrite: mocks.writable,
}));
vi.mock("@renderer/lib/cloud-client", () => ({
  cloudSession: () =>
    mocks.connected === null
      ? null
      : { client: { connectionState: () => ({ isWebSocketConnected: mocks.connected }) } },
}));
import {
  CLOUD_SEND_NOT_CONNECTED,
  CLOUD_SESSION_READ_ONLY,
  guardSessionSend,
  guardSessionWrite,
  useCanSendSession,
  useCanWriteSession,
} from "./cloud-session-read-only";
const CLOUD = { store: "cloud", userId: "u", backendUrl: "https://example.convex.cloud" } as const;
afterEach(() => {
  adoptLaunch(LOCAL_LAUNCH);
  mocks.connected = null;
  vi.clearAllMocks();
});
describe("Session-only cloud write guard", () => {
  it("preserves the local guard and hook, including a disconnected remote host", () => {
    expect(guardSessionWrite("p")).toBe(true);
    expect(useCanWriteSession("p")).toBe(true);
    mocks.writable.mockReturnValueOnce(false);
    expect(useCanWriteSession(null)).toBe(false);
    mocks.guard.mockReturnValueOnce(false);
    expect(guardSessionWrite(null)).toBe(false);
    expect(mocks.toast).not.toHaveBeenCalled();
  });
  it("refuses writes in a cloud launch, even when the cloud board is writable", () => {
    adoptLaunch(CLOUD);
    expect(useCanWriteSession("p")).toBe(false);
    expect(guardSessionWrite("p")).toBe(false);
    expect(mocks.guard).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith(CLOUD_SESSION_READ_ONLY, {
      id: "cloud-session-read-only",
    });
  });
});
describe("sends (a chat's composer and a new chat)", () => {
  it("follow the project's link in a local launch, reading no cloud client", () => {
    mocks.connected = false;
    expect(useCanSendSession("p")).toBe(true);
    expect(guardSessionSend("p")).toBe(true);
    mocks.writable.mockReturnValueOnce(false);
    expect(useCanSendSession("p")).toBe(false);
    mocks.guard.mockReturnValueOnce(false);
    expect(guardSessionSend("p")).toBe(false);
    expect(mocks.toast).not.toHaveBeenCalled();
  });
  it("follow the cloud link in a cloud launch, and the client's connection at the press", () => {
    adoptLaunch(CLOUD);
    expect(useCanSendSession("p")).toBe(true);
    mocks.connected = true;
    expect(guardSessionSend("p")).toBe(true);
    // The link says read-only: its own words, from the host guard.
    mocks.guard.mockReturnValueOnce(false);
    expect(guardSessionSend("p")).toBe(false);
    expect(mocks.toast).not.toHaveBeenCalled();
    // The link has not noticed yet, but the socket is down right now.
    mocks.connected = false;
    expect(guardSessionSend("p")).toBe(false);
    mocks.connected = null;
    expect(guardSessionSend("p")).toBe(false);
    expect(mocks.toast).toHaveBeenCalledTimes(2);
    expect(mocks.toast).toHaveBeenCalledWith(CLOUD_SEND_NOT_CONNECTED, {
      id: "cloud-session-not-connected",
    });
  });
});
