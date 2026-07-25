import { describe, expect, it } from "vite-plus/test";

import type { DocumentIdentity } from "@renderer/editor/document-identity";
import {
  DocumentRegistry,
  type RegistryModel,
  type RegistryModelFactory,
} from "@renderer/editor/document-registry";

import { closeGuardExpectedMtime } from "./files-page";

class FakeModel implements RegistryModel {
  private value: string;
  private readonly listeners = new Set<() => void>();

  constructor(value: string) {
    this.value = value;
  }

  getValue(): string {
    return this.value;
  }

  setValue(value: string): void {
    this.value = value;
    for (const listener of this.listeners) listener();
  }

  onDidChangeContent(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  dispose(): void {
    this.listeners.clear();
  }
}

const factory: RegistryModelFactory<FakeModel> = {
  createModel: ({ value }) => new FakeModel(value),
};

const identity: DocumentIdentity = {
  kind: "file",
  projectId: "project-1",
  checkout: { kind: "main" },
  relPath: "src/index.ts",
};

/** A document opened at mtime 10, edited, then overwritten on disk at mtime 20. */
function dirtyOverDiskChange() {
  const registry = new DocumentRegistry<FakeModel, unknown>(factory);
  const lease = registry.acquire({
    identity,
    viewId: "file",
    seed: { value: "one\n", revision: 10 },
    savePolicy: "explicit",
  });
  lease.model.setValue("one\ntwo\n"); // the user's unsaved draft
  lease.adoptCleanBaseline({ value: "one\nthree\n", revision: 20 }); // agent rewrote the file
  return { registry, lease };
}

describe("closeGuardExpectedMtime", () => {
  it("carries the freshest disk mtime for a draft that outlived an external change", () => {
    const { lease } = dirtyOverDiskChange();
    const snapshot = lease.snapshot();

    // The registry deliberately refuses to re-baseline a dirty document, so
    // `baselineRevision` is still the mtime the tab first loaded at. Writing
    // with it makes main reject the close guard's Save ("File changed on disk
    // since it was opened") while ⌘S in the same editor — which carries the
    // fresh mtime — succeeds, trapping the draft in a tab that will not close.
    expect(snapshot.dirty).toBe(true);
    expect(snapshot.baselineRevision).toBe(10);
    expect(closeGuardExpectedMtime(snapshot)).toBe(20);
  });

  it("refuses rather than guessing when the document's disk version is unknown", () => {
    const registry = new DocumentRegistry<FakeModel, unknown>(factory);
    const lease = registry.acquire({
      identity,
      viewId: "file",
      seed: { value: "one\n", revision: null },
      savePolicy: "explicit",
    });

    // A write with no conflict guard is the one failure mode that can silently
    // destroy someone else's newer bytes.
    expect(closeGuardExpectedMtime(lease.snapshot())).toBeNull();
  });

  it("follows a save: the saved mtime becomes what the next guarded write carries", () => {
    const { lease } = dirtyOverDiskChange();
    lease.markSaved(31);

    expect(closeGuardExpectedMtime(lease.snapshot())).toBe(31);
  });
});
