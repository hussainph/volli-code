// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import type { CodeModePolicy } from "@volli/shared";
import type { IpcRequest, IpcResponse } from "@volli/host-protocol/ipc";
import { DesktopModelAccessProvider } from "./desktop-model-access-client";
import { useModelAccessClient } from "./model-access-client";
it("passes an explicit default through the production provider and real IPC link codec", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let request: IpcRequest | undefined;
  let reply: ((value: IpcResponse) => void) | undefined;
  let saved: CodeModePolicy | undefined;
  Object.defineProperty(window, "api", {
    configurable: true,
    value: {
      sessionRpc: {
        request: (input: IpcRequest) => {
          request = JSON.parse(JSON.stringify(input)) as IpcRequest;
          return new Promise<IpcResponse>((resolve) => {
            reply = resolve;
          });
        },
        cancel: () => {},
        onEvent: () => () => {},
      },
    },
  });
  function Probe() {
    const client = useModelAccessClient();
    return (
      <button
        onClick={() =>
          void client!
            .setCodeModePolicy({ enabled: true, defaultMode: "both", models: {} })
            .then((value) => {
              saved = value;
            })
        }
      >
        Save policy
      </button>
    );
  }
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <DesktopModelAccessProvider>
          <Probe />
        </DesktopModelAccessProvider>,
      ),
    );
    await act(async () => host.querySelector("button")!.click());
    expect(request).toMatchObject({
      path: "modelAccess.setCodeModePolicy",
      type: "mutation",
      input: { enabled: true, defaultMode: "both", models: {} },
    });
    expect(saved).toBeUndefined();
    await act(async () =>
      reply!({ ok: true, data: { enabled: true, defaultMode: "both", models: {} } }),
    );
    expect(saved).toEqual({ enabled: true, defaultMode: "both", models: {} });
  } finally {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
