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
  /**
   * The current value's length, when the model can answer that without building
   * the value. Optional so a fake (or a future non-Monaco model) need not have
   * one; {@link DocumentRegistry} falls back to a full comparison.
   */
  getValueLength?(): number;
  setValue(value: string): void;
  onDidChangeContent(listener: () => void): { dispose(): void };
  dispose(): void;
}

export interface RegistryModelFactory<Model extends RegistryModel, ViewState> {
  createModel(input: { value: string; language: string; uri: string }): Model;
  /** Mutate an existing live model without resetting its editor/undo state. */
  applyExternalEdit(model: Model, value: string): void;
  /**
   * Carry a serialized, view-owned position through an external edit before a
   * clean model reset clears its stale undo history. Text inputs keep this
   * available after the warm model has been evicted. Optional because the
   * registry itself does not know a ViewState's shape.
   */
  mapViewStateThroughExternalEdit?(
    oldValue: string,
    viewState: ViewState,
    value: string,
  ): ViewState;
}

export interface DocumentSeed {
  value: string;
  revision: DocumentRevision;
}

export interface DocumentExternalUpdate {
  /** The newly-read disk value that becomes the synchronized baseline. */
  baseline: string;
  /** The resulting live model value after reconciliation. */
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
  readonly viewStates: Map<string, RetainedViewState<ViewState>>;
}

interface RetainedViewState<ViewState> {
  /** Serialized positions are only meaningful against the text they were captured from. */
  readonly state: ViewState;
  readonly basisValue: string;
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
  applyExternalUpdate(update: DocumentExternalUpdate): void;
  adoptCleanBaseline(seed: DocumentSeed): "adopted" | "dirty";
  markSaved(revision: DocumentRevision): void;
  discard(): void;
  release(viewState?: ViewState | null): void;
}

/**
 * How many COLD documents the registry keeps before evicting the least recently
 * used (issue #133). A cold entry has no live view and no unsaved draft — what
 * is left is the remembered cursor/scroll of a view that has gone, plus the
 * baseline text held to compare against. That is a bounded convenience, not
 * state anyone can lose work to: every editor falls back to the host-persisted
 * view state (issue #109) when the registry has nothing, and the baseline is
 * re-seeded from a fresh read on the next `acquire`. Without a cap the baseline
 * of every file opened in a session is retained for the life of the process.
 */
const DEFAULT_COLD_DOCUMENT_LIMIT = 24;

/**
 * How many of those cold documents keep their MODEL — and with it the user's
 * undo/redo history, which in Monaco lives on the model and nowhere else.
 *
 * This cap exists separately from the cold one because the two things cost
 * wildly different amounts. A remembered cursor is a few numbers; a model is the
 * file's text in a piece tree plus its tokenization state, so keeping every cold
 * document's model would tie the process's memory to how many files a session
 * has ever visited. Smaller than the cold cap, and deliberately larger than the
 * handful of files someone alternates between while writing code: dropping a
 * model is not data loss, but it does silently empty ⌘Z for that file, which is
 * exactly what parking used to do to EVERY file on every tab switch.
 */
const DEFAULT_WARM_DOCUMENT_LIMIT = 8;

export class DocumentRegistry<Model extends RegistryModel, ViewState> {
  private readonly entries = new Map<string, DocumentEntry<Model, ViewState>>();
  /**
   * The parked entries, least-recently-used first (insertion order). Membership
   * is exactly the parked set: `acquire` removes a key the moment a view takes
   * it back, and only `cleanupReleasedEntry` — which has just proven the entry
   * viewless and clean — puts one in.
   *
   * A map rather than a set of keys so ageing never has to look an entry back up
   * and handle a miss it cannot actually have: the two collections would then be
   * able to disagree, and the code to survive that would be untestable because
   * nothing can produce it.
   */
  private readonly cold = new Map<string, DocumentEntry<Model, ViewState>>();
  /** Hosts watching the unsaved set, so a quit can be stopped before it lands. */
  private readonly unsavedListeners = new Set<() => void>();

  constructor(
    private readonly factory: RegistryModelFactory<Model, ViewState>,
    private readonly coldLimit: number = DEFAULT_COLD_DOCUMENT_LIMIT,
    private readonly warmLimit: number = DEFAULT_WARM_DOCUMENT_LIMIT,
  ) {}

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
        // A parked entry keeps its MODEL, so a fresh disk seed has to reach the
        // model and not just the bookkeeping: leaving the two disagreeing would
        // hand the next view a buffer full of the file's old text under a
        // baseline that says otherwise, and the mount reconcile would then read
        // that stale text as the user's own unsaved draft. `adoptCleanBaseline`
        // refreshes the clean model and leaves a dirty draft alone, recording
        // only the newer external revision.
        this.adoptCleanBaseline(entry, input.seed);
      }
    }

    // Live again: no longer a candidate for cold eviction, and its next stint in
    // the cold set starts at the back of the queue.
    this.cold.delete(key);

    const reference = Symbol(input.viewId);
    const model = this.ensureModel(entry);
    entry.references.add(reference);
    entry.viewReferences = entry.references.size;
    let released = false;
    return {
      model,
      snapshot: () => this.snapshot(entry),
      restoreViewState: () => {
        const retained = entry.viewStates.get(input.viewId);
        if (retained === undefined) return null;
        const currentValue = entry.model?.getValue() ?? entry.baseline;
        const mapper = this.factory.mapViewStateThroughExternalEdit;
        if (retained.basisValue === currentValue || mapper === undefined) {
          return structuredClone(retained.state);
        }
        // Shared-model edits need no registry transaction, so catch any state
        // they made stale when its view eventually returns.
        const mapped = mapper(retained.basisValue, structuredClone(retained.state), currentValue);
        entry.viewStates.set(input.viewId, { state: mapped, basisValue: currentValue });
        return structuredClone(mapped);
      },
      applyExternalUpdate: (update) => this.applyExternalUpdate(entry, update),
      adoptCleanBaseline: (seed) => this.adoptCleanBaseline(entry, seed),
      markSaved: (revision) => this.markEntrySaved(key, entry, revision),
      discard: () => this.discardEntry(key, entry),
      release: (viewState?: ViewState | null) => {
        if (released) return;
        released = true;
        if (viewState === null) {
          entry.viewStates.delete(input.viewId);
        } else if (viewState !== undefined) {
          entry.viewStates.set(input.viewId, {
            state: structuredClone(viewState),
            basisValue: model.getValue(),
          });
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

  /**
   * Every open document currently holding an unsaved draft. The authority a
   * host reports to main's quit gate from — the same flag the editors show, so
   * the dot on a tab and the question ⌘Q asks can never disagree.
   */
  unsavedDocuments(): DocumentIdentity[] {
    const unsaved: DocumentIdentity[] = [];
    for (const entry of this.entries.values()) {
      if (entry.dirty) unsaved.push(entry.identity);
    }
    return unsaved;
  }

  /** Fires whenever {@link unsavedDocuments} would answer differently. */
  observeUnsaved(listener: () => void): { dispose(): void } {
    this.unsavedListeners.add(listener);
    return { dispose: () => this.unsavedListeners.delete(listener) };
  }

  /**
   * The ONE place `dirty` moves, so the unsaved set cannot change without the
   * hosts watching it hearing about it. Silent on a no-op transition: typing
   * fires a content change per keystroke and all but the first say the same
   * thing.
   */
  private setDirty(entry: DocumentEntry<Model, ViewState>, dirty: boolean): void {
    if (entry.dirty === dirty) return;
    entry.dirty = dirty;
    for (const listener of this.unsavedListeners) listener();
  }

  /**
   * Recomputes `dirty` from the live model against the baseline.
   *
   * The length probe first is not a micro-optimization: this runs on EVERY
   * keystroke, and `getValue()` rebuilds the file's whole text out of Monaco's
   * piece tree each time it is called, so the naive comparison charges typing a
   * cost proportional to the file. A differing length is already proof the
   * content differs — and typing changes the length nearly every time — so the
   * common case never materializes the buffer at all. Equal lengths still fall
   * through to the exact comparison, which is what keeps "undo back to the
   * saved text" clearing the dirty flag.
   */
  private recomputeDirty(entry: DocumentEntry<Model, ViewState>, model: Model): void {
    const length = model.getValueLength?.();
    if (length !== undefined && length !== entry.baseline.length) {
      this.setDirty(entry, true);
      return;
    }
    this.setDirty(entry, model.getValue() !== entry.baseline);
  }

  private markEntrySaved(
    key: string,
    entry: DocumentEntry<Model, ViewState>,
    revision: DocumentRevision,
  ): void {
    entry.baseline = entry.model?.getValue() ?? entry.baseline;
    entry.baselineRevision = revision;
    entry.externalRevision = revision;
    this.setDirty(entry, false);
    this.cleanupReleasedEntry(key, entry);
  }

  private discardEntry(key: string, entry: DocumentEntry<Model, ViewState>): void {
    entry.applyingBaseline = true;
    try {
      if (entry.model !== null && entry.model.getValue() !== entry.baseline) {
        // Through the edit stack, not `setValue`: Discard is the one action in
        // the app whose whole purpose is to destroy the user's work, so it is
        // the last one that should also destroy their ability to take it back.
        // A parked model keeps its history, which makes reopening the file and
        // pressing ⌘Z a real recovery from a misclicked Discard.
        this.factory.applyExternalEdit(entry.model, entry.baseline);
      }
      this.setDirty(entry, false);
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
      const model = entry.model;
      const modelNeedsUpdate = model !== null && model.getValue() !== seed.value;
      const mappedViewStates = this.mapRetainedViewStates(entry, seed.value);
      entry.baseline = seed.value;
      entry.baselineRevision = seed.revision;
      this.setDirty(entry, false);
      if (modelNeedsUpdate) {
        // This seed is the clean disk baseline, not a user edit. Putting it on
        // Monaco's undo stack lets ⌘Z turn stale bytes into a dirty draft, and a
        // following save can then overwrite the external write. A clean
        // re-seed deliberately resets the old history with the model value.
        model.setValue(seed.value);
      }
      this.commitMappedViewStates(entry, mappedViewStates);
    } finally {
      entry.applyingBaseline = false;
    }
    return "adopted";
  }

  private applyExternalUpdate(
    entry: DocumentEntry<Model, ViewState>,
    update: DocumentExternalUpdate,
  ): void {
    entry.applyingBaseline = true;
    try {
      const mappedViewStates = this.mapRetainedViewStates(entry, update.value);
      entry.baseline = update.baseline;
      entry.baselineRevision = update.revision;
      entry.externalRevision = update.revision;
      if (entry.model !== null && entry.model.getValue() !== update.value) {
        this.factory.applyExternalEdit(entry.model, update.value);
      }
      this.commitMappedViewStates(entry, mappedViewStates);
      this.setDirty(entry, update.value !== update.baseline);
    } finally {
      entry.applyingBaseline = false;
    }
  }

  private mapRetainedViewStates(
    entry: DocumentEntry<Model, ViewState>,
    value: string,
  ): Map<string, RetainedViewState<ViewState>> | null {
    const mapper = this.factory.mapViewStateThroughExternalEdit;
    if (mapper === undefined) return null;
    // Prepare every mapping before the model transaction. A mapper failure then
    // leaves all retained states in their original, truthful coordinate space.
    let mapped: Map<string, RetainedViewState<ViewState>> | null = null;
    for (const [viewId, retained] of entry.viewStates) {
      if (retained.basisValue === value) continue;
      mapped ??= new Map(entry.viewStates);
      mapped.set(viewId, {
        state: mapper(retained.basisValue, structuredClone(retained.state), value),
        basisValue: value,
      });
    }
    return mapped;
  }

  private commitMappedViewStates(
    entry: DocumentEntry<Model, ViewState>,
    mapped: Map<string, RetainedViewState<ViewState>> | null,
  ): void {
    if (mapped === null) return;
    entry.viewStates.clear();
    for (const [viewId, retained] of mapped) entry.viewStates.set(viewId, retained);
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
      if (!entry.applyingBaseline) this.recomputeDirty(entry, model);
    });
    return model;
  }

  private disposeModel(entry: DocumentEntry<Model, ViewState>): void {
    entry.changeSubscription?.dispose();
    entry.changeSubscription = null;
    entry.model?.dispose();
    entry.model = null;
  }

  /**
   * A viewless, clean entry is PARKED, not torn down.
   *
   * It used to be torn down: the model was disposed the moment its last view
   * released, which is every tab switch and every walk out of Project Files and
   * back. Monaco keeps undo/redo on the model, so coming back to a file the user
   * had been editing handed them a buffer with an empty ⌘Z stack — their own
   * edits from a minute earlier were unreachable, and a ⌘S made that permanent.
   * Parking keeps the model (and its history) reachable for the next `acquire`,
   * under the caps enforced below.
   */
  private cleanupReleasedEntry(key: string, entry: DocumentEntry<Model, ViewState>): void {
    if (entry.references.size > 0 || entry.dirty) return;
    if (this.entries.get(key) !== entry) {
      // Superseded and already unreachable — nothing will ever acquire this
      // again, so its model has no history worth keeping.
      this.disposeModel(entry);
      return;
    }
    this.cold.delete(key);
    this.cold.set(key, entry); // most recently used, at the back of the queue
    this.enforceRetentionLimits();
  }

  /**
   * Ages the parked set out, oldest first: past {@link DEFAULT_WARM_DOCUMENT_LIMIT}
   * an entry gives up its model (undo history goes, the remembered cursor and
   * baseline stay), and past {@link DEFAULT_COLD_DOCUMENT_LIMIT} the entry goes
   * entirely. Disposal is unconditional on the way out — a parked model is live
   * in Monaco's own registry until someone disposes it, so dropping the entry
   * without disposing would leak one per file the session ever opened.
   */
  private enforceRetentionLimits(): void {
    const parked = [...this.cold];
    for (const [index, [key, entry]] of parked.entries()) {
      const remaining = parked.length - index;
      if (remaining > this.coldLimit) {
        this.disposeModel(entry);
        this.cold.delete(key);
        this.entries.delete(key);
        continue;
      }
      if (remaining > this.warmLimit) this.disposeModel(entry);
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
