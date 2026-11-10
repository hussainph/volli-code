import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const electron = vi.hoisted(() => ({ show: vi.fn(), construct: vi.fn() }));
vi.mock("electron", () => ({
  app: { on: vi.fn(), focus: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
  Notification: class {
    static isSupported() {
      return true;
    }
    constructor(input: { title: string; body: string }) {
      electron.construct(input);
    }
    on() {
      return this;
    }
    show() {
      electron.show();
    }
    close() {}
  },
}));
import { createNotificationRuntime, resetNotificationRuntimeForTest } from "./runtime";

afterEach(() => {
  resetNotificationRuntimeForTest();
  vi.clearAllMocks();
});

describe("the desktop native notification adapter", () => {
  it("takes a host attention request all the way to Electron Notification.show", () => {
    const runtime = createNotificationRuntime({ db: null });
    expect(
      runtime.deliver({
        producer: "run-attention",
        title: "An agent needs your input",
        body: "Review the change.",
        target: {
          kind: "session",
          projectId: "p1",
          ticketId: "t1",
          sessionId: "s1",
          interactionId: null,
          attentionId: null,
        },
      }),
    ).toEqual({ delivered: true });
    expect(electron.construct).toHaveBeenCalledExactlyOnceWith({
      title: "An agent needs your input",
      body: "Review the change.",
    });
    expect(electron.show).toHaveBeenCalledTimes(1);
  });
});
