// @vitest-environment jsdom
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { blobUrl, LOCAL_LAUNCH } from "@volli/shared";
import { adoptLaunch } from "@renderer/stores/launch";
import { BlobReadProvider } from "./blob-read";
import { AttachmentStrip } from "./attachment-strip";
import { MarkdownAttachmentsProvider, MarkdownImage } from "./markdown-image";
import { Markdown } from "../ticket/markdown";
import { useMaterializedAttachments } from "@renderer/hooks/use-materialized-attachments";
import { useAttachments, type AttachmentsHandle } from "@renderer/hooks/use-attachments";

const state = vi.hoisted(() => ({ session: null as unknown, listeners: new Set<() => void>() }));
vi.mock("@renderer/lib/cloud-client", () => ({
  cloudSession: () => state.session,
  followCloudSession: (listener: () => void) => {
    state.listeners.add(listener);
    return () => state.listeners.delete(listener);
  },
}));
const bytes = new TextEncoder().encode("image fixture");
const HASH = Array.from(new Uint8Array(await webcrypto.subtle.digest("SHA-256", bytes)), (byte) =>
  byte.toString(16).padStart(2, "0"),
).join("");
const PROJECT = "00000000-0000-4000-8000-000000000001";
const attachment = {
  linkId: "link",
  blobHash: HASH,
  label: "shot",
  originalName: "shot.png",
  mime: "image/png",
  sizeBytes: bytes.byteLength,
};
let root: Root;
let container: HTMLDivElement;
let action = vi.fn();
let query = vi.fn();
let fetching = vi.fn();
let completedReads = 0;
const readAsDataURL = FileReader.prototype.readAsDataURL;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  completedReads = 0;
  vi.spyOn(FileReader.prototype, "readAsDataURL").mockImplementation(
    function (this: FileReader, blob) {
      this.addEventListener(
        "loadend",
        () => {
          completedReads += 1;
        },
        { once: true },
      );
      readAsDataURL.call(this, blob);
    },
  );
  vi.stubGlobal("crypto", webcrypto);
  adoptLaunch({ store: "cloud", backendUrl: "https://backend.test", userId: "person" });
  action = vi.fn(async () => ({
    request: {
      method: "GET",
      url: "https://storage.test/project/blob?signed=yes",
      headers: {},
      expiresAt: Date.now() + 300000,
    },
    mime: "image/png",
    bytes: bytes.byteLength,
    sha256: HASH,
  }));
  query = vi.fn(async () => [attachment]);
  state.session = {
    client: { action, query },
    api: { files: { presignGet: "files:presignGet", attachments: "files:attachments" } },
  };
  fetching = vi.fn(async () => new Response(bytes));
  vi.stubGlobal("fetch", fetching);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  state.session = null;
  state.listeners.clear();
  adoptLaunch(LOCAL_LAUNCH);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
async function render(children: React.ReactNode, projectId = PROJECT) {
  await act(async () =>
    root.render(<BlobReadProvider projectId={projectId}>{children}</BlobReadProvider>),
  );
}
async function painted(count: number) {
  await act(async () => {
    await vi.waitFor(() => expect(completedReads).toBeGreaterThan(0));
  });
  const images = [...container.querySelectorAll("img")];
  expect(images).toHaveLength(count);
  for (const image of images) expect(image.getAttribute("src")).toMatch(/^data:image\/png;base64,/);
}

describe("cloud blob rendering", () => {
  it("hydrates attachment thumbnails and both markdown pipelines through one signed GET without widening CSP", async () => {
    await render(
      <MarkdownAttachmentsProvider attachments={[attachment]}>
        <AttachmentStrip attachments={[attachment]} />
        <MarkdownImage src={blobUrl(HASH)} alt="canonical" />
        <MarkdownImage src=".volli/attachments/shot.png" alt="materialized" />
        <Markdown
          source={`![comment](.volli/attachments/shot.png)\n\n<img src="${blobUrl(HASH)}" alt="raw" />`}
        />
      </MarkdownAttachmentsProvider>,
    );
    await painted(5);
    expect(action).toHaveBeenCalledExactlyOnceWith("files:presignGet", {
      projectId: PROJECT,
      sha256: HASH,
    });
    expect(fetching).toHaveBeenCalledExactlyOnceWith(
      "https://storage.test/project/blob?signed=yes",
      expect.objectContaining({
        method: "GET",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
      }),
    );
    expect(container.innerHTML).not.toContain('src="volli-blob:');
  });

  it("reads materialized links from the backend, never local IPC", async () => {
    function Probe() {
      const links = useMaterializedAttachments({ projectId: PROJECT, sessionId: "session" });
      return (
        <MarkdownAttachmentsProvider attachments={links}>
          <MarkdownImage src=".volli/attachments/shot.png" alt="shot" />
        </MarkdownAttachmentsProvider>
      );
    }
    await render(<Probe />);
    await painted(1);
    expect(query).toHaveBeenCalledWith("files:attachments", {
      projectId: PROJECT,
      sessionId: "session",
    });
  });

  it("does not fall back to local bytes on forbidden or offline reads", async () => {
    action.mockRejectedValue(new Error("not_found"));
    await render(<MarkdownImage src={blobUrl(HASH)} alt="private" />);
    expect(container.textContent).toContain("Image could not be loaded");
    expect(fetching).not.toHaveBeenCalled();
    expect(container.querySelector("img")).toBeNull();
  });

  it("rejects corrupt bytes and surfaces a markdown read failure", async () => {
    fetching.mockResolvedValue(new Response(new TextEncoder().encode("wrong content")));
    await render(
      <>
        <MarkdownImage src={blobUrl(HASH)} alt="corrupt" />
        <Markdown source={`![comment](${blobUrl(HASH)})`} />
      </>,
    );
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(container.querySelector("img:not([hidden])")).toBeNull();
      expect(container.textContent).toContain("Image could not be loaded");
    });
  });

  it("drops an old project's pending resolution and reauthorizes the new project", async () => {
    let release!: (value: Awaited<ReturnType<typeof action>>) => void;
    const old = new Promise<Awaited<ReturnType<typeof action>>>((resolve) => {
      release = resolve;
    });
    const grant = await action();
    action.mockClear();
    action.mockImplementationOnce(() => old);
    await render(<MarkdownImage src={blobUrl(HASH)} alt="shot" />);
    await render(
      <MarkdownImage src={blobUrl(HASH)} alt="shot" />,
      "00000000-0000-4000-8000-000000000002",
    );
    await painted(1);
    await act(async () => {
      release(grant);
    });
    expect(action.mock.calls.map((call) => call[1].projectId)).toEqual([
      PROJECT,
      "00000000-0000-4000-8000-000000000002",
    ]);
  });

  it("clears painted cloud bytes when the client closes and refuses an unscoped cloud image", async () => {
    await render(<MarkdownImage src={blobUrl(HASH)} alt="shot" />);
    await painted(1);
    await act(async () => {
      state.session = null;
      for (const listener of state.listeners) listener();
    });
    expect(container.querySelector("img")).toBeNull();
    await act(async () => root.render(<MarkdownImage src={blobUrl(HASH)} alt="unscoped" />));
    expect(container.textContent).toContain("Image could not be loaded");
  });

  it("keeps cloud attachments read-only without sending link ids or bytes to local IPC", async () => {
    let handle!: AttachmentsHandle;
    const refused = vi.fn();
    function Probe() {
      handle = useAttachments({ owner: { ticketId: "ticket" }, onError: refused });
      return <span>{handle.attachments.length}</span>;
    }
    await render(<Probe />);
    await act(async () => handle.reset([attachment]));
    await act(async () => {
      await handle.attachFiles([new File([bytes], "shot.png")]);
      await handle.remove(attachment);
    });
    expect(refused).toHaveBeenCalledTimes(2);
    expect(container.textContent).toBe("1");
    expect(action).not.toHaveBeenCalled();
  });

  it("leaves local launches synchronous and remote images blocked", async () => {
    adoptLaunch(LOCAL_LAUNCH);
    await render(
      <>
        <MarkdownImage src={blobUrl(HASH)} alt="local" />
        <MarkdownImage src="https://tracker.test/shot.png" alt="remote" />
      </>,
    );
    expect(container.querySelector("img")?.getAttribute("src")).toBe(blobUrl(HASH));
    expect(action).not.toHaveBeenCalled();
    expect(fetching).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Remote image");
  });
});
