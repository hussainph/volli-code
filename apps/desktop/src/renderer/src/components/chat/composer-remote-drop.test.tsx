// @vitest-environment jsdom
/**
 * A file dropped or pasted on a remote Session's composer (VC-713) is taken
 * by the composer in the capture phase and discarded with a word: it never
 * reaches the vendored `PromptInput`'s own form listener, which would stage it
 * in hidden attachment state and convert it on submit.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { SessionComposer, type SessionComposerProps } from "./composer-ui";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
  vi.mocked(toast.error).mockClear();
});

function props(overrides: Partial<SessionComposerProps>): SessionComposerProps {
  return {
    value: "",
    onValueChange: () => undefined,
    models: [],
    selection: { providerId: "", modelId: "", reasoningLevel: "" },
    onSelectionChange: () => undefined,
    working: false,
    ready: true,
    queued: [],
    onQueuedChange: () => undefined,
    onSteerQueued: () => undefined,
    onSubmit: () => undefined,
    onStop: () => undefined,
    ...overrides,
  };
}

async function mount(overrides: Partial<SessionComposerProps>): Promise<HTMLFormElement> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<SessionComposer {...props(overrides)} />));
  return container.querySelector("form")!;
}

const file = () => new File(["x"], "shot.png", { type: "image/png" });

/** A drop carrying files, as Chromium delivers it. */
function dropEvent(): Event {
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: { files: [file()], types: ["Files"] },
  });
  return event;
}

function pasteEvent(): Event {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { files: [file()] } });
  return event;
}

describe("a remote composer's drop and paste (VC-713)", () => {
  it("takes the file before PromptInput's form listener, attaches nothing and says why", async () => {
    const onAttachFiles = vi.fn();
    const form = await mount({
      hostModelOnly: "hetzner-1",
      attachUnavailable: "Not available on hetzner-1 yet",
      onAttachFiles,
    });
    // Stands where the vendored PromptInput listens: on the form, bubbling.
    const formListener = vi.fn();
    form.addEventListener("drop", formListener);
    form.addEventListener("paste", formListener);

    const drop = dropEvent();
    const paste = pasteEvent();
    await act(async () => {
      form.dispatchEvent(drop);
      form.querySelector("textarea")!.dispatchEvent(paste);
    });

    expect(drop.defaultPrevented).toBe(true);
    expect(paste.defaultPrevented).toBe(true);
    expect(formListener).not.toHaveBeenCalled();
    expect(onAttachFiles).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith("Not available on hetzner-1 yet", expect.anything());
  });

  it("attaches a dropped file on This Mac's composer, exactly as before", async () => {
    const onAttachFiles = vi.fn();
    const form = await mount({ onAttachFiles });
    const formListener = vi.fn();
    form.addEventListener("drop", formListener);
    await act(async () => void form.dispatchEvent(dropEvent()));
    expect(onAttachFiles).toHaveBeenCalledWith([expect.any(File)]);
    expect(formListener).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });
});
