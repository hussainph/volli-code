// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { IpcEvent, IpcRequest, IpcResponse } from "@volli/host-protocol/ipc";
import type { SourceIconsSnapshot } from "@volli/shared";
import { createSessionRpcClient, type SessionRpcClient } from "@renderer/lib/session-rpc-ipc-link";
import { sourceIconsFor, sessionPictureFor } from "@renderer/chat/transport";
import { forgetBrowserPictures } from "@renderer/components/browser/browser-tab-card";
import { readCodeModePicture } from "./code-mode-output-model";
import { PresentedToolRow } from "./presented-tool-row";
import { TranscriptSourceIcons } from "./transcript-source-icons";

const state = vi.hoisted(() => ({
  client: null as SessionRpcClient | null,
  cloud: false,
  remote: false,
}));
vi.mock("@renderer/lib/session-rpc-ipc-link", async (original) => ({
  ...(await original<typeof import("@renderer/lib/session-rpc-ipc-link")>()),
  sessionRpcClient: () => state.client!,
}));
vi.mock("@renderer/stores/launch", () => ({
  launchStore: () => (state.cloud ? "cloud" : "local"),
}));
vi.mock("@renderer/lib/remote-owners", () => ({
  remoteOwnerOf: () => (state.remote ? { hostName: "Other runner" } : null),
  hostNotConnected: () => "Offline",
}));

const ORIGIN = "https://subdomain.example.org";
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/6ZkAAAAASUVORK5CYII=";
let container: HTMLDivElement;
let root: Root | null;
function stop() {
  act(() => root?.unmount());
  root = null;
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  forgetBrowserPictures();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  stop();
  container.remove();
  state.client = null;
  state.cloud = false;
  state.remote = false;
  vi.unstubAllGlobals();
});
const flush = async () => {
  await act(async () => {
    for (let index = 0; index < 12; index += 1) await Promise.resolve();
  });
};

const noop = () => {};
function bridge() {
  let deliver: (event: IpcEvent) => void = noop;
  const requests: IpcRequest[] = [];
  const waiting: ((response: IpcResponse) => void)[] = [];
  const cancel = vi.fn();
  state.client = createSessionRpcClient({
    request: (request) => {
      requests.push(request);
      if (request.path === "session.picture")
        return Promise.resolve({
          ok: true,
          data: { data: PNG, mimeType: "image/png", nextOffset: null },
        });
      return new Promise<IpcResponse>((resolve) => waiting.push(resolve));
    },
    cancel,
    onEvent: (listener) => {
      deliver = listener;
      return () => {};
    },
  });
  return {
    requests,
    cancel,
    ack: (id = "icons") => waiting.shift()!({ ok: true, subscriptionId: id }),
    old: () => waiting.shift()!({ ok: false, error: { code: "NOT_FOUND", message: "Old host" } }),
    emit: (icons: SourceIconsSnapshot["icons"], id = "icons") =>
      act(() =>
        deliver(
          structuredClone({ kind: "data", subscriptionId: id, eventId: null, data: { icons } }),
        ),
      ),
  };
}

function reader(sessionId: string) {
  return {
    picture: async ({ pictureId }: { pictureId: string }) => ({
      ok: true as const,
      dataUrl: await readCodeModePicture(sessionPictureFor("project"), sessionId, pictureId),
    }),
  };
}
function render(
  api: ReturnType<typeof sourceIconsFor>,
  picture = reader("session"),
  origins = [ORIGIN],
  sessionId = "session",
) {
  act(() =>
    root!.render(
      <TranscriptSourceIcons
        sessionId={sessionId}
        origins={origins}
        api={api ?? undefined}
        picture={picture}
      >
        <PresentedToolRow
          part={{
            type: "dynamic-tool",
            toolName: "web_fetch",
            toolCallId: "fetch",
            state: "output-available",
            input: { url: ORIGIN },
            output: "fixture",
          }}
          presentation={{
            category: "web",
            label: "Opened subdomain.example.org",
            identity: "subdomain.example.org",
            originUrl: ORIGIN,
            status: "done",
            meta: null,
            sources: [],
            sections: [],
            sessionId: null,
          }}
        />
      </TranscriptSourceIcons>,
    ),
  );
}
const icon = (pictureId: string | null): SourceIconsSnapshot["icons"] => [
  { origin: ORIGIN, pictureId, registrableDomain: "example.org" },
];

/** Real sourceIconsFor + real IPC link/codec + Session-bound chunk reader, not a fake watch. */
describe("transcript icon receiving integration", () => {
  it("keeps a PSL letter on miss, reads cached bytes through the Session path, and drops expired pixels", async () => {
    const wire = bridge();
    const api = sourceIconsFor("project");
    const picture = reader("session");
    render(api, picture);
    await flush();
    wire.ack();
    await flush();
    wire.emit(icon(null));
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".transcript-identity")?.textContent).toBe("E");
    wire.emit(icon("picture-1"));
    await flush();
    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      `data:image/png;base64,${PNG}`,
    );
    expect(wire.requests.find((request) => request.path === "session.picture")?.input).toEqual({
      sessionId: "session",
      pictureId: "picture-1",
      offset: 0,
    });
    wire.emit(icon(null));
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".transcript-identity")?.textContent).toBe("E");
    expect(wire.requests.filter((request) => request.path === "session.picture")).toHaveLength(1);
    stop();
    wire.emit(icon("picture-1"));
    expect(wire.cancel).toHaveBeenCalledExactlyOnceWith("icons");
  });

  it("holds one bounded observer across reordered, duplicate and freshly allocated origin arrays", async () => {
    const wire = bridge();
    const api = sourceIconsFor("project");
    const picture = reader("session");
    const origins = Array.from({ length: 50 }, (_, index) => `https://source-${index}.example.org`);
    render(api, picture, [
      ...origins,
      origins[0]!,
      "https://not-canonical.example.org/",
      "data:image/png;base64,eA==",
    ]);
    await flush();
    wire.ack();
    await flush();
    render(api, picture, origins.toReversed());
    await flush();
    expect(wire.requests.filter((request) => request.path === "sourceIcons.watch")).toHaveLength(1);
    const input = wire.requests[0]!.input as { origins: string[] };
    expect(input.origins).toHaveLength(32);
    expect(input.origins.every((origin) => origin.startsWith("https://source-"))).toBe(true);
  });

  it("cancels before host setup and rejects a late acknowledgement and emission", async () => {
    const wire = bridge();
    render(sourceIconsFor("project"));
    await flush();
    stop();
    wire.emit(icon("late"));
    wire.ack();
    await flush();
    wire.emit(icon("late"));
    expect(wire.cancel).toHaveBeenCalledExactlyOnceWith("icons");
    expect(wire.requests.filter((request) => request.path === "session.picture")).toHaveLength(0);
  });

  it("does not set up a watch if unmounted in the same turn", async () => {
    const wire = bridge();
    render(sourceIconsFor("project"));
    stop();
    await flush();
    expect(wire.requests).toHaveLength(0);
  });

  it("falls back for an old host and never borrows this Mac for cloud or remote Sessions", async () => {
    const wire = bridge();
    render(sourceIconsFor("project"));
    await flush();
    wire.old();
    await flush();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".transcript-identity")?.textContent).toBe("?");
    state.cloud = true;
    render(sourceIconsFor("project"));
    await flush();
    state.cloud = false;
    state.remote = true;
    render(sourceIconsFor("project"));
    await flush();
    expect(wire.requests.filter((request) => request.path === "sourceIcons.watch")).toHaveLength(1);
    expect(wire.requests.filter((request) => request.path === "session.picture")).toHaveLength(0);
  });

  it("never flashes a previous Session's pixels while the new subscription is setting up", async () => {
    const wire = bridge();
    render(sourceIconsFor("project"));
    await flush();
    wire.ack("first");
    await flush();
    wire.emit(icon("shared-id"), "first");
    await flush();
    expect(container.querySelector("img")).not.toBeNull();
    render(sourceIconsFor("project"), reader("other-session"), [ORIGIN], "other-session");
    expect(container.querySelector("img")).toBeNull();
    wire.emit(icon("shared-id"), "first");
    await flush();
    expect(container.querySelector("img")).toBeNull();
    wire.ack("second");
    await flush();
    wire.emit(icon("shared-id"), "second");
    await flush();
    expect(
      wire.requests
        .filter((request) => request.path === "session.picture")
        .map((request) => (request.input as { sessionId: string }).sessionId),
    ).toEqual(["session", "other-session"]);
    expect(wire.cancel).toHaveBeenCalledWith("first");
  });

  it("does not retry a broken cached image or accept an unsolicited origin", async () => {
    const wire = bridge();
    render(sourceIconsFor("project"));
    await flush();
    wire.ack();
    await flush();
    wire.emit([
      {
        origin: "https://unrequested.example.org",
        pictureId: "wrong",
        registrableDomain: "example.org",
      },
    ]);
    await flush();
    expect(wire.requests.filter((request) => request.path === "session.picture")).toHaveLength(0);
    wire.emit(icon("picture-2"));
    await flush();
    act(() => container.querySelector("img")!.dispatchEvent(new Event("error")));
    expect(container.querySelector("img")).toBeNull();
    wire.emit(icon("picture-2"));
    await flush();
    expect(wire.requests.filter((request) => request.path === "session.picture")).toHaveLength(1);
  });
});
