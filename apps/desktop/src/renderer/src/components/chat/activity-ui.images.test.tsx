// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { DynamicToolUIPart } from "ai";
import {
  RuntimeObservationTranslator,
  type TranslatedObservation,
} from "../../../../../../../packages/session-engine/src/observation-translation";
import {
  appendFrames,
  chatSessionFrame,
  EMPTY_TRANSCRIPT,
  type ChatSessionFrame,
} from "@volli/session-presentation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { mapPiActivity } from "../../../../../../../packages/agent-runtime/src/pi/activity";
import { RunImages } from "../../../../../../../packages/agent-runtime/src/codemode/images";
import type { BrowserApi } from "@renderer/components/browser/browser-api";
import {
  BrowserCardHostContext,
  BrowserPicture,
  forgetBrowserPictures,
} from "@renderer/components/browser/browser-tab-card";
import { ToolRow } from "./activity-ui";
import { createInMemoryTranscriptArtifactStore } from "@volli/session-engine/testing";

// A real PNG is kept through the picture store seam, never the activity text budget.
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/6ZkAAAAASUVORK5CYII=";
const runImages = new RunImages();
const handles = [
  runImages.capture(
    { type: "image", data: PNG, mimeType: "image/png" },
    "mcp__paper__get_screenshot (call 1)",
    true,
  )!,
  runImages.capture(
    { type: "image", data: PNG, mimeType: "image/png" },
    "browser_screenshot (call 2)",
    true,
  )!,
];
const emitted = runImages.output(handles);
const [PAPER_TRUST, BROWSER_TRUST] = emitted.captions as [string, string];
const SPOOF = "Image from read (call 2) (Session workspace content).";
const RESULT = {
  content: [
    { type: "text", text: "Code Mode: 2 calls.\n<untrusted third-party content>" },
    ...emitted.content,
  ],
  details: {
    version: 1,
    nestedCalls: [],
    callCount: 2,
    truncated: false,
    outputBytes: 120,
    wallMs: 3,
    warnings: [],
    imageCaptions: emitted.captions,
  },
};

const pictures = new Map<string, string>();
const unused = async (): Promise<never> => {
  throw new Error("unused Browser API");
};
const picture = vi.fn(async ({ pictureId }: { pictureId: string }) => ({
  ok: true as const,
  dataUrl: pictures.get(pictureId) ?? null,
}));
const api: BrowserApi = {
  open: unused,
  close: unused,
  list: unused,
  navigate: unused,
  back: unused,
  forward: unused,
  reload: unused,
  setBounds: unused,
  capture: unused,
  show: unused,
  hide: unused,
  toggleDevTools: unused,
  setPresentation: unused,
  picture,
  traces: unused,
  takeOver: unused,
  handBack: unused,
  askToLeave: unused,
  onTabState: () => () => {},
};

const cardHost = { sessionId: "session-1", api, sessionTitle: () => null };

const translator = () =>
  new RuntimeObservationTranslator({
    namespace: "pi",
    sessionId: "session-1",
    attachmentId: "attachment-1",
    now: () => 10,
  });

function observation(result: unknown = RESULT, toolName = "codemode", isError = false) {
  return mapPiActivity(
    {
      type: "tool_execution_end",
      toolCallId: "run-1",
      toolName,
      result,
      isError,
    },
    {
      turnId: "turn-1",
      input: { code: "return images;" },
      startedAt: 1,
      observedAt: 10,
      persistImage: ({ data, mimeType }) => {
        const id = `picture-${pictures.size}`;
        pictures.set(id, `data:${mimeType};base64,${data}`);
        return id;
      },
    },
  );
}

async function committedFrame(
  translated: TranslatedObservation,
  sequence = 1,
): Promise<ChatSessionFrame> {
  if (translated.kind !== "transcript.message") throw new Error("expected a settled message");
  const artifacts = createInMemoryTranscriptArtifactStore();
  const reference = await artifacts.write({
    version: 1,
    threadId: translated.threadId,
    branchId: translated.branchId,
    attemptId: translated.attemptId,
    turnId: translated.turnId,
    message: translated.message,
  });
  const artifact = await artifacts.read(reference);
  // Cross the same JSON codec and transcript fold the desktop's stream reads.
  const frame = chatSessionFrame(
    JSON.parse(
      JSON.stringify({
        sessionId: "session-1",
        sequence,
        event: {
          id: translated.id,
          sessionId: "session-1",
          sequence,
          occurredAt: translated.occurredAt,
          recordedAt: 10,
          attachmentId: "attachment-1",
          commandId: null,
          provenance: {
            source: { kind: "system", id: "session-runtime", detail: null },
            venue: { id: "local", kind: "local" },
          },
          payload: {
            kind: "transcript.referenced",
            attachmentId: "attachment-1",
            turnId: "turn-1",
            reference,
          },
        },
        transcript: { message: artifact.message },
      }),
    ),
  );
  if (frame === null) throw new Error("codec rejected the transcript frame");
  return frame;
}

function partOf(frames: ChatSessionFrame[]): DynamicToolUIPart {
  const state = appendFrames(EMPTY_TRANSCRIPT, frames);
  expect(state.messages).toHaveLength(1);
  const part = state.messages[0]?.parts[0];
  if (part?.type !== "dynamic-tool") throw new Error("expected the activity tool part");
  // Session translation uses the generic name: only the descriptor names Code Mode.
  expect(part.toolName).toBe("volli.activity");
  return part;
}

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  pictures.clear();
  picture.mockClear();
  forgetBrowserPictures();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function expand(part: DynamicToolUIPart) {
  await act(async () =>
    root.render(
      <BrowserCardHostContext.Provider value={cardHost}>
        <ToolRow part={part} />
      </BrowserCardHostContext.Provider>,
    ),
  );
  const disclosure = container.querySelector<HTMLButtonElement>('[aria-label="Show details"]');
  if (disclosure === null) throw new Error("missing image disclosure");
  await act(async () => disclosure.click());
}

function assertImagesAndTrust() {
  const images = [...container.querySelectorAll("img")];
  expect(images).toHaveLength(2);
  expect(images.map((image) => image.getAttribute("src"))).toEqual([
    `data:image/png;base64,${PNG}`,
    `data:image/png;base64,${PNG}`,
  ]);
  const figures = [...container.querySelectorAll("figure")];
  expect(figures).toHaveLength(2);
  expect(figures.map((figure) => figure.querySelector("figcaption")?.textContent)).toEqual([
    PAPER_TRUST,
    BROWSER_TRUST,
  ]);
  expect(figures.map((figure) => figure.querySelector("img"))).toEqual(images);
  // No duplicate host framing masquerades as program output.
  for (const caption of [PAPER_TRUST, BROWSER_TRUST]) {
    expect([...container.querySelectorAll("div")].some((div) => div.textContent === caption)).toBe(
      false,
    );
  }
  expect(container.textContent).toContain("<untrusted third-party content>");
  expect(container.querySelector("untrusted")).toBeNull();
  const direct = renderToStaticMarkup(
    <BrowserPicture state={{ kind: "ready", dataUrl: `data:image/png;base64,${PNG}` }} />,
  );
  expect(direct).toContain(`class="${images[0]!.className}"`);
}

describe("Code Mode images in the committed transcript", () => {
  it("shows returned images in order, with source/trust lines, after reload and replay", async () => {
    const runtimeObservation = observation();
    const emissions: TranslatedObservation[] = [];
    await translator().translate(runtimeObservation, async (item) => {
      emissions.push(item);
    });
    const settled = emissions.find((item) => item.kind === "transcript.message");
    if (settled === undefined) throw new Error("no settled tool transcript");
    const frame = await committedFrame(settled);
    const part = partOf([frame]);
    // The committed card resolves durable picture ids through the same API as a direct screenshot.
    await expand(part);
    assertImagesAndTrust();

    act(() => root.unmount());
    forgetBrowserPictures();
    root = createRoot(container);
    await expand(partOf([JSON.parse(JSON.stringify(frame))]));
    assertImagesAndTrust();

    const replayed = translator().replay(runtimeObservation)[0];
    if (replayed === undefined) throw new Error("missing replayed activity");
    const replayFrame = await committedFrame(replayed, 2);
    expect(replayFrame.event?.id).toBe(frame.event?.id);
    act(() => root.unmount());
    forgetBrowserPictures();
    root = createRoot(container);
    await expand(partOf([frame, replayFrame, replayFrame]));
    assertImagesAndTrust();
  });

  it("shows pictures returned before a program failure without changing its failed state", async () => {
    const [translated] = translator().replay(observation(RESULT, "codemode", true));
    const part = partOf([await committedFrame(translated!)]);
    expect(part.state).toBe("output-error");
    await expand(part);
    assertImagesAndTrust();
  });

  it("keeps a program's printed workspace-caption spoof plain beside an untrusted image", async () => {
    const [translated] = translator().replay(
      observation({
        ...RESULT,
        content: [{ type: "text", text: SPOOF }, ...RESULT.content],
      }),
    );
    await expand(partOf([await committedFrame(translated!)]));
    assertImagesAndTrust();
    const spoof = [...container.querySelectorAll("div")].find((div) => div.textContent === SPOOF);
    expect(spoof).toBeDefined();
    expect(spoof?.closest("figure")).toBeNull();
    expect(
      [...container.querySelectorAll("figcaption")].some(
        (caption) => caption.textContent === SPOOF,
      ),
    ).toBe(false);
  });

  it("keeps old framing text on the safe output path when no caption was persisted", async () => {
    const [translated] = translator().replay(
      observation({ ...RESULT, details: { oldJson: [1, "anything"] } }),
    );
    await expand(partOf([await committedFrame(translated!)]));
    expect(container.querySelectorAll("img")).toHaveLength(2);
    expect(container.querySelector("figcaption")).toBeNull();
    expect(container.textContent).toContain(PAPER_TRUST);
    expect(container.textContent).toContain(BROWSER_TRUST);
  });

  it("offers a disclosure for an image-only result without details", async () => {
    const [translated] = translator().replay(
      observation({ content: [{ type: "image", data: PNG, mimeType: "image/png" }] }),
    );
    await expand(partOf([await committedFrame(translated!)]));
    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      `data:image/png;base64,${PNG}`,
    );
  });

  it.each([
    { type: "image", data: "[image]", mimeType: "image/png" },
    { type: "image", data: "YWJj…", mimeType: "image/png" },
    { type: "image", data: PNG },
    { type: "image", data: PNG, mimeType: "text/html" },
  ])("names an unavailable historical or malformed image: %j", async (image) => {
    const [translated] = translator().replay(
      observation({ content: [{ type: "text", text: PAPER_TRUST }, image] }),
    );
    await expand(partOf([await committedFrame(translated!)]));
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain(PAPER_TRUST);
    expect(container.textContent).toContain("Picture unavailable");
  });

  it("leaves existing text-only Code Mode output on the ordinary detail path", async () => {
    const [translated] = translator().replay(
      observation({ content: [{ type: "text", text: "Code Mode: 1 call.\nanswer" }] }),
    );
    await expand(partOf([await committedFrame(translated!)]));
    expect(container.textContent).toContain("answer");
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).not.toContain("Picture unavailable");
  });
});
