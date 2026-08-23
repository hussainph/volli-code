/**
 * The one property this whole slice exists to keep: the API key stays in main.
 *
 * Every other test here checks a module. This one checks the seams between
 * them, because that is where a secret actually escapes — not in the owner that
 * knows it is holding one, but in the payload two layers away that serializes
 * whatever it was handed. So it drives the real surfaces: the renderer's
 * bootstrap, the Web Access door, and a Session attaching with the ports a
 * configured profile produces.
 *
 * The key is stored in the clear now (migration 023), which makes these the
 * only checks standing between it and a wire. Before, a leaked `secrets` row
 * was ciphertext and a leak was a scare; now every assertion below is about the
 * key itself, and each one is load-bearing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { BootstrapResult, VolliIpcChannel } from "../../ipc/contract";
import type { BindingHandle, NativeAttachmentSpec, ObservationSink } from "@volli/session-engine";
import { sessionRootThreadId } from "@volli/session-engine";
import type {
  AgentRuntime,
  RuntimeAttachmentHandle,
  RuntimeObservation,
  SessionRuntimeSpec,
} from "@volli/shared";

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: never[]) => unknown>(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle(channel: string, handler: (...args: never[]) => unknown) {
      handlers.set(channel, handler);
    },
  },
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: () => "/tmp/volli-secrecy" },
}));

import { openTestDb, type TestDb } from "../db/test-helpers";
import { readSecret } from "../db/secrets-repo";
import { registerDataIpcHandlers } from "../data-ipc";
import { createPiNativeAdapter, type PiRuntimeContext } from "../session-runtime/pi-adapter";
import { BRAVE_SEARCH_KEY_SECRET, EXA_SEARCH_KEY_SECRET, WebCredentialStore } from "./credential";
import { registerWebAccessIpcHandlers } from "./ipc";
import { webPortsFor } from "./ports";
import { WebAccessSettings } from "./settings";

const KEY = "BSA-super-secret-brave-key-42";
const EXA_KEY = "exa-super-secret-second-key-77";

/** A runtime that keeps the spec it was started with, and nothing else. */
class SpecRecordingRuntime implements AgentRuntime {
  spec: SessionRuntimeSpec | null = null;

  async inspectModelAccess(): Promise<never> {
    throw new Error("not used");
  }

  async completeUtility(): Promise<never> {
    throw new Error("not used");
  }

  async startSession(spec: SessionRuntimeSpec): Promise<RuntimeAttachmentHandle> {
    this.spec = spec;
    return {
      submitUserMessage: async () => ({ kind: "delivered" }) as never,
      selectModel: async () => ({ kind: "selected" }) as never,
      interrupt: async () => {},
      retryLastTurn: async () => ({ kind: "delivered" }) as never,
      close: async () => {},
      reconcile: async () => ({ observations: [], receipts: [] }),
      recovery: {
        runtime: "pi",
        sessionId: "pi-session-9",
        sessionFilePath: "/data/pi-sessions/pi-session-9.jsonl",
      },
    } as unknown as RuntimeAttachmentHandle;
  }
}

class RecordingSink implements ObservationSink {
  readonly observations: RuntimeObservation[] = [];

  async emit(observation: RuntimeObservation): Promise<void> {
    this.observations.push(observation);
  }
}

const context: PiRuntimeContext = {
  role: "project",
  ticketId: null,
  location: "main-checkout",
  projectId: "project-1",
  rootThreadId: sessionRootThreadId("session-1"),
  brief: "Find out how people test Electron main.",
  model: { providerId: "anthropic", modelId: "claude", reasoningLevel: "medium" },
  promptResources: [],
};

let ctx: TestDb;
let settings: WebAccessSettings;

async function invoke(channel: VolliIpcChannel, ...args: unknown[]): Promise<unknown> {
  const handler = handlers.get(channel);
  if (handler === undefined) throw new Error(`No handler registered for ${channel}`);
  return (handler as (event: unknown, ...rest: unknown[]) => unknown)({ sender: {} }, ...args);
}

/** Attach one Session with the ports this profile's setting currently produces. */
async function attach(): Promise<{ runtime: SpecRecordingRuntime; sink: RecordingSink }> {
  const runtime = new SpecRecordingRuntime();
  const adapter = createPiNativeAdapter({
    sessionDataDir: "/data/pi-sessions",
    resolveRuntimeContext: async () => context,
    resolveWebPorts: () => webPortsFor(settings.resolve()),
    createRuntime: () => runtime,
  });
  const sink = new RecordingSink();
  const spec: NativeAttachmentSpec = {
    sessionId: "session-1",
    attachmentId: "attachment-1",
    directory: "/work/volli",
    continuity: "fresh",
    native: null,
  };
  const binding: BindingHandle = await adapter.attach(spec, sink);
  await binding.release("requested");
  return { runtime, sink };
}

beforeEach(() => {
  handlers.clear();
  ctx = openTestDb();
  settings = new WebAccessSettings({
    db: ctx.db,
    credentials: {
      brave: new WebCredentialStore({ db: ctx.db, secretName: BRAVE_SEARCH_KEY_SECRET }),
      exa: new WebCredentialStore({ db: ctx.db, secretName: EXA_SEARCH_KEY_SECRET }),
    },
  });
  registerWebAccessIpcHandlers(settings);
  registerDataIpcHandlers({ ok: true, db: ctx.db }, {});
});

afterEach(() => {
  vi.restoreAllMocks();
  ctx.cleanup();
});

describe("where a stored API key can and cannot be seen", () => {
  it("is not in the payload the renderer boots from", async () => {
    await invoke("volli:web-access-set-provider", "brave", null);
    await invoke("volli:web-access-set-key", "brave", KEY);

    const bootstrap = (await invoke("volli:data-bootstrap")) as BootstrapResult;

    // The whole renderer bootstrap, `app_state` included — which is exactly why
    // the key lives in its own table and the settings in another, rather than in
    // the key/value store that ships wholesale to the renderer.
    const payload = JSON.stringify(bootstrap);
    expect(payload).not.toContain(KEY);
    // Stored, and stored as itself: the assertion above is about a key that is
    // really there, and the row is the plaintext the renderer must never be
    // handed rather than ciphertext it could do nothing with.
    expect(readSecret(ctx.db, BRAVE_SEARCH_KEY_SECRET)).toBe(KEY);
    expect(payload).not.toContain("web-access.brave.api-key");
  });

  /**
   * The same four claims, for the second keyed provider.
   *
   * Written out rather than folded into the Brave cases with a loop, because a
   * second provider is exactly where a secrecy rule gets applied to the first
   * one only — the store, the row and the settings arm are all per-provider,
   * and none of them inherit the first one's proof.
   */
  it("keeps Exa's key out of the renderer, the Session and the log too", async () => {
    const printed: unknown[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        printed.push(...args);
      });
    }

    await invoke("volli:web-access-set-provider", "exa", null);
    await invoke("volli:web-access-set-key", "exa", EXA_KEY);

    const bootstrap = (await invoke("volli:data-bootstrap")) as BootstrapResult;
    const { runtime, sink } = await attach();
    await invoke("volli:web-access-get");
    settings.resolve();

    // Configured for real, so the absences below are not an unconfigured
    // Session's absences.
    expect(typeof runtime.spec?.webSearch).toBe("function");

    expect(readSecret(ctx.db, EXA_SEARCH_KEY_SECRET)).toBe(EXA_KEY);
    const payload = JSON.stringify(bootstrap);
    expect(payload).not.toContain(EXA_KEY);
    expect(JSON.stringify(runtime.spec)).not.toContain(EXA_KEY);
    expect(JSON.stringify(sink.observations)).not.toContain(EXA_KEY);
    expect(JSON.stringify(printed)).not.toContain(EXA_KEY);
  });

  it("stores each provider's key in its own row, so neither overwrites the other", async () => {
    await invoke("volli:web-access-set-key", "brave", KEY);
    await invoke("volli:web-access-set-key", "exa", EXA_KEY);

    // Two rows, two keys, and neither store answered with the other's.
    expect(readSecret(ctx.db, BRAVE_SEARCH_KEY_SECRET)).toBe(KEY);
    expect(readSecret(ctx.db, EXA_SEARCH_KEY_SECRET)).toBe(EXA_KEY);

    // And clearing one leaves the other where it was.
    await invoke("volli:web-access-clear-key", "exa");
    expect(readSecret(ctx.db, BRAVE_SEARCH_KEY_SECRET)).not.toBeNull();
    expect(readSecret(ctx.db, EXA_SEARCH_KEY_SECRET)).toBeNull();
  });

  it("is not in the Session spec, and not in one Session fact", async () => {
    await invoke("volli:web-access-set-provider", "brave", null);
    await invoke("volli:web-access-set-key", "brave", KEY);

    const { runtime, sink } = await attach();

    // The tools are on offer: this Session really is the configured case, so
    // the absence below is not the absence of a Session that got nothing.
    expect(typeof runtime.spec?.webSearch).toBe("function");
    expect(typeof runtime.spec?.webFetch).toBe("function");

    // Everything that crosses into the runtime, and everything the runtime
    // handed back for the ledger. The prompt, the brief and the identity all
    // ride the first; every durable Session fact rides the second.
    expect(JSON.stringify(runtime.spec)).not.toContain(KEY);
    expect(JSON.stringify(sink.observations)).not.toContain(KEY);
  });

  it("is not printed, by this surface or the one that attaches a Session", async () => {
    const printed: unknown[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        printed.push(...args);
      });
    }

    await invoke("volli:web-access-set-provider", "brave", null);
    await invoke("volli:web-access-set-key", "brave", KEY);
    await invoke("volli:web-access-get");
    await attach();
    settings.resolve();

    expect(JSON.stringify(printed)).not.toContain(KEY);
  });

  it("is out of reach of the renderer's own writable key/value store", async () => {
    await invoke("volli:web-access-set-key", "brave", KEY);

    // `volli:app-state-set` takes any key and any string the renderer likes.
    // Web Access lives outside it in both directions: the renderer cannot write
    // the provider setting around the endpoint policy, and cannot read the
    // ciphertext back out of the bootstrap.
    await invoke(
      "volli:app-state-set",
      "volli:web-access",
      JSON.stringify({ provider: "searxng" }),
    );

    expect(settings.view().provider).toBe("off");
    expect(settings.resolve()).toEqual({ configured: false, reason: "off" });
  });
});
