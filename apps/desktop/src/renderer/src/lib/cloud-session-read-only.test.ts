import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { LOCAL_LAUNCH } from "@volli/shared";
import { adoptLaunch } from "@renderer/stores/launch";
const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  guard: vi.fn(() => true),
  writable: vi.fn(() => true),
}));
vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("@renderer/components/hosts/use-hosts", () => ({
  guardWrite: mocks.guard,
  useCanWrite: mocks.writable,
}));
import {
  CLOUD_SESSION_READ_ONLY,
  guardSessionWrite,
  useCanWriteSession,
} from "./cloud-session-read-only";
afterEach(() => {
  adoptLaunch(LOCAL_LAUNCH);
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
    adoptLaunch({ store: "cloud", userId: "u", backendUrl: "https://example.convex.cloud" });
    expect(useCanWriteSession("p")).toBe(false);
    expect(guardSessionWrite("p")).toBe(false);
    expect(mocks.guard).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith(CLOUD_SESSION_READ_ONLY, {
      id: "cloud-session-read-only",
    });
  });
});
