import {
  detectDocumentLanguage,
  documentIdentityKey,
  documentUri,
  type DocumentIdentity,
} from "./document-identity";

export type DocumentRevision = string | number | null;
export type DocumentSavePolicy = "read-only" | "explicit" | "autosave";

export interface RegistryModel {
  getValue(): string;
  setValue(value: string): void;
  onDidChangeContent(listener: () => void): { dispose(): void };
  dispose(): void;
}

export interface RegistryModelFactory<Model extends RegistryModel> {
  createModel(input: { value: string; language: string; uri: string }): Model;
}

export interface DocumentSeed {
  value: string;
  revision: DocumentRevision;
}

export interface DocumentSnapshot {
  identity: DocumentIdentity;
  uri: string;
  language: string;
  baseline: string;
  baselineRevision: DocumentRevision;
  externalRevision: DocumentRevision;
  dirty: boolean;
  savePolicy: DocumentSavePolicy;
  viewReferences: number;
}

interface DocumentEntry<Model extends RegistryModel, ViewState> extends DocumentSnapshot {
  model: Model | null;
  changeSubscription: { dispose(): void } | null;
  applyingBaseline: boolean;
  readonly references: Set<symbol>;
  readonly viewStates: Map<string, ViewState>;
}

/**
 * A lease-free handle on a document the registry ALREADY holds — the seam a
 * workbench needs to save or discard a tab it is about to close. It has to be
 * lease-free because a dirty document deliberately outlives its last view
 * (`cleanupReleasedEntry` keeps it), so the tab whose draft needs rescuing is
 * usually the one whose editor is no longer mounted. `peek` never CREATES an
 * entry, so it can neither resurrect a closed document nor seed a baseline it
 * doesn't know.
 */
export interface DocumentHandle<Model extends RegistryModel> {
  /** The live model, or `null` if the document is parked without one (clean, viewless). */
  readonly model: Model | null;
  snapshot(): DocumentSnapshot;
  discard(): void;
  markSaved(revision: DocumentRevision): void;
}

export interface DocumentLease<Model extends RegistryModel, ViewState> {
  readonly model: Model;
  snapshot(): DocumentSnapshot;
  restoreViewState(): ViewState | null;
  adoptCleanBaseline(seed: DocumentSeed): "adopted" | "dirty";
  markSaved(revision: DocumentRevision): void;
  discard(): void;
  release(viewState?: ViewState | null): void;
}

export class DocumentRegistry<Model extends RegistryModel, ViewState> {
  private readonly entries = new Map<string, DocumentEntry<Model, ViewState>>();

  constructor(private readonly factory: RegistryModelFactory<Model>) {}

  acquire(input: {
    identity: DocumentIdentity;
    viewId: string;
    seed: DocumentSeed;
    savePolicy: DocumentSavePolicy;
  }): DocumentLease<Model, ViewState> {
    const key = documentIdentityKey(input.identity);
    let entry = this.entries.get(key);
    if (entry === undefined) {
      const uri = documentUri(input.identity);
      const language = detectDocumentLanguage(input.identity);
      entry = {
        identity: input.identity,
        uri,
        language,
        baseline: input.seed.value,
        baselineRevision: input.seed.revision,
        externalRevision: input.seed.revision,
        dirty: false,
        savePolicy: input.savePolicy,
        viewReferences: 0,
        model: null,
        changeSubscription: null,
        applyingBaseline: false,
        references: new Set(),
        viewStates: new Map(),
      };
      this.entries.set(key, entry);
    } else {
      if (entry.savePolicy !== input.savePolicy) {
        if (entry.references.size > 0 || entry.dirty) {
          throw new Error(`Document ${key} was acquired with a different save policy`);
        }
        entry.savePolicy = input.savePolicy;
      }
      const sameSeed =
        entry.baseline === input.seed.value &&
        Object.is(entry.baselineRevision, input.seed.revision);
      if (!sameSeed) {
        if (entry.references.size > 0) {
          throw new Error(`Document ${key} was acquired with a different seed`);
        }
        if (entry.dirty) {
          entry.externalRevision = input.seed.revision;
        } else {
          entry.baseline = input.seed.value;
          entry.baselineRevision = input.seed.revision;
          entry.externalRevision = input.seed.revision;
        }
      }
    }

    const reference = Symbol(input.viewId);
    const model = this.ensureModel(entry);
    entry.references.add(reference);
    entry.viewReferences = entry.references.size;
    let released = false;
    return {
      model,
      snapshot: () => this.snapshot(entry),
      restoreViewState: () => {
        const state = entry.viewStates.get(input.viewId);
        return state === undefined ? null : structuredClone(state);
      },
      adoptCleanBaseline: (seed) => this.adoptCleanBaseline(entry, seed),
      markSaved: (revision) => this.markEntrySaved(key, entry, revision),
      discard: () => this.discardEntry(key, entry),
      release: (viewState?: ViewState | null) => {
        if (released) return;
        released = true;
        if (viewState === null) {
          entry.viewStates.delete(input.viewId);
        } else if (viewState !== undefined) {
          entry.viewStates.set(input.viewId, structuredClone(viewState));
        }
        entry.references.delete(reference);
        entry.viewReferences = entry.references.size;
        this.cleanupReleasedEntry(key, entry);
      },
    };
  }

  /**
   * A handle on an already-open document, or `null` when this registry has
   * never opened it (or has already cleaned it up).
   */
  peek(identity: DocumentIdentity): DocumentHandle<Model> | null {
    const key = documentIdentityKey(identity);
    const entry = this.entries.get(key);
    if (entry === undefined) return null;
    return {
      get model() {
        return entry.model;
      },
      snapshot: () => this.snapshot(entry),
      discard: () => this.discardEntry(key, entry),
      markSaved: (revision) => this.markEntrySaved(key, entry, revision),
    };
  }

  private markEntrySaved(
    key: string,
    entry: DocumentEntry<Model, ViewState>,
    revision: DocumentRevision,
  ): void {
    entry.baseline = entry.model?.getValue() ?? entry.baseline;
    entry.baselineRevision = revision;
    entry.externalRevision = revision;
    entry.dirty = false;
    this.cleanupReleasedEntry(key, entry);
  }

  private discardEntry(key: string, entry: DocumentEntry<Model, ViewState>): void {
    entry.applyingBaseline = true;
    try {
      if (entry.model !== null && entry.model.getValue() !== entry.baseline) {
        entry.model.setValue(entry.baseline);
      }
      entry.dirty = false;
    } finally {
      entry.applyingBaseline = false;
    }
    this.cleanupReleasedEntry(key, entry);
  }

  private adoptCleanBaseline(
    entry: DocumentEntry<Model, ViewState>,
    seed: DocumentSeed,
  ): "adopted" | "dirty" {
    entry.externalRevision = seed.revision;
    if (entry.dirty) return "dirty";

    entry.applyingBaseline = true;
    try {
      entry.baseline = seed.value;
      entry.baselineRevision = seed.revision;
      entry.dirty = false;
      if (entry.model !== null && entry.model.getValue() !== seed.value) {
        entry.model.setValue(seed.value);
      }
    } finally {
      entry.applyingBaseline = false;
    }
    return "adopted";
  }

  private ensureModel(entry: DocumentEntry<Model, ViewState>): Model {
    if (entry.model !== null) return entry.model;
    const model = this.factory.createModel({
      value: entry.baseline,
      language: entry.language,
      uri: entry.uri,
    });
    entry.model = model;
    entry.changeSubscription = model.onDidChangeContent(() => {
      if (!entry.applyingBaseline) {
        entry.dirty = model.getValue() !== entry.baseline;
      }
    });
    return model;
  }

  private disposeModel(entry: DocumentEntry<Model, ViewState>): void {
    entry.changeSubscription?.dispose();
    entry.changeSubscription = null;
    entry.model?.dispose();
    entry.model = null;
  }

  private cleanupReleasedEntry(key: string, entry: DocumentEntry<Model, ViewState>): void {
    if (entry.references.size > 0 || entry.dirty) return;
    this.disposeModel(entry);
    if (entry.viewStates.size === 0 && this.entries.get(key) === entry) {
      this.entries.delete(key);
    }
  }

  private snapshot(entry: DocumentEntry<Model, ViewState>): DocumentSnapshot {
    return {
      identity: entry.identity,
      uri: entry.uri,
      language: entry.language,
      baseline: entry.baseline,
      baselineRevision: entry.baselineRevision,
      externalRevision: entry.externalRevision,
      dirty: entry.dirty,
      savePolicy: entry.savePolicy,
      viewReferences: entry.references.size,
    };
  }
}
