import { describe, expect, it, vi } from "vite-plus/test";

import type { DocumentIdentity } from "./document-identity";
import {
  DocumentRegistry,
  type RegistryModel,
  type RegistryModelFactory,
} from "./document-registry";

class FakeModel implements RegistryModel {
  private value: string;
  private readonly listeners = new Set<() => void>();
  readonly dispose = vi.fn();

  constructor(
    value: string,
    readonly language: string,
    readonly uri: string,
  ) {
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
    return { dispose: () => this.listeners.delete(listener) };
  }
}

function makeRegistry() {
  const models: FakeModel[] = [];
  const factory: RegistryModelFactory<FakeModel> = {
    createModel({ value, language, uri }) {
      const model = new FakeModel(value, language, uri);
      models.push(model);
      return model;
    },
  };
  return { registry: new DocumentRegistry<FakeModel, { cursor: number }>(factory), models };
}

function entryCount(registry: DocumentRegistry<FakeModel, { cursor: number }>): number {
  return (registry as unknown as { entries: Map<string, unknown> }).entries.size;
}

const mainIdentity: DocumentIdentity = {
  kind: "file",
  projectId: "project-1",
  checkout: { kind: "main" },
  relPath: "src/index.ts",
};

describe("DocumentRegistry", () => {
  it("shares one model between views of one document and isolates another checkout", () => {
    const { registry, models } = makeRegistry();
    const fileView = registry.acquire({
      identity: mainIdentity,
      viewId: "file",
      seed: { value: "export const value = 1;\n", revision: 1 },
      savePolicy: "explicit",
    });
    const secondView = registry.acquire({
      identity: { ...mainIdentity },
      viewId: "second-file-view",
      seed: { value: "export const value = 1;\n", revision: 1 },
      savePolicy: "explicit",
    });
    const ticketView = registry.acquire({
      identity: {
        ...mainIdentity,
        checkout: { kind: "ticket", ticketId: "ticket-1" },
      },
      viewId: "ticket-file",
      seed: { value: "export const value = 1;\n", revision: 1 },
      savePolicy: "explicit",
    });

    expect(secondView.model).toBe(fileView.model);
    expect(ticketView.model).not.toBe(fileView.model);
    expect(fileView.snapshot().viewReferences).toBe(2);
    expect(models).toHaveLength(2);
  });

  it("disposes a clean model only after its final view release, exactly once", () => {
    const { registry } = makeRegistry();
    const first = registry.acquire({
      identity: mainIdentity,
      viewId: "file",
      seed: { value: "clean", revision: "r1" },
      savePolicy: "explicit",
    });
    const second = registry.acquire({
      identity: mainIdentity,
      viewId: "diff-modified",
      seed: { value: "clean", revision: "r1" },
      savePolicy: "explicit",
    });
    const model = first.model as FakeModel;

    first.release();
    expect(model.dispose).not.toHaveBeenCalled();
    expect(second.snapshot().viewReferences).toBe(1);

    second.release();
    second.release();
    expect(model.dispose).toHaveBeenCalledTimes(1);
    expect(second.snapshot().viewReferences).toBe(0);
  });

  it("retains a dirty zero-view model and returns the same draft when reacquired", () => {
    const { registry } = makeRegistry();
    const first = registry.acquire({
      identity: mainIdentity,
      viewId: "file",
      seed: { value: "baseline", revision: "r1" },
      savePolicy: "explicit",
    });
    const model = first.model as FakeModel;

    model.setValue("human draft");
    expect(first.snapshot().dirty).toBe(true);
    first.release();
    expect(model.dispose).not.toHaveBeenCalled();

    const reopened = registry.acquire({
      identity: mainIdentity,
      viewId: "reopened-file",
      seed: { value: "baseline", revision: "r1" },
      savePolicy: "explicit",
    });
    expect(reopened.model).toBe(model);
    expect(reopened.model.getValue()).toBe("human draft");
    expect(reopened.snapshot().viewReferences).toBe(1);
  });

  it("stores independent serializable state for each view of a shared document", () => {
    const { registry } = makeRegistry();
    const file = registry.acquire({
      identity: mainIdentity,
      viewId: "file",
      seed: { value: "baseline", revision: "r1" },
      savePolicy: "explicit",
    });
    const diff = registry.acquire({
      identity: mainIdentity,
      viewId: "diff",
      seed: { value: "baseline", revision: "r1" },
      savePolicy: "explicit",
    });
    file.release({ cursor: 3 });
    diff.release({ cursor: 9 });

    const reopenedFile = registry.acquire({
      identity: mainIdentity,
      viewId: "file",
      seed: { value: "baseline", revision: "r1" },
      savePolicy: "explicit",
    });
    const reopenedDiff = registry.acquire({
      identity: mainIdentity,
      viewId: "diff",
      seed: { value: "baseline", revision: "r1" },
      savePolicy: "explicit",
    });
    const fileState = reopenedFile.restoreViewState();
    expect(fileState).toEqual({ cursor: 3 });
    expect(reopenedDiff.restoreViewState()).toEqual({ cursor: 9 });

    if (fileState !== null) fileState.cursor = 100;
    expect(reopenedFile.restoreViewState()).toEqual({ cursor: 3 });
  });

  it("rejects an inconsistent second seed without overwriting the shared model", () => {
    const { registry } = makeRegistry();
    const first = registry.acquire({
      identity: mainIdentity,
      viewId: "file",
      seed: { value: "baseline", revision: "r1" },
      savePolicy: "explicit",
    });

    expect(() =>
      registry.acquire({
        identity: mainIdentity,
        viewId: "second-file",
        seed: { value: "new disk bytes", revision: "r2" },
        savePolicy: "explicit",
      }),
    ).toThrow("different seed");
    expect(first.model.getValue()).toBe("baseline");
    expect(first.snapshot().baselineRevision).toBe("r1");
    expect(first.snapshot().viewReferences).toBe(1);
  });

  it("rejects a second active view with a conflicting save policy", () => {
    const { registry } = makeRegistry();
    registry.acquire({
      identity: mainIdentity,
      viewId: "file",
      seed: { value: "baseline", revision: "r1" },
      savePolicy: "read-only",
    });

    expect(() =>
      registry.acquire({
        identity: mainIdentity,
        viewId: "editable-file",
        seed: { value: "baseline", revision: "r1" },
        savePolicy: "explicit",
      }),
    ).toThrow("different save policy");
  });

  it("reopens a zero-view dirty draft and records the newer external revision", () => {
    const { registry } = makeRegistry();
    const file = registry.acquire({
      identity: mainIdentity,
      viewId: "file",
      seed: { value: "baseline", revision: "r1" },
      savePolicy: "explicit",
    });
    file.model.setValue("guarded draft");
    file.release();

    const reopened = registry.acquire({
      identity: mainIdentity,
      viewId: "reopened",
      seed: { value: "new disk bytes", revision: "r2" },
      savePolicy: "explicit",
    });
    expect(reopened.model).toBe(file.model);
    expect(reopened.model.getValue()).toBe("guarded draft");
    expect(reopened.snapshot()).toMatchObject({
      baseline: "baseline",
      baselineRevision: "r1",
      externalRevision: "r2",
      dirty: true,
    });
  });

  it("accepts the latest seed after the last clean view released", () => {
    const { registry, models } = makeRegistry();
    const file = registry.acquire({
      identity: mainIdentity,
      viewId: "file",
      seed: { value: "old baseline", revision: "r1" },
      savePolicy: "read-only",
    });
    expect(file.restoreViewState()).toBeNull();
    file.release({ cursor: 7 });

    const reopened = registry.acquire({
      identity: mainIdentity,
      viewId: "file",
      seed: { value: "new baseline", revision: "r2" },
      savePolicy: "read-only",
    });
    expect(reopened.model.getValue()).toBe("new baseline");
    expect(reopened.snapshot()).toMatchObject({
      baseline: "new baseline",
      baselineRevision: "r2",
      externalRevision: "r2",
    });
    expect(models).toHaveLength(2);
  });

  it("evicts a clean entry after its final view and view state are released", () => {
    const { registry } = makeRegistry();
    const file = registry.acquire({
      identity: mainIdentity,
      viewId: "file",
      seed: { value: "baseline", revision: "r1" },
      savePolicy: "read-only",
    });
    file.release({ cursor: 7 });
    expect(entryCount(registry)).toBe(1);

    const reopened = registry.acquire({
      identity: mainIdentity,
      viewId: "file",
      seed: { value: "baseline", revision: "r1" },
      savePolicy: "read-only",
    });
    reopened.release(null);

    expect(entryCount(registry)).toBe(0);

    const reseeded = registry.acquire({
      identity: mainIdentity,
      viewId: "file",
      seed: { value: "fresh baseline", revision: "r2" },
      savePolicy: "read-only",
    });
    expect(reseeded.model.getValue()).toBe("fresh baseline");
    expect(reseeded.snapshot().baselineRevision).toBe("r2");
  });

  it("allows a clean inactive document to adopt a new save policy", () => {
    const { registry } = makeRegistry();
    const preview = registry.acquire({
      identity: mainIdentity,
      viewId: "preview",
      seed: { value: "baseline", revision: "r1" },
      savePolicy: "read-only",
    });
    preview.release({ cursor: 7 });

    const editable = registry.acquire({
      identity: mainIdentity,
      viewId: "editor",
      seed: { value: "baseline", revision: "r1" },
      savePolicy: "explicit",
    });
    expect(editable.snapshot().savePolicy).toBe("explicit");
  });

  it("adopts a new baseline into every clean shared view without becoming dirty", () => {
    const { registry } = makeRegistry();
    const file = registry.acquire({
      identity: mainIdentity,
      viewId: "file",
      seed: { value: "baseline", revision: "r1" },
      savePolicy: "read-only",
    });
    const second = registry.acquire({
      identity: mainIdentity,
      viewId: "second-file",
      seed: { value: "baseline", revision: "r1" },
      savePolicy: "read-only",
    });

    expect(file.adoptCleanBaseline({ value: "agent update", revision: "r2" })).toBe("adopted");
    expect(second.model.getValue()).toBe("agent update");
    expect(second.snapshot()).toMatchObject({
      baseline: "agent update",
      baselineRevision: "r2",
      externalRevision: "r2",
      dirty: false,
    });
  });

  it("records the latest external revision without overwriting a dirty draft", () => {
    const { registry } = makeRegistry();
    const file = registry.acquire({
      identity: mainIdentity,
      viewId: "file",
      seed: { value: "baseline", revision: "r1" },
      savePolicy: "explicit",
    });
    file.model.setValue("human draft");

    expect(file.adoptCleanBaseline({ value: "agent update", revision: "r2" })).toBe("dirty");
    expect(file.model.getValue()).toBe("human draft");
    expect(file.snapshot()).toMatchObject({
      baseline: "baseline",
      baselineRevision: "r1",
      externalRevision: "r2",
      dirty: true,
    });
  });

  it("marks a zero-view dirty model saved and disposes it once clean", () => {
    const { registry } = makeRegistry();
    const file = registry.acquire({
      identity: mainIdentity,
      viewId: "file",
      seed: { value: "baseline", revision: "r1" },
      savePolicy: "explicit",
    });
    const model = file.model as FakeModel;
    model.setValue("saved draft");
    file.release();

    file.markSaved("r2");

    expect(file.snapshot()).toMatchObject({
      baseline: "saved draft",
      baselineRevision: "r2",
      externalRevision: "r2",
      dirty: false,
      viewReferences: 0,
    });
    expect(model.dispose).toHaveBeenCalledTimes(1);

    // A late duplicate completion sees the already-disposed model and retains
    // the saved baseline rather than replacing it with an absent model value.
    file.markSaved("r3");
    expect(file.snapshot().baseline).toBe("saved draft");
  });

  it("can mark or discard an active clean model without disposing it", () => {
    const { registry } = makeRegistry();
    const file = registry.acquire({
      identity: mainIdentity,
      viewId: "file",
      seed: { value: "baseline", revision: "r1" },
      savePolicy: "explicit",
    });
    const model = file.model as FakeModel;

    file.markSaved("r2");
    file.discard();
    expect(file.snapshot()).toMatchObject({ dirty: false, baselineRevision: "r2" });
    expect(model.dispose).not.toHaveBeenCalled();
  });

  it("discards a zero-view dirty draft back to its baseline before disposal", () => {
    const { registry } = makeRegistry();
    const file = registry.acquire({
      identity: mainIdentity,
      viewId: "file",
      seed: { value: "baseline", revision: "r1" },
      savePolicy: "explicit",
    });
    const model = file.model as FakeModel;
    model.setValue("throw this away");
    file.release();

    file.discard();

    expect(model.getValue()).toBe("baseline");
    expect(file.snapshot().dirty).toBe(false);
    expect(model.dispose).toHaveBeenCalledTimes(1);
  });

  it("can explicitly forget saved state for one view", () => {
    const { registry } = makeRegistry();
    const file = registry.acquire({
      identity: mainIdentity,
      viewId: "file",
      seed: { value: "baseline", revision: "r1" },
      savePolicy: "read-only",
    });
    file.release({ cursor: 7 });

    const reopened = registry.acquire({
      identity: mainIdentity,
      viewId: "file",
      seed: { value: "baseline", revision: "r1" },
      savePolicy: "read-only",
    });
    expect(reopened.restoreViewState()).toEqual({ cursor: 7 });
    reopened.release(null);

    const withoutState = registry.acquire({
      identity: mainIdentity,
      viewId: "file",
      seed: { value: "baseline", revision: "r1" },
      savePolicy: "read-only",
    });
    expect(withoutState.restoreViewState()).toBeNull();
  });

  it("does not rewrite a model when adopting its existing clean baseline", () => {
    const { registry } = makeRegistry();
    const file = registry.acquire({
      identity: mainIdentity,
      viewId: "file",
      seed: { value: "baseline", revision: "r1" },
      savePolicy: "read-only",
    });
    const model = file.model as FakeModel;
    const setValue = vi.spyOn(model, "setValue");

    expect(file.adoptCleanBaseline({ value: "baseline", revision: "r2" })).toBe("adopted");
    expect(setValue).not.toHaveBeenCalled();
  });
});
