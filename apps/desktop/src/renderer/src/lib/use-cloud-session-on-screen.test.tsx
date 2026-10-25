// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { LOCAL_LAUNCH } from "@volli/shared";
import { adoptLaunch } from "@renderer/stores/launch";
import type { CloudSession } from "./cloud-client";
const mocks = vi.hoisted(() => ({
  follow: vi.fn(),
  show: vi.fn(),
  close: vi.fn(),
  unfollow: vi.fn(),
  listener: null as ((session: CloudSession | null) => void) | null,
}));
vi.mock("./cloud-client", () => ({
  followCloudSession: (listener: (session: CloudSession | null) => void) => {
    mocks.follow();
    mocks.listener = listener;
    return mocks.unfollow;
  },
}));
vi.mock("./cloud-session-transport", () => ({
  showCloudSession: (session: CloudSession, id: string) => {
    mocks.show(session, id);
    return mocks.close;
  },
}));
import { useCloudSessionOnScreen } from "./use-cloud-session-on-screen";
function Surface({ id }: { id: string | null }) {
  useCloudSessionOnScreen(id);
  return null;
}
const roots: ReturnType<typeof createRoot>[] = [];
function mount() {
  const host = document.createElement("div");
  const root = createRoot(host);
  roots.push(root);
  return (id: string | null) => act(() => root.render(<Surface id={id} />));
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
});
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  adoptLaunch(LOCAL_LAUNCH);
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe("cloud Session visibility", () => {
  it("does not register anything in a local launch or for an invisible cloud surface", () => {
    const render = mount();
    render("s");
    expect(mocks.follow).not.toHaveBeenCalled();
    adoptLaunch({ store: "cloud", userId: "u", backendUrl: "https://example.convex.cloud" });
    render(null);
    expect(mocks.follow).not.toHaveBeenCalled();
  });
  it("opens only while on screen, follows client replacement, and closes on hide/unmount", () => {
    adoptLaunch({ store: "cloud", userId: "u", backendUrl: "https://example.convex.cloud" });
    const render = mount();
    render("s");
    mocks.listener!(null);
    const session = {} as CloudSession;
    mocks.listener!(session);
    expect(mocks.show).toHaveBeenLastCalledWith(session, "s");
    mocks.listener!(session);
    expect(mocks.close).toHaveBeenCalledTimes(1);
    mocks.listener!(null);
    expect(mocks.close).toHaveBeenCalledTimes(2);
    mocks.listener!(session);
    render(null);
    expect(mocks.close).toHaveBeenCalledTimes(3);
    expect(mocks.unfollow).toHaveBeenCalledTimes(1);
    render("other");
    mocks.listener!(session);
    expect(mocks.show).toHaveBeenLastCalledWith(session, "other");
    const closes = mocks.close.mock.calls.length;
    const visibility = vi.spyOn(document, "visibilityState", "get");
    visibility.mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(mocks.close).toHaveBeenCalledTimes(closes + 1);
    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(mocks.show).toHaveBeenLastCalledWith(session, "other");
  });
});
