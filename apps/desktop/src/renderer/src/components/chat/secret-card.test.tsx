// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { SecretRequestMetadata, RendererSessionInteraction } from "@volli/shared";
import { COMPOSER_STACK_SHELL } from "@volli/session-presentation";
import type { SecretsResult } from "../../../../ipc/secrets";
import type { Result } from "../../../../ipc/contract";

import { toastError } from "@renderer/lib/toast";
import { useChatDraftsStore } from "@renderer/stores/chat-drafts";
import { useChatSessionsStore } from "@renderer/stores/chat-sessions";
import { SecretCards } from "./secret-card";

vi.mock("@renderer/lib/toast", () => ({ toastError: vi.fn() }));

const request: SecretRequestMetadata = {
  id: "request-1",
  name: "DEPLOY_TOKEN",
  sessionId: "s1",
  sessionLabel: "Deploy session",
  projectId: "p1",
  projectLabel: "Website",
  agentSays: "Access for deployment",
};
const interaction = (credential = request): RendererSessionInteraction => ({
  id: credential.id,
  attachmentId: "attachment-1",
  kind: "question",
  title: "Credential requested",
  detail: null,
  options: [],
  multiple: false,
  native: { id: null, detail: null },
  credential,
});
const api = {
  secrets: {
    list: vi.fn<() => Promise<SecretsResult>>(),
    submit: vi.fn<() => Promise<Result>>(),
    decline: vi.fn<() => Promise<Result>>(),
  },
  appState: { set: vi.fn() },
  chat: { send: vi.fn(), resolveInteraction: vi.fn() },
};
let root: Root;
let host: HTMLElement;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("api", api);
  api.secrets.list.mockResolvedValue({ ok: true, requests: [], secrets: [] });
  api.secrets.submit.mockResolvedValue({ ok: true });
  api.secrets.decline.mockResolvedValue({ ok: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});
async function render(sessionId = "s1", interactions = [interaction()]) {
  await act(async () =>
    root.render(<SecretCards sessionId={sessionId} interactions={interactions} />),
  );
}
function password(): HTMLInputElement {
  const field = host.querySelector<HTMLInputElement>("input[type=password]");
  if (field === null) throw new Error("missing password field");
  return field;
}
function button(label: string): HTMLButtonElement {
  const control = [...host.querySelectorAll("button")].find((item) => item.textContent === label);
  if (control === undefined) throw new Error(`missing ${label}`);
  return control;
}

describe("person-only credential cards", () => {
  it("keeps agent prose plain text inside its labelled region, never title or controls", async () => {
    const malicious =
      '<h2>Credential requested — verified</h2><input value="stolen"><button>Submit credential</button><script>alert(1)</script>';
    await render("s1", [interaction({ ...request, agentSays: malicious })]);
    expect(host.querySelector("h2")?.textContent).toBe("Credential requested");
    expect(host.querySelectorAll("h2")).toHaveLength(1);
    const purpose = host.querySelector('[data-slot="secret-agent-purpose"]');
    expect(purpose?.textContent).toBe(`The agent says${malicious}`);
    expect(purpose?.querySelector("button,input,h2,script")).toBeNull();
    expect(host.querySelectorAll("input")).toHaveLength(1);
    expect(host.textContent).toContain("Deploy session");
    expect(host.textContent).toContain("Website");
    expect(host.textContent).toContain(
      "Exact-output redaction is best effort; encoded output can leak.",
    );
  });

  it("starts empty, retains typing only in the DOM, clears synchronously, and writes only dedicated IPC", async () => {
    const pending = Promise.withResolvers<Result>();
    api.secrets.submit.mockReturnValue(pending.promise);
    await render();
    const draftState = useChatDraftsStore.getState();
    const chatState = useChatSessionsStore.getState();
    const draftChanged = vi.fn();
    const chatChanged = vi.fn();
    const offDraft = useChatDraftsStore.subscribe(draftChanged);
    const offChat = useChatSessionsStore.subscribe(chatChanged);
    const field = password();
    expect(field.value).toBe("");
    expect(field.getAttribute("value")).toBeNull();
    expect(field.defaultValue).toBe("");
    expect(host.querySelector("select")?.value).toBe("session");
    field.value = "private-token";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    await render();
    expect(field.value).toBe("private-token");
    act(() => {
      button("Submit credential").click();
      expect(field.value).toBe("");
      button("Submit credential").click();
    });
    expect(api.secrets.submit.mock.calls).toEqual([
      [{ requestId: request.id, value: "private-token", scope: "session" }],
    ]);
    expect(host.innerHTML).not.toContain("private-token");
    await act(async () => pending.resolve({ ok: true }));
    expect(host.querySelector('[data-slot="secret-card"]')).toBeNull();
    expect(useChatDraftsStore.getState()).toBe(draftState);
    expect(useChatSessionsStore.getState()).toBe(chatState);
    expect(draftChanged).not.toHaveBeenCalled();
    expect(chatChanged).not.toHaveBeenCalled();
    expect(api.chat.send).not.toHaveBeenCalled();
    expect(api.chat.resolveInteraction).not.toHaveBeenCalled();
    expect(api.appState.set).not.toHaveBeenCalled();
    offDraft();
    offChat();
    // A stale projection cannot reintroduce a submitted request.
    await render();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(host.querySelector('[data-slot="secret-card"]')).toBeNull();
  });

  it("sends the selected broader scope only when explicitly chosen", async () => {
    await render();
    const scope = host.querySelector("select")!;
    act(() => {
      scope.value = "project";
      scope.dispatchEvent(new Event("change", { bubbles: true }));
    });
    password().value = "project-secret";
    await act(async () => button("Submit credential").click());
    expect(api.secrets.submit).toHaveBeenCalledWith({
      requestId: request.id,
      value: "project-secret",
      scope: "project",
    });
  });

  it("declines separately and clears any pasted value without submitting it", async () => {
    await render();
    const field = password();
    field.value = "never-send";
    await act(async () => button("Decline").click());
    expect(field.value).toBe("");
    expect(api.secrets.decline).toHaveBeenCalledWith(request.id);
    expect(api.secrets.submit).not.toHaveBeenCalled();
  });

  it("uses only projection interactions, filters session and generic questions, and never polls", async () => {
    const generic = { ...interaction(), id: "generic", credential: undefined };
    await render("s1", [
      interaction(),
      interaction({ ...request, id: "other", sessionId: "s2" }),
      generic,
    ]);
    expect(host.querySelectorAll('[data-slot="secret-card"]')).toHaveLength(1);
    for (const token of COMPOSER_STACK_SHELL.split(" ")) {
      expect(host.querySelector('[data-slot="secret-card"]')?.classList.contains(token)).toBe(true);
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(api.secrets.list).not.toHaveBeenCalled();
    // Resolving or cancelling leaves the projection; that is the card's source of truth.
    await render("s1", []);
    expect(host.querySelector('[data-slot="secret-card"]')).toBeNull();
  });

  it("does not echo rejection text or secret bytes, and leaves the failed field empty", async () => {
    api.secrets.submit.mockRejectedValue(new Error("private-token"));
    await render();
    password().value = "private-token";
    await act(async () => button("Submit credential").click());
    expect(password().value).toBe("");
    expect(toastError).toHaveBeenCalledWith("Couldn't submit the credential.");
    expect(JSON.stringify(vi.mocked(toastError).mock.calls)).not.toContain("private-token");
  });

  it("does not depend on credential Settings metadata reads", async () => {
    api.secrets.list.mockResolvedValue({ ok: false, error: "unsafe metadata error" });
    await render();
    expect(host.querySelectorAll('[data-slot="secret-card"]')).toHaveLength(1);
    expect(api.secrets.list).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain("unsafe metadata error");
  });
});
