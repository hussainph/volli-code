// @vitest-environment jsdom
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  DEFAULT_COMPACTION_POLICY,
  EMPTY_MODEL_ACCESS_DEFAULTS,
  type ModelAccessSnapshot,
  type ModelSelection,
} from "@volli/shared";

import {
  ModelAccessProvider,
  useModelAccessClient,
  type ModelAccessClient,
  type ModelAccessContextValue,
} from "@renderer/lib/model-access-client";

/**
 * What the provider holds, as the surfaces read it.
 *
 * Every mount effect here is spelled the way the real ones are — an independent
 * `inspect` + `hiddenModels` + `defaults` in an effect keyed on the revision —
 * because the memo exists precisely for that shape: two mounts are two asks,
 * and the hold is what turns them into one sweep. Ticket switches and chat tab
 * switches are remounts, so the remount below is the case that matters.
 */

const SNAPSHOT: ModelAccessSnapshot = { observedAt: 1, providers: [], models: [] };

function snapshotAt(observedAt: number): ModelAccessSnapshot {
  return { observedAt, providers: [], models: [] };
}

const REFRESH_REPORT = {
  added: 1,
  removed: 0,
  rejected: 0,
  refreshedProviderIds: ["acme"],
  failedProviderIds: [],
} as const;

interface TestHandles {
  client: ModelAccessClient;
  inspect: ReturnType<typeof vi.fn<ModelAccessClient["inspect"]>>;
  defaults: ReturnType<typeof vi.fn<ModelAccessClient["defaults"]>>;
  hiddenModels: ReturnType<typeof vi.fn<ModelAccessClient["hiddenModels"]>>;
  signOut: ReturnType<typeof vi.fn<ModelAccessClient["signOut"]>>;
  setDefault: ReturnType<typeof vi.fn<ModelAccessClient["setDefault"]>>;
  setHiddenModels: ReturnType<typeof vi.fn<ModelAccessClient["setHiddenModels"]>>;
  beginSignIn: ReturnType<typeof vi.fn<ModelAccessClient["beginSignIn"]>>;
}

function testClient(overrides: Partial<ModelAccessClient> = {}): TestHandles {
  const inspect = overrides.inspect ?? vi.fn<ModelAccessClient["inspect"]>(async () => SNAPSHOT);
  const defaults =
    overrides.defaults ??
    vi.fn<ModelAccessClient["defaults"]>(async () => EMPTY_MODEL_ACCESS_DEFAULTS);
  const hiddenModels =
    overrides.hiddenModels ?? vi.fn<ModelAccessClient["hiddenModels"]>(async () => []);
  const signOut = overrides.signOut ?? vi.fn<ModelAccessClient["signOut"]>(async () => undefined);
  const setDefault =
    overrides.setDefault ??
    vi.fn<ModelAccessClient["setDefault"]>(async () => EMPTY_MODEL_ACCESS_DEFAULTS);
  const setHiddenModels =
    overrides.setHiddenModels ??
    vi.fn<ModelAccessClient["setHiddenModels"]>(async (hidden) => hidden);
  const beginSignIn =
    overrides.beginSignIn ??
    vi.fn<ModelAccessClient["beginSignIn"]>(async () => {
      throw new Error("not under test");
    });
  return {
    inspect: inspect as TestHandles["inspect"],
    defaults: defaults as TestHandles["defaults"],
    hiddenModels: hiddenModels as TestHandles["hiddenModels"],
    signOut: signOut as TestHandles["signOut"],
    setDefault: setDefault as TestHandles["setDefault"],
    setHiddenModels: setHiddenModels as TestHandles["setHiddenModels"],
    beginSignIn: beginSignIn as TestHandles["beginSignIn"],
    client: {
      inspect,
      defaults,
      hiddenModels,
      signOut,
      setDefault,
      setHiddenModels,
      beginSignIn,
      compactionPolicy: overrides.compactionPolicy ?? (async () => DEFAULT_COMPACTION_POLICY),
      setCompactionPolicy: overrides.setCompactionPolicy ?? (async (policy) => policy),
      pickerView: overrides.pickerView ?? (async () => "all" as const),
      setPickerView: overrides.setPickerView ?? (async (view) => view),
    },
  };
}

/** A promise a test resolves by hand, so two mounts can share an in-flight read. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  const box = Promise.withResolvers<T>();
  return { promise: box.promise, resolve: box.resolve, reject: box.reject };
}

/** The latest context value, which is how a test presses the shared controls. */
let handle: ModelAccessContextValue | null = null;

function Capture(): null {
  handle = useModelAccessClient();
  return null;
}

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  handle = null;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

/** One mount effect, the shape every real surface has. */
function Probe({ onRead }: { onRead?: (snapshot: ModelAccessSnapshot) => void }): null {
  const value = useModelAccessClient();
  const inspect = value?.inspect;
  const hiddenModels = value?.hiddenModels;
  const readDefaults = value?.defaults;
  const revision = value?.revision ?? 0;
  // Held apart from the effect so a parent re-render that only re-spells the
  // callback does not count as a read — the real surfaces key on the client
  // and the revision, not on anything a render passes down.
  const latest = React.useRef(onRead);
  latest.current = onRead;
  React.useEffect(() => {
    if (inspect === undefined || hiddenModels === undefined || readDefaults === undefined) return;
    let current = true;
    void Promise.all([inspect({}), hiddenModels(), readDefaults()]).then(
      ([access]) => {
        if (current) latest.current?.(access);
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [inspect, hiddenModels, readDefaults, revision]);
  return null;
}

/**
 * `probes` is a count rather than interpolated children on purpose: React 19
 * remounts the earlier siblings when the shape of an interpolated `children`
 * prop changes, which is exactly the remount this file must not confuse with a
 * mount. A keyed list keeps the earlier probes mounted while one is added.
 */
function Harness({
  client,
  probes = 1,
  onRead,
}: {
  client: ModelAccessClient;
  probes?: number;
  onRead?: (snapshot: ModelAccessSnapshot) => void;
}): React.ReactElement {
  return (
    <ModelAccessProvider client={client}>
      <Capture />
      {Array.from({ length: probes }, (_, index) => (
        <Probe key={index} onRead={onRead} />
      ))}
    </ModelAccessProvider>
  );
}

async function mount(children: React.ReactNode): Promise<void> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(children);
  });
}

async function remount(children: React.ReactNode): Promise<void> {
  await act(async () => {
    root?.render(children);
  });
}

describe("the shared Model Access reads", () => {
  it("serves a remount from the sweep already held, with no second inspection", async () => {
    const t = testClient();
    const reads: ModelAccessSnapshot[] = [];
    await mount(<Harness client={t.client} onRead={(read) => reads.push(read)} />);
    expect(t.inspect).toHaveBeenCalledTimes(1);
    expect(t.hiddenModels).toHaveBeenCalledTimes(1);
    expect(t.defaults).toHaveBeenCalledTimes(1);

    // A ticket switch: a fresh chat plane beside the one already mounted.
    await remount(<Harness client={t.client} probes={2} onRead={(read) => reads.push(read)} />);

    expect(reads).toEqual([SNAPSHOT, SNAPSHOT]);
    // The sweep is held; the two cheap preference reads are asked again, so a
    // write the renderer never made is still seen by the next mount.
    expect(t.inspect).toHaveBeenCalledTimes(1);
    expect(t.hiddenModels).toHaveBeenCalledTimes(2);
    expect(t.defaults).toHaveBeenCalledTimes(2);
  });

  it("shares one inspection between two composers mounting in the same frame", async () => {
    const pending = deferred<ModelAccessSnapshot>();
    const t = testClient({ inspect: vi.fn<ModelAccessClient["inspect"]>(() => pending.promise) });
    const reads: ModelAccessSnapshot[] = [];
    await mount(<Harness client={t.client} probes={2} onRead={(read) => reads.push(read)} />);

    expect(t.inspect).toHaveBeenCalledTimes(1);
    expect(t.hiddenModels).toHaveBeenCalledTimes(1);
    expect(t.defaults).toHaveBeenCalledTimes(1);
    expect(reads).toEqual([]);

    await act(async () => {
      pending.resolve(SNAPSHOT);
      await pending.promise;
    });
    expect(reads).toEqual([SNAPSHOT, SNAPSHOT]);
  });

  it("re-reads after sign-out, a saved default and a visibility write", async () => {
    const t = testClient();
    await mount(<Harness client={t.client} />);
    expect(t.inspect).toHaveBeenCalledTimes(1);

    const selection: ModelSelection = { providerId: "acme", modelId: "m", reasoningLevel: "off" };
    await act(async () => {
      await handle!.setDefault("global", selection);
    });
    await act(async () => {
      await handle!.setHiddenModels([{ providerId: "acme", modelId: "m" }]);
    });
    await act(async () => {
      await handle!.signOut("acme");
    });

    expect(t.inspect).toHaveBeenCalledTimes(4);
    expect(t.hiddenModels).toHaveBeenCalledTimes(4);
    expect(t.defaults).toHaveBeenCalledTimes(4);
  });

  it("re-reads when a sign-in settles signed-in, and not when it only ends", async () => {
    let outcome: "signed-in" | "cancelled" = "signed-in";
    const t = testClient({
      beginSignIn: vi.fn<ModelAccessClient["beginSignIn"]>(async (_providerId, _type, onUpdate) => {
        onUpdate({ attemptId: "a1", kind: "settled", outcome: { kind: outcome } });
        return {
          attemptId: "a1",
          respond: async () => undefined,
          cancel: async () => undefined,
        };
      }),
    });
    await mount(<Harness client={t.client} />);
    expect(t.inspect).toHaveBeenCalledTimes(1);

    await act(async () => {
      await handle!.beginSignIn("acme", "oauth", () => undefined);
    });
    expect(t.inspect).toHaveBeenCalledTimes(2);

    outcome = "cancelled";
    await act(async () => {
      await handle!.beginSignIn("acme", "oauth", () => undefined);
    });
    expect(t.inspect).toHaveBeenCalledTimes(2);
  });

  it("lets an explicit Refresh bypass the hold, replace it and wake the readers", async () => {
    const refreshed: ModelAccessSnapshot = {
      ...snapshotAt(2),
      refresh: REFRESH_REPORT,
    };
    const t = testClient();
    t.inspect.mockResolvedValueOnce(SNAPSHOT).mockResolvedValueOnce(refreshed);
    const reads: ModelAccessSnapshot[] = [];
    await mount(<Harness client={t.client} onRead={(read) => reads.push(read)} />);
    expect(reads).toEqual([SNAPSHOT]);

    let answered: ModelAccessSnapshot | undefined;
    await act(async () => {
      answered = await handle!.inspect({ refresh: true });
    });
    expect(answered).toEqual(refreshed);
    expect(t.inspect).toHaveBeenCalledTimes(2);

    // The bump re-read this open mount. It found the refreshed catalog — not
    // another sweep, and not the refresh report, which belonged to the caller
    // that pressed Refresh.
    expect(reads).toEqual([SNAPSHOT, snapshotAt(2)]);

    // And a mount arriving afterwards still finds it held.
    await remount(<Harness client={t.client} probes={2} onRead={(read) => reads.push(read)} />);
    expect(t.inspect).toHaveBeenCalledTimes(2);
    expect(reads).toEqual([SNAPSHOT, snapshotAt(2), snapshotAt(2)]);
  });

  it("drops the answer of a Refresh a credential change overtook", async () => {
    const refreshing = deferred<ModelAccessSnapshot>();
    const afterSignOut = deferred<ModelAccessSnapshot>();
    const t = testClient();
    t.inspect
      .mockResolvedValueOnce(SNAPSHOT)
      .mockImplementationOnce(() => refreshing.promise)
      .mockImplementationOnce(() => afterSignOut.promise);
    const reads: ModelAccessSnapshot[] = [];
    await mount(<Harness client={t.client} onRead={(read) => reads.push(read)} />);
    expect(reads).toEqual([SNAPSHOT]);

    // A person presses Refresh, and signs a provider out before it answers.
    let refreshAnswer: Promise<ModelAccessSnapshot> | undefined;
    await act(async () => {
      refreshAnswer = handle!.inspect({ refresh: true });
    });
    await act(async () => {
      await handle!.signOut("acme");
    });
    expect(t.inspect).toHaveBeenCalledTimes(3);

    // The Refresh now lands. Its catalog was read BEFORE the sign-out, so
    // publishing it would put the signed-out provider back on every open
    // surface. The caller that pressed Refresh is still told what it did.
    await act(async () => {
      refreshing.resolve({ ...snapshotAt(2), refresh: REFRESH_REPORT });
      await refreshAnswer;
    });
    await expect(refreshAnswer!).resolves.toMatchObject({ refresh: REFRESH_REPORT });

    // What the surfaces read is the sign-out's own sweep, and no fourth sweep
    // was started to get it.
    await act(async () => {
      afterSignOut.resolve(snapshotAt(3));
      await afterSignOut.promise;
    });
    expect(reads).toEqual([SNAPSHOT, snapshotAt(3)]);
    expect(t.inspect).toHaveBeenCalledTimes(3);

    // And a mount arriving now joins the sign-out's answer, not the Refresh's.
    await remount(<Harness client={t.client} probes={2} onRead={(read) => reads.push(read)} />);
    expect(reads).toEqual([SNAPSHOT, snapshotAt(3), snapshotAt(3)]);
    expect(t.inspect).toHaveBeenCalledTimes(3);
  });

  it("retries a read that failed rather than replaying the failure", async () => {
    const pending = deferred<ModelAccessSnapshot>();
    const t = testClient();
    t.inspect.mockImplementationOnce(() => pending.promise).mockResolvedValue(SNAPSHOT);
    await mount(<Harness client={t.client} />);
    expect(t.inspect).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.reject(new Error("main is not up"));
    });
    await remount(<Harness client={t.client} probes={2} />);
    expect(t.inspect).toHaveBeenCalledTimes(2);
  });

  it("does not let an overtaken read's failure clear the read that replaced it", async () => {
    const firstRead = deferred<ModelAccessSnapshot>();
    const secondRead = deferred<ModelAccessSnapshot>();
    const t = testClient();
    t.inspect
      .mockImplementationOnce(() => firstRead.promise)
      .mockImplementationOnce(() => secondRead.promise);
    await mount(<Harness client={t.client} />);
    expect(t.inspect).toHaveBeenCalledTimes(1);

    // A credential change invalidates while the first read is still out...
    await act(async () => {
      await handle!.signOut("acme");
    });
    expect(t.inspect).toHaveBeenCalledTimes(2);

    // ...and the overtaken read then fails. The read that replaced it must
    // survive: a mount arriving now joins it rather than starting a third
    // sweep.
    await act(async () => {
      firstRead.reject(new Error("too late"));
    });
    await remount(<Harness client={t.client} probes={2} />);
    expect(t.inspect).toHaveBeenCalledTimes(2);

    await act(async () => {
      secondRead.resolve(SNAPSHOT);
    });
  });
});
