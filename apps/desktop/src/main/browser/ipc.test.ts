import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { BrowserIpcChannel, BrowserTabState } from "../../ipc/contract";

// Hoisted above module evaluation so the electron mock factory can capture
// into it — the same shape theme-ipc.test.ts and data-ipc.test.ts use.
const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: never[]) => unknown>(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle(channel: string, handler: (...args: never[]) => unknown) {
      handlers.set(channel, handler);
    },
  },
}));

import { registerBrowserTabIpcHandlers } from "./ipc";
import type { BrowserTabHost } from "./tab-host";

const SENDER = {} as Electron.WebContents;

function invoke<T>(channel: BrowserIpcChannel, ...args: unknown[]): T {
  const handler = handlers.get(channel);
  if (handler === undefined) throw new Error(`no handler for ${channel}`);
  return (handler as (event: unknown, ...rest: unknown[]) => T)({ sender: SENDER }, ...args);
}

const tab: BrowserTabState = {
  tabId: "opaque-1",
  projectId: "p1",
  ticketId: null,
  createdBy: "session",
  ownerSessionId: "s1",
  presentation: "preview",
  url: "https://example.com/",
  title: "Example",
  loading: false,
  error: null,
  canGoBack: false,
  canGoForward: false,
  generation: 2,
  heldBy: null,
};

let host: {
  setPresentation: ReturnType<typeof vi.fn>;
  pictureOf: ReturnType<typeof vi.fn>;
  show: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  handlers.clear();
  host = {
    setPresentation: vi.fn(() => tab),
    pictureOf: vi.fn(() => "data:image/png;base64,AAA"),
    show: vi.fn(),
  };
  registerBrowserTabIpcHandlers(host as unknown as BrowserTabHost);
});

describe("Browser Tab IPC (VC-238)", () => {
  it("asks main to redraw a Session's tab, and answers with the tab as it now stands", () => {
    const result = invoke("volli:browser-set-presentation", {
      tabId: "opaque-1",
      presentation: "preview",
    });

    expect(host.setPresentation).toHaveBeenCalledWith("opaque-1", "preview");
    expect(result).toEqual({ ok: true, tab });
  });

  it("carries a refused presentation change across as data, for the toast to read", () => {
    host.setPresentation.mockImplementation(() => {
      throw new Error("Only a Session's Browser Tab can be hidden or previewed");
    });

    expect(
      invoke("volli:browser-set-presentation", { tabId: "opaque-1", presentation: "headless" }),
    ).toEqual({
      ok: false,
      error: "Only a Session's Browser Tab can be hidden or previewed",
    });
  });

  it("carries the host's refusal to attach a headless tab across as data too", () => {
    host.show.mockImplementation(() => {
      throw new Error("A headless Browser Tab has no plane until the person shows it");
    });

    expect(invoke("volli:browser-show", { tabId: "opaque-1" })).toEqual({
      ok: false,
      error: "A headless Browser Tab has no plane until the person shows it",
    });
  });

  it("reads one picture by the id the transcript names, and calls a picture it lost an answer", () => {
    expect(invoke("volli:browser-picture", { pictureId: "picture-1" })).toEqual({
      ok: true,
      dataUrl: "data:image/png;base64,AAA",
    });

    host.pictureOf.mockReturnValue(null);
    // Null is an answer, not a failure: the card says the picture is gone
    // rather than toasting a mutation nobody attempted.
    expect(invoke("volli:browser-picture", { pictureId: "picture-2" })).toEqual({
      ok: true,
      dataUrl: null,
    });
  });

  it("refuses a malformed request at the guard, before the host is asked anything", () => {
    expect(
      invoke("volli:browser-set-presentation", { tabId: "opaque-1", presentation: "visible" }),
    ).toEqual({ ok: false, error: "Invalid Browser Tab request" });
    expect(invoke("volli:browser-picture", { pictureId: 7 })).toEqual({
      ok: false,
      error: "Invalid Browser Tab request",
    });
    expect(host.setPresentation).not.toHaveBeenCalled();
    expect(host.pictureOf).not.toHaveBeenCalled();
  });
});
