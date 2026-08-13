import { describe, expect, it, vi } from "vite-plus/test";

import type { DocumentIdentity } from "./document-identity";
import {
  DocumentRegistry,
  type RegistryModel,
  type RegistryModelFactory,
} from "./document-registry";

/**
 * Mirrors the one Monaco distinction this registry depends on: `setValue`
 * replaces the buffer and drops its undo history, while an edit pushed onto the
 * stack keeps it. `applyExternalEdit` must be the second kind, or an agent write
 * would silently cost the user every ⌘Z they had banked.
 */
class FakeModel implements RegistryModel {
  private value: string;
  private readonly undoStack: string[] = [];
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

  /** Monaco can answer this without materializing the buffer; so can this fake. */
  getValueLength(): number {
    return this.value.length;
  }

  setValue(value: string): void {
    this.undoStack.length = 0;
    this.value = value;
    for (const listener of this.listeners) listener();
  }

  /** An undoable edit — what typing and what an external write both go through. */
  applyEdit(value: string): void {
    this.undoStack.push(this.value);
    this.value = value;
    for (const listener of this.listeners) listener();
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  onDidChangeContent(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }
}

function makeRegistry(coldLimit?: number, warmLimit?: number) {
  const models: FakeModel[] = [];
  const factory: RegistryModelFactory<FakeModel> = {
    createModel({ value, language, uri }) {
      const model = new FakeModel(value, language, uri);
      models.push(model);
      return model;
    },
    applyExternalEdit(model, value) {
      model.applyEdit(value);
    },
  };
  return {
    registry: new DocumentRegistry<FakeModel, { cursor: number }>(factory, coldLimit, warmLimit),
    models,
  };
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

  it("parks a clean model on its final view release instead of disposing it", () => {
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

    // The last view goes and the model stays: it carries the undo history the
    // user comes back to. Only the retention caps ever dispose it.
    second.release();
    second.release();
    expect(model.dispose).not.toHaveBeenCalled();
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

  /**
   * The tab-switch round trip: leave a file, come back, and keep every ⌘Z. The
   * parked model is reused rather than rebuilt, so the history is still there.
   */
  it("hands a reopened document its parked model, undo history intact", () => {
    const { registry, models } = makeRegistry();
    const file = registry.acquire({
      identity: mainIdentity,
      viewId: "file",
      seed: { value: "print('hi')\n", revision: "r1" },
      savePolicy: "explicit",
    });
    file.model.applyEdit("print('hello')\n");
    file.markSaved("r2");
    file.release({ cursor: 7 });

    const reopened = registry.acquire({
      identity: mainIdentity,
      viewId: "file",
      seed: { value: "print('hello')\n", revision: "r2" },
      savePolicy: "explicit",
    });

    expect(models).toHaveLength(1);
    expect(reopened.model).toBe(file.model);
    expect(reopened.model.canUndo()).toBe(true);
  });

  it("lands a newer seed on the parked model as an undoable edit", () => {
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

    // The model the view gets back must hold what disk holds, or the mount
    // reconcile would read the stale text as a draft the user never wrote.
    expect(reopened.model.getValue()).toBe("new baseline");
    expect(reopened.snapshot()).toMatchObject({
      baseline: "new baseline",
      baselineRevision: "r2",
      externalRevision: "r2",
      dirty: false,
    });
    expect(models).toHaveLength(1);
  });

  it("parks a clean entry even when its view kept no state to remember", () => {
    const { registry } = makeRegistry();
    const file = registry.acquire({
      identity: mainIdentity,
      viewId: "file",
      seed: { value: "baseline", revision: "r1" },
      savePolicy: "read-only",
    });
    file.release(null);

    // No cursor worth remembering is not the same as no history worth keeping.
    expect(entryCount(registry)).toBe(1);

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

  it("applies one clean external update transaction to baseline, revision, and live model", () => {
    const { registry } = makeRegistry();
    const file = registry.acquire({
      identity: mainIdentity,
      viewId: "file",
      seed: { value: "baseline", revision: "r1" },
      savePolicy: "explicit",
    });

    file.applyExternalUpdate({
      baseline: "agent update",
      value: "agent update",
      revision: "r2",
    });

    expect(file.model.getValue()).toBe("agent update");
    expect(file.snapshot()).toMatchObject({
      baseline: "agent update",
      baselineRevision: "r2",
      externalRevision: "r2",
      dirty: false,
    });
  });

  it("records a clean external revision without rewriting an already-current model", () => {
    const { registry } = makeRegistry();
    const file = registry.acquire({
      identity: mainIdentity,
      viewId: "file",
      seed: { value: "agent update", revision: "r1" },
      savePolicy: "explicit",
    });
    const setValue = vi.spyOn(file.model, "setValue");

    file.applyExternalUpdate({
      baseline: "agent update",
      value: "agent update",
      revision: "r2",
    });

    expect(setValue).not.toHaveBeenCalled();
    expect(file.snapshot()).toMatchObject({
      baseline: "agent update",
      baselineRevision: "r2",
      externalRevision: "r2",
      dirty: false,
    });
  });

  it("lands a merge into a dirty draft as an undoable edit that stays dirty", () => {
    // The A/L/D merge case: disk moved on, the draft is still unsaved, and the
    // reconciled value is neither. The draft's own undo history has to survive —
    // it is the only way back from an agent write the user did not want.
    const { registry } = makeRegistry();
    const file = registry.acquire({
      identity: mainIdentity,
      viewId: "file",
      seed: { value: "first\nkeep\nlast\n", revision: "r1" },
      savePolicy: "explicit",
    });
    const model = file.model as FakeModel;
    model.applyEdit("human first\nkeep\nlast\n");
    const setValue = vi.spyOn(model, "setValue");

    file.applyExternalUpdate({
      baseline: "first\nkeep\nagent last\n",
      value: "human first\nkeep\nagent last\n",
      revision: "r2",
    });

    expect(model.getValue()).toBe("human first\nkeep\nagent last\n");
    expect(file.snapshot()).toMatchObject({
      baseline: "first\nkeep\nagent last\n",
      baselineRevision: "r2",
      externalRevision: "r2",
      dirty: true,
    });
    expect(setValue).not.toHaveBeenCalled();
    expect(model.canUndo()).toBe(true);
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

  it("marks a zero-view dirty model saved and parks it once clean", () => {
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
    expect(model.dispose).not.toHaveBeenCalled();

    // A late duplicate completion re-reads the parked model, which still holds
    // exactly the saved bytes, so the baseline is unchanged either way.
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

  it("discards a zero-view dirty draft back to its baseline, undoably", () => {
    const { registry } = makeRegistry();
    const file = registry.acquire({
      identity: mainIdentity,
      viewId: "file",
      seed: { value: "baseline", revision: "r1" },
      savePolicy: "explicit",
    });
    const model = file.model as FakeModel;
    model.applyEdit("throw this away");
    file.release();

    file.discard();

    expect(model.getValue()).toBe("baseline");
    expect(file.snapshot().dirty).toBe(false);
    // Discard exists to destroy work, which is exactly why it must not also
    // destroy the ⌘Z that takes a misclick back.
    expect(model.canUndo()).toBe(true);
    expect(model.dispose).not.toHaveBeenCalled();
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
    const applyEdit = vi.spyOn(model, "applyEdit");

    expect(file.adoptCleanBaseline({ value: "baseline", revision: "r2" })).toBe("adopted");
    expect(setValue).not.toHaveBeenCalled();
    expect(applyEdit).not.toHaveBeenCalled();
  });

  /**
   * Adoption is the agent-wrote-while-you-watched path. It must reach the model
   * without emptying the history the user still has a right to.
   */
  it("adopts a fresh baseline into a clean model as an undoable edit", () => {
    const { registry } = makeRegistry();
    const file = registry.acquire({
      identity: mainIdentity,
      viewId: "file",
      seed: { value: "def main():\n", revision: "r1" },
      savePolicy: "explicit",
    });
    const model = file.model as FakeModel;
    const setValue = vi.spyOn(model, "setValue");

    file.adoptCleanBaseline({ value: "def main() -> None:\n", revision: "r2" });

    expect(model.getValue()).toBe("def main() -> None:\n");
    expect(setValue).not.toHaveBeenCalled();
    expect(model.canUndo()).toBe(true);
  });

  it("peeks a document that is already open, exposing its live model and dirty flag", () => {
    const { registry } = makeRegistry();
    const view = registry.acquire({
      identity: mainIdentity,
      viewId: "file",
      seed: { value: "baseline", revision: "r1" },
      savePolicy: "explicit",
    });
    view.model.setValue("draft");

    const handle = registry.peek(mainIdentity);

    expect(handle?.snapshot().dirty).toBe(true);
    expect(handle?.snapshot().baselineRevision).toBe("r1");
    expect(handle?.model?.getValue()).toBe("draft");
  });

  it("returns null for a document the registry has never opened", () => {
    const { registry } = makeRegistry();

    expect(registry.peek(mainIdentity)).toBeNull();
  });

  it("peeks a dirty document whose last view has already been released", () => {
    const { registry } = makeRegistry();
    const view = registry.acquire({
      identity: mainIdentity,
      viewId: "file",
      seed: { value: "baseline", revision: "r1" },
      savePolicy: "explicit",
    });
    view.model.setValue("draft");
    view.release();

    const handle = registry.peek(mainIdentity);

    expect(handle?.model?.getValue()).toBe("draft");
    expect(handle?.snapshot().dirty).toBe(true);
  });

  it("discards a viewless dirty draft through the peeked handle, releasing the hold", () => {
    const { registry } = makeRegistry();
    const view = registry.acquire({
      identity: mainIdentity,
      viewId: "file",
      seed: { value: "baseline", revision: "r1" },
      savePolicy: "explicit",
    });
    view.model.setValue("draft");
    view.release();

    registry.peek(mainIdentity)?.discard();

    // The draft no longer pins the entry against the retention caps, and no
    // longer counts as work a quit would destroy.
    expect(registry.peek(mainIdentity)?.snapshot().dirty).toBe(false);
    expect(registry.unsavedDocuments()).toEqual([]);
  });

  it("marks a viewless draft saved through the peeked handle", () => {
    const { registry } = makeRegistry();
    const view = registry.acquire({
      identity: mainIdentity,
      viewId: "file",
      seed: { value: "baseline", revision: "r1" },
      savePolicy: "explicit",
    });
    view.model.setValue("draft");
    view.release();

    registry.peek(mainIdentity)?.markSaved("r2");

    expect(registry.peek(mainIdentity)?.snapshot()).toMatchObject({
      dirty: false,
      baseline: "draft",
      baselineRevision: "r2",
    });
    expect(registry.unsavedDocuments()).toEqual([]);
  });

  it("clears autosave dirty and records the disk mtime after markSaved", () => {
    // Mirrors the Markdown Artifact path: acquire with revision null (or a
    // load mtime), edit, then markSaved(mtime) after FileView autosave so
    // peek().dirty is false and Save-on-close sees a known externalRevision.
    const { registry } = makeRegistry();
    const artifact = registry.acquire({
      identity: {
        kind: "file",
        projectId: "project-1",
        checkout: { kind: "main" },
        relPath: ".volli/artifacts/notes.md",
      },
      viewId: "artifact",
      seed: { value: "hello", revision: 10 },
      savePolicy: "autosave",
    });

    artifact.model.setValue("hello world");
    expect(artifact.snapshot()).toMatchObject({
      dirty: true,
      baseline: "hello",
      externalRevision: 10,
      savePolicy: "autosave",
    });

    artifact.markSaved(11);

    expect(artifact.snapshot()).toMatchObject({
      dirty: false,
      baseline: "hello world",
      baselineRevision: 11,
      externalRevision: 11,
    });
    expect(registry.peek(artifact.snapshot().identity)?.snapshot().dirty).toBe(false);
  });

  it("lets a host flush markSaved via peek after last-view release without discard", () => {
    // React runs child cleanups before parent: MonacoDocumentEditor must not
    // discard() on last-view unmount, or FileView's subsequent flush cannot
    // markSaved via registry.peek after a successful write (lease already null
    // on the editor handle). Park dirty, then clear through peek — the same
    // ordering the unmount flush relies on.
    const { registry } = makeRegistry();
    const identity: DocumentIdentity = {
      kind: "file",
      projectId: "project-1",
      checkout: { kind: "main" },
      relPath: ".volli/artifacts/notes.md",
    };
    const artifact = registry.acquire({
      identity,
      viewId: "artifact",
      seed: { value: "hello", revision: 10 },
      savePolicy: "autosave",
    });
    artifact.model.setValue("hello world");
    // No discard — mirrors the fixed autosave editor cleanup.
    artifact.release();

    const handle = registry.peek(identity);
    expect(handle?.snapshot()).toMatchObject({
      dirty: true,
      baseline: "hello",
      externalRevision: 10,
      viewReferences: 0,
      savePolicy: "autosave",
    });
    expect(handle?.model?.getValue()).toBe("hello world");

    handle?.markSaved(11);

    expect(registry.peek(identity)?.snapshot()).toMatchObject({
      dirty: false,
      baseline: "hello world",
      baselineRevision: 11,
      externalRevision: 11,
    });
    expect(registry.unsavedDocuments()).toEqual([]);
  });
});

// A viewless, clean entry that remembers a cursor is retained — issue #133: it
// must be retained BOUNDEDLY, or a session's worth of baselines never leaves.
describe("DocumentRegistry cold retention", () => {
  const fileIdentity = (relPath: string): DocumentIdentity => ({ ...mainIdentity, relPath });

  /** Opens `relPath`, leaves a cursor behind, and releases it into the cold set. */
  function openAndPark(
    registry: DocumentRegistry<FakeModel, { cursor: number }>,
    relPath: string,
  ): void {
    const view = registry.acquire({
      identity: fileIdentity(relPath),
      viewId: "file",
      seed: { value: `// ${relPath}\n`, revision: 1 },
      savePolicy: "explicit",
    });
    view.release({ cursor: 1 });
  }

  it("evicts the least recently parked document once the cap is exceeded", () => {
    const { registry } = makeRegistry(2);

    openAndPark(registry, "a.ts");
    openAndPark(registry, "b.ts");
    openAndPark(registry, "c.ts");

    expect(entryCount(registry)).toBe(2);
    expect(registry.peek(fileIdentity("a.ts"))).toBeNull();
    expect(registry.peek(fileIdentity("b.ts"))).not.toBeNull();
    expect(registry.peek(fileIdentity("c.ts"))).not.toBeNull();
  });

  it("reopening a parked document makes it the most recent, not the next evicted", () => {
    const { registry } = makeRegistry(2);

    openAndPark(registry, "a.ts");
    openAndPark(registry, "b.ts");
    openAndPark(registry, "a.ts"); // touched: `b.ts` is now the oldest
    openAndPark(registry, "c.ts");

    expect(registry.peek(fileIdentity("b.ts"))).toBeNull();
    expect(registry.peek(fileIdentity("a.ts"))?.snapshot().identity).toEqual(fileIdentity("a.ts"));
    expect(registry.peek(fileIdentity("c.ts"))).not.toBeNull();
  });

  it("evicting a cold entry costs only its view state, and the reopened document re-seeds", () => {
    const { registry } = makeRegistry(1);

    openAndPark(registry, "a.ts");
    openAndPark(registry, "b.ts");

    const reopened = registry.acquire({
      identity: fileIdentity("a.ts"),
      viewId: "file",
      seed: { value: "// a.ts, edited by an agent\n", revision: 2 },
      savePolicy: "explicit",
    });

    expect(reopened.restoreViewState()).toBeNull();
    expect(reopened.model.getValue()).toBe("// a.ts, edited by an agent\n");
    expect(reopened.snapshot().baselineRevision).toBe(2);
  });

  it("never evicts a document that still has a view or an unsaved draft", () => {
    const { registry } = makeRegistry(1);

    const live = registry.acquire({
      identity: fileIdentity("live.ts"),
      viewId: "file",
      seed: { value: "live\n", revision: 1 },
      savePolicy: "explicit",
    });
    const draft = registry.acquire({
      identity: fileIdentity("draft.ts"),
      viewId: "file",
      seed: { value: "draft\n", revision: 1 },
      savePolicy: "explicit",
    });
    draft.model.setValue("unsaved work");
    draft.release({ cursor: 3 });

    // Well past the cap of 1 — none of these may take the draft or the open tab.
    openAndPark(registry, "a.ts");
    openAndPark(registry, "b.ts");
    openAndPark(registry, "c.ts");

    expect(registry.peek(fileIdentity("live.ts"))?.snapshot().viewReferences).toBe(1);
    expect(registry.peek(fileIdentity("draft.ts"))?.model?.getValue()).toBe("unsaved work");
    expect(entryCount(registry)).toBe(3); // live + dirty + one cold survivor

    // Saving the draft returns it to the cold set, where the cap applies again.
    registry.peek(fileIdentity("draft.ts"))?.markSaved(2);
    openAndPark(registry, "d.ts");

    expect(registry.peek(fileIdentity("draft.ts"))).toBeNull();
    live.release(null);
  });

  it("keeps the warm models' undo history and lets the older parked ones go", () => {
    const { registry } = makeRegistry(4, 2);

    openAndPark(registry, "a.py");
    openAndPark(registry, "b.py");
    openAndPark(registry, "c.py");

    // Past the warm cap: `a.py` is still known (cursor, baseline) but its model
    // — and therefore its undo stack — has been let go.
    expect(registry.peek(fileIdentity("a.py"))?.model).toBeNull();
    expect(registry.peek(fileIdentity("b.py"))?.model).not.toBeNull();
    expect(registry.peek(fileIdentity("c.py"))?.model).not.toBeNull();
    expect(entryCount(registry)).toBe(3);
  });

  it("disposes a parked model on the way out rather than leaking it", () => {
    const { registry, models } = makeRegistry(1, 1);

    openAndPark(registry, "a.py");
    openAndPark(registry, "b.py");

    // `a.py` left both caps in one step: the entry is gone AND its model was
    // disposed, or Monaco would hold a live model nothing can ever reach.
    expect(registry.peek(fileIdentity("a.py"))).toBeNull();
    expect(models[0]?.dispose).toHaveBeenCalledTimes(1);
  });
});

describe("DocumentRegistry unsaved reporting", () => {
  const fileIdentity = (relPath: string): DocumentIdentity => ({ ...mainIdentity, relPath });

  it("reports every dirty document and drops each one as it is saved", () => {
    const { registry } = makeRegistry();
    const first = registry.acquire({
      identity: fileIdentity("train.py"),
      viewId: "file",
      seed: { value: "epochs = 1\n", revision: 1 },
      savePolicy: "explicit",
    });
    const second = registry.acquire({
      identity: fileIdentity("model.py"),
      viewId: "file",
      seed: { value: "layers = 2\n", revision: 1 },
      savePolicy: "explicit",
    });

    expect(registry.unsavedDocuments()).toEqual([]);

    first.model.applyEdit("epochs = 30\n");
    second.model.applyEdit("layers = 24\n");
    expect(registry.unsavedDocuments()).toEqual([
      fileIdentity("train.py"),
      fileIdentity("model.py"),
    ]);

    first.markSaved(2);
    expect(registry.unsavedDocuments()).toEqual([fileIdentity("model.py")]);
  });

  /** A parked draft is exactly the one a quit would silently destroy. */
  it("still reports a dirty document whose view has been released", () => {
    const { registry } = makeRegistry();
    const file = registry.acquire({
      identity: fileIdentity("train.py"),
      viewId: "file",
      seed: { value: "epochs = 1\n", revision: 1 },
      savePolicy: "explicit",
    });
    file.model.applyEdit("epochs = 30\n");
    file.release({ cursor: 1 });

    expect(registry.unsavedDocuments()).toEqual([fileIdentity("train.py")]);
  });

  it("notifies observers on each dirty transition and never in between", () => {
    const { registry } = makeRegistry();
    const observed = vi.fn();
    const subscription = registry.observeUnsaved(observed);
    const file = registry.acquire({
      identity: fileIdentity("train.py"),
      viewId: "file",
      seed: { value: "epochs = 1\n", revision: 1 },
      savePolicy: "explicit",
    });

    file.model.applyEdit("epochs = 3\n");
    expect(observed).toHaveBeenCalledTimes(1);

    // Still dirty, just differently — nothing a quit gate needs to hear about.
    file.model.applyEdit("epochs = 30\n");
    file.model.applyEdit("epochs = 300\n");
    expect(observed).toHaveBeenCalledTimes(1);

    file.markSaved(2);
    expect(observed).toHaveBeenCalledTimes(2);

    subscription.dispose();
    file.model.applyEdit("epochs = 3000\n");
    expect(observed).toHaveBeenCalledTimes(2);
  });

  /**
   * Typing runs this per keystroke, and `getValue()` rebuilds the whole file
   * each call, so a differing length has to settle it without one.
   */
  it("decides dirtiness from the model's length before building its value", () => {
    const { registry, models } = makeRegistry();
    const file = registry.acquire({
      identity: fileIdentity("train.py"),
      viewId: "file",
      seed: { value: "epochs = 1\n", revision: 1 },
      savePolicy: "explicit",
    });
    const model = models[0]!;
    const getValue = vi.spyOn(model, "getValue");

    file.model.applyEdit("epochs = 12\n"); // one character longer than the baseline
    expect(getValue).not.toHaveBeenCalled();
    expect(file.snapshot().dirty).toBe(true);

    // Baseline length, different content: only the exact comparison can tell.
    file.model.applyEdit("epochs = 2\n");
    expect(getValue).toHaveBeenCalled();
    expect(file.snapshot().dirty).toBe(true);

    // And only it can bring an edit undone back to the saved text home to clean.
    file.model.applyEdit("epochs = 1\n");
    expect(file.snapshot().dirty).toBe(false);
  });
});
