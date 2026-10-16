// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type {
  DatabaseOpenFault,
  DatabaseRecoveryFaultResult,
  DatabaseRecoveryListResult,
  DatabaseRecoveryRestoreResult,
  DatabaseSafetyCopy,
  Result,
  UpdateUiState,
} from "../../../ipc/contract";
import { BootErrorPanel, DOWNLOAD_URL, NEWER_VERSION_TITLE } from "./boot-error-panel";

const RESTORE_LABEL = "Restore from the last backup that checks clean";
const CLEAN: DatabaseSafetyCopy = {
  name: "volli.db.backup-v2",
  modifiedAt: 2000,
  integrity: "clean",
};
const DAMAGED: DatabaseSafetyCopy = {
  name: "volli.db.backup-v3",
  modifiedAt: 3000,
  integrity: "damaged",
};
const UNAVAILABLE: DatabaseSafetyCopy = {
  name: "volli.db.backup-v1",
  modifiedAt: 1000,
  integrity: "unavailable",
};

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function bridge(
  listResult: DatabaseRecoveryListResult | Error = { ok: true, backups: [CLEAN] },
  restoreResult: DatabaseRecoveryRestoreResult | Error = {
    ok: true,
    restoredBackup: CLEAN.name,
  },
) {
  const list = vi.fn(async (): Promise<DatabaseRecoveryListResult> => {
    if (listResult instanceof Error) throw listResult;
    return listResult;
  });
  const restore = vi.fn(async (): Promise<DatabaseRecoveryRestoreResult> => {
    if (restoreResult instanceof Error) throw restoreResult;
    return restoreResult;
  });
  const fault = vi.fn(async (): Promise<DatabaseRecoveryFaultResult> => ({
    ok: true,
    fault: "unreadable",
  }));
  const quit = vi.fn(async (): Promise<Result> => ({ ok: true }));
  const updates = updater();
  vi.stubGlobal("api", { databaseRecovery: { list, restore, fault, quit }, updates });
  return { list, restore, fault, quit, updates };
}

function updaterState(overrides: Partial<UpdateUiState> = {}): UpdateUiState {
  return {
    supported: true,
    phase: "idle",
    currentVersion: "0.4.0",
    targetVersion: null,
    percent: null,
    error: null,
    ...overrides,
  };
}

function updater(initial: UpdateUiState = updaterState()) {
  let listener: ((state: UpdateUiState) => void) | undefined;
  return {
    state: vi.fn(async () => ({ ok: true as const, state: initial })),
    check: vi.fn(async (): Promise<Result> => ({ ok: true })),
    install: vi.fn(async (): Promise<Result> => ({ ok: true })),
    onState: vi.fn((callback: (state: UpdateUiState) => void) => {
      listener = callback;
      return () => {
        listener = undefined;
      };
    }),
    push: (state: UpdateUiState) => listener?.(state),
  };
}

/** A main process whose database came from a newer Volli (VC-602). */
function newerBridge(
  fault: DatabaseOpenFault = "newer-version",
  initial: UpdateUiState = updaterState(),
) {
  const main = bridge({ ok: true, backups: [] });
  main.fault.mockResolvedValue({ ok: true, fault });
  main.updates.state.mockResolvedValue({ ok: true, state: initial });
  return main;
}

function buttonLabelled(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === label,
  );
  if (found === undefined) throw new Error(`No button labelled ${label}`);
  return found;
}

function downloadLink(): HTMLAnchorElement | null {
  return container.querySelector(`a[href="${DOWNLOAD_URL}"]`);
}

async function mount(
  error = "The local database failed to open: database disk image is malformed",
) {
  await act(async () => root.render(<BootErrorPanel error={error} />));
}

function text() {
  return container.textContent ?? "";
}

function restoreButton(): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === RESTORE_LABEL,
  );
  if (button === undefined) throw new Error("Restore action is missing");
  return button;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

describe("BootErrorPanel", () => {
  it("lists checked safety copies newest first and wires the one primary action to preload", async () => {
    const main = bridge({ ok: true, backups: [UNAVAILABLE, CLEAN, DAMAGED] });
    await mount();

    const rows = [...container.querySelectorAll("li")];
    expect(rows.map((row) => row.querySelector("p")?.textContent)).toEqual([
      DAMAGED.name,
      CLEAN.name,
      UNAVAILABLE.name,
    ]);
    expect(rows.map((row) => row.querySelector("span")?.textContent)).toEqual([
      "damaged",
      "clean",
      "unavailable",
    ]);
    expect(container.querySelectorAll("time")).toHaveLength(3);
    expect(main.list).toHaveBeenCalledOnce();
    expect(restoreButton().disabled).toBe(false);
    expect(restoreButton().dataset.variant).toBe("default");
    expect(container.querySelectorAll("button")).toHaveLength(1);
    expect(text()).toContain("Changes since that backup won't be included.");

    await act(async () => restoreButton().click());

    // Main selects and rechecks the newest clean candidate: renderer sends no
    // filename or path, and does not reload against the degraded process.
    expect(main.restore).toHaveBeenCalledExactlyOnceWith();
    expect(text()).toContain("Backup restored. Volli is restarting…");
    expect(container.querySelector("[role='status']")?.textContent).toBeTruthy();
    expect(restoreButton().disabled).toBe(true);
    await act(async () => restoreButton().click());
    expect(main.restore).toHaveBeenCalledOnce();
  });

  it("offers no restore until the list confirms degraded DB recovery", async () => {
    const main = bridge();
    const pending = deferred<DatabaseRecoveryListResult>();
    main.list.mockReturnValue(pending.promise);
    await mount();

    expect(text()).toContain("Checking whether backup recovery is available…");
    expect(container.querySelector("button")).toBeNull();
    expect(text()).not.toContain("Local safety copies");

    await act(async () => pending.resolve({ ok: true, backups: [CLEAN] }));
    expect(restoreButton().disabled).toBe(false);
  });

  it("disables duplicate presses during restore, including two clicks before a render", async () => {
    const main = bridge();
    const pending = deferred<DatabaseRecoveryRestoreResult>();
    main.restore.mockReturnValue(pending.promise);
    await mount();

    await act(async () => {
      restoreButton().click();
      restoreButton().click();
    });
    expect(main.restore).toHaveBeenCalledOnce();
    expect(restoreButton().disabled).toBe(true);
    expect(text()).toContain("Restoring the last backup that checks clean…");
    expect(text()).not.toContain("Backup restored.");

    await act(async () => pending.resolve({ ok: true, restoredBackup: CLEAN.name }));
    expect(text()).toContain("Volli is restarting…");
    expect(restoreButton().disabled).toBe(true);
  });

  it.each([{ backups: [] }, { backups: [DAMAGED, UNAVAILABLE] }])(
    "fails closed without a clean copy (%j), preserving manual recovery wording",
    async ({ backups }) => {
      const main = bridge({ ok: true, backups });
      await mount();
      expect(text()).toContain("No local backup checks clean. Nothing was restored.");
      expect(text()).toContain(
        "Your database and safety copies are preserved for manual recovery.",
      );
      expect(restoreButton().disabled).toBe(true);
      await act(async () => restoreButton().click());
      expect(main.restore).not.toHaveBeenCalled();
      expect(text()).not.toContain("Backup restored.");
    },
  );

  it.each([
    {
      ok: false,
      error: "Backup recovery is only available when the database failed to open.",
    } as const,
    new Error("ENOENT: /private/profile/volli.db"),
  ])("does not offer DB recovery for an unconfirmed/failed list (%j)", async (result) => {
    const main = bridge(result);
    await mount("A renderer preference failed to load");

    expect(text()).toContain("A renderer preference failed to load");
    expect(text()).toContain("Backup recovery is unavailable. No files were changed.");
    expect(text()).not.toContain("Local safety copies");
    expect(text()).not.toContain("No local backup checks clean");
    expect(text()).not.toContain("/private/profile");
    expect(container.querySelector("button")).toBeNull();
    expect(main.restore).not.toHaveBeenCalled();
  });

  it.each([
    { ok: false, error: "EACCES: /private/profile/volli.db" } as const,
    new Error("ENOENT: /private/profile/volli.db.backup-v2"),
  ])(
    "reports restore failure without diagnostics and permits an explicit retry (%j)",
    async (result) => {
      const main = bridge({ ok: true, backups: [CLEAN] }, result);
      await mount();
      await act(async () => restoreButton().click());

      expect(text()).toContain("Couldn't restore a clean backup. Volli has not restarted.");
      expect(text()).toContain("preserved for manual recovery");
      expect(text()).not.toContain("/private/profile");
      expect(text()).not.toContain("Backup restored.");
      expect(restoreButton().disabled).toBe(false);
      expect(console.warn).toHaveBeenCalled();

      main.restore.mockResolvedValue({ ok: true, restoredBackup: CLEAN.name });
      await act(async () => restoreButton().click());
      expect(main.restore).toHaveBeenCalledTimes(2);
      expect(text()).toContain("Backup restored. Volli is restarting…");
      expect(text()).not.toContain("Couldn't restore");
    },
  );

  it("reports the explicit no-clean failure if backups changed after listing", async () => {
    const failure =
      "No local backup checks clean. Nothing was restored. Your database and safety copies are preserved for manual recovery.";
    bridge({ ok: true, backups: [CLEAN] }, { ok: false, error: failure });
    await mount();
    await act(async () => restoreButton().click());
    expect(text()).toContain(failure);
    expect(text()).not.toContain("Backup restored.");
  });

  it("keeps filesystem boot diagnostics out of the page too", async () => {
    bridge();
    await mount("Cannot open '/private/profile/volli.db'");
    expect(text()).not.toContain("/private/profile");
    expect(text()).toContain("The failure details are available in the diagnostic log.");
    expect(console.warn).toHaveBeenCalledWith(
      "[volli] boot failure:",
      "Cannot open '/private/profile/volli.db'",
    );
  });

  it("ignores a stale list when the mount effect is restarted", async () => {
    const main = bridge();
    const stale = deferred<DatabaseRecoveryListResult>();
    main.list.mockReturnValueOnce(stale.promise);
    await act(async () => {
      root.render(
        <StrictMode>
          <BootErrorPanel error="Database failed" />
        </StrictMode>,
      );
    });
    expect(main.list).toHaveBeenCalledTimes(2);
    expect(restoreButton().disabled).toBe(false);

    await act(async () => stale.resolve({ ok: true, backups: [] }));
    expect(restoreButton().disabled).toBe(false);
    expect(text()).not.toContain("No local backup checks clean");
  });

  it("names a database from a newer Volli, without the raw error", async () => {
    const main = newerBridge();
    main.list.mockResolvedValue({
      ok: true,
      backups: [CLEAN, { name: "volli.db.backup-v99", modifiedAt: 4000, integrity: "newer" }],
    });
    await mount("This database was created by a newer version of Volli. Nothing was changed.");

    expect(container.querySelector("h1")?.textContent).toBe(NEWER_VERSION_TITLE);
    expect(text()).toContain(
      "This version can't open it, so nothing was changed. Update Volli, or restore an older backup.",
    );
    expect(text()).not.toContain("Volli couldn't load its data");
    expect([...container.querySelectorAll("li span")].map((span) => span.textContent)).toEqual([
      "newer version",
      "clean",
    ]);
    // Restoring an older backup is the same action as on the damaged screen.
    expect(restoreButton().disabled).toBe(false);
  });

  it("checks for updates, then offers the download page when nothing is newer", async () => {
    const main = newerBridge();
    await mount();
    expect(downloadLink()).toBeNull();

    await act(async () => buttonLabelled("Check for updates").click());
    expect(main.updates.check).toHaveBeenCalledOnce();
    // Nothing is said about the result until the check has actually run.
    expect(text()).not.toContain("No newer version");
    await act(async () => main.updates.push(updaterState({ phase: "checking" })));
    expect(buttonLabelled("Checking…").disabled).toBe(true);
    await act(async () => main.updates.push(updaterState({ phase: "idle" })));
    expect(text()).toContain("No newer version on this update channel.");
    expect(text()).toContain(
      "This database needs a newer Volli. If you switched from Canary, reinstall Canary from the download page, or wait for a newer release here.",
    );
    expect(downloadLink()?.target).toBe("_blank");
  });

  it("shows the download, then installs the update on request", async () => {
    const main = newerBridge();
    await mount();
    await act(async () =>
      main.updates.push(updaterState({ phase: "downloading", targetVersion: "0.5.0", percent: 3 })),
    );
    expect(text()).toContain("Downloading Volli 0.5.0…");
    expect(buttonLabelled("Check for updates").disabled).toBe(true);
    await act(async () =>
      main.updates.push(updaterState({ phase: "downloaded", targetVersion: "0.5.0" })),
    );
    expect(text()).toContain("Volli 0.5.0 is ready.");
    await act(async () => buttonLabelled("Restart to update").click());
    expect(main.updates.install).toHaveBeenCalledOnce();

    main.updates.install.mockResolvedValueOnce({
      ok: false,
      error: "No update has been downloaded yet.",
    });
    await act(async () => buttonLabelled("Restart to update").click());
    expect(text()).toContain("Couldn't install the update.");
  });

  it("says when a check fails, and offers the download page", async () => {
    const main = newerBridge();
    await mount();
    await act(async () =>
      main.updates.push(updaterState({ phase: "error", error: "network down" })),
    );
    expect(text()).toContain("Couldn't check for updates.");
    expect(downloadLink()).not.toBeNull();
  });

  it("offers the download page instead of a check when this build has no updater", async () => {
    newerBridge("newer-version", updaterState({ supported: false }));
    await mount();
    expect(downloadLink()?.textContent).toBe("Open the download page");
    expect(
      [...container.querySelectorAll("button")].some((b) => b.textContent === "Check for updates"),
    ).toBe(false);
  });

  it("quits on request, and says so when it cannot", async () => {
    const main = newerBridge();
    await mount();
    await act(async () => buttonLabelled("Quit Volli").click());
    expect(main.quit).toHaveBeenCalledOnce();
    expect(text()).not.toContain("Couldn't quit Volli.");

    main.quit.mockRejectedValueOnce(new Error("ipc closed"));
    await act(async () => buttonLabelled("Quit Volli").click());
    expect(text()).toContain("Couldn't quit Volli.");
  });

  it("keeps working when the updater cannot be read or watched", async () => {
    const main = newerBridge();
    main.updates.state.mockRejectedValue(new Error("no updater"));
    main.updates.onState.mockImplementation(() => {
      throw new Error("no listener");
    });
    await mount();
    expect(container.querySelector("h1")?.textContent).toBe(NEWER_VERSION_TITLE);
    expect(downloadLink()).not.toBeNull();
    expect(buttonLabelled("Quit Volli")).toBeTruthy();
  });

  it.each([
    ["the read throws", () => Promise.reject(new Error("no such channel"))],
    ["main refuses it", () => Promise.resolve({ ok: false as const, error: "nope" })],
  ])("falls back to the damaged-database screen when %s", async (_label, read) => {
    const main = bridge();
    main.fault.mockImplementation(read);
    await mount();
    expect(container.querySelector("h1")?.textContent).toBe("Volli couldn't load its data");
    expect(downloadLink()).toBeNull();
  });
});
