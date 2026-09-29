import * as React from "react";
import type {
  CompactionPolicy,
  HiddenModelRef,
  ModelAccessDefaults,
  ModelAccessSignInType,
  ModelAccessSignInUpdate,
  ModelAccessSnapshot,
  ModelPickerView,
  ModelPurpose,
  ModelSelection,
} from "@volli/shared";

/**
 * A running sign-in, as its opener holds it.
 *
 * Handed back rather than looked up, because the row that started an attempt is
 * the only thing that acts on it: it is the surface showing the question, so it
 * is the surface that answers and the surface that cancels. Nothing else in the
 * app has a reason to name an attempt id.
 */
export interface ModelAccessSignInSession {
  attemptId: string;
  /** Answers the pending step. The value is a credential for a `secret` prompt. */
  respond(promptId: string, value: string): Promise<void>;
  /** Abandons the attempt; the settled update follows on the same channel. */
  cancel(): Promise<void>;
}

export interface ModelAccessClient {
  inspect(input: { refresh?: boolean }): Promise<ModelAccessSnapshot>;
  /** The per-purpose defaults — see {@link ModelAccessDefaults}. */
  defaults(): Promise<ModelAccessDefaults>;
  /** Null clears a ticket/utility choice back to "use the Board default". */
  setDefault(purpose: ModelPurpose, selection: ModelSelection | null): Promise<ModelAccessDefaults>;
  /** The models the user toggled out of composers and pickers. */
  hiddenModels(): Promise<readonly HiddenModelRef[]>;
  setHiddenModels(hidden: readonly HiddenModelRef[]): Promise<readonly HiddenModelRef[]>;
  /** The automatic-compaction switch. */
  compactionPolicy(): Promise<CompactionPolicy>;
  /** Saves the whole policy — the one global switch. */
  setCompactionPolicy(policy: CompactionPolicy): Promise<CompactionPolicy>;
  /** Which list the model pickers open on (VC-259). */
  pickerView(): Promise<ModelPickerView>;
  setPickerView(view: ModelPickerView): Promise<ModelPickerView>;
  /**
   * Starts a sign-in and routes its updates to `onUpdate`.
   *
   * The listener is taken up front rather than subscribed to afterwards: main
   * mints the id, and a provider that asks for an API key does so before the
   * call that returns the id has resolved. Rejects when the attempt was
   * refused — an unknown provider, a method it does not offer, or one already
   * running — and in that case `onUpdate` is never called.
   */
  beginSignIn(
    providerId: string,
    type: ModelAccessSignInType,
    onUpdate: (update: ModelAccessSignInUpdate) => void,
  ): Promise<ModelAccessSignInSession>;
  /** Deletes the stored credential. Rejects with the reason it could not. */
  signOut(providerId: string): Promise<void>;
}

export interface ModelAccessContextValue extends ModelAccessClient {
  revision: number;
}

const ModelAccessContext = React.createContext<ModelAccessContextValue | null>(null);

/**
 * The answer this call starts, shared with every ask that arrives while it is
 * still out — and dropped by the first settlement, success or failure, so a
 * later caller reads afresh.
 *
 * The two cheap preference reads use this: their next reader may be a mount
 * after a write the renderer never made (the e2e harness seeds a default
 * through the RPC; main repairs visibility as a refresh applies its lists),
 * and nothing about one in-flight read makes a fresh SQLite read expensive.
 */
function coalesceRead<T>(
  slot: { current: Promise<T> | null },
  start: () => Promise<T>,
): Promise<T> {
  const inFlight = slot.current;
  if (inFlight !== null) return inFlight;
  const read = start();
  slot.current = read;
  const forget = (): void => {
    if (slot.current === read) slot.current = null;
  };
  void read.then(forget, forget);
  return read;
}

/**
 * The answer already held for one question, or a fresh one this call starts
 * and holds until an invalidation drops it.
 *
 * The expensive question uses this: the provider sweep costs ~40 probes and
 * as many credential reads, and every mount that asks before the next
 * credential change joins the held promise instead of paying for it again —
 * two composers opening in the same frame ask once, not twice, and a remount
 * asks not at all. A rejection is forgotten rather than held, so a failed
 * read is a read the next mount may retry.
 */
function holdRead<T>(slot: { current: Promise<T> | null }, start: () => Promise<T>): Promise<T> {
  const held = slot.current;
  if (held !== null) return held;
  const read = start();
  slot.current = read;
  void read.catch(() => {
    if (slot.current === read) slot.current = null;
  });
  return read;
}

export function ModelAccessProvider({
  client,
  children,
}: React.PropsWithChildren<{ client: ModelAccessClient }>) {
  const [revision, setRevision] = React.useState(0);
  // What this revision already knows. The chat plane, the rail's run control
  // and every composer ask the same questions, and their hosts remount on
  // every ticket switch and chat tab switch — without the held sweep each of
  // those mounts pays for the whole provider inspection again. The `client`
  // is stable for the life of the provider (`DesktopModelAccessProvider`
  // memoizes it once), so these refs never name another store's answers.
  const inspectRead = React.useRef<Promise<ModelAccessSnapshot> | null>(null);
  const defaultsRead = React.useRef<Promise<ModelAccessDefaults> | null>(null);
  const hiddenRead = React.useRef<Promise<readonly HiddenModelRef[]> | null>(null);
  // Minted by every invalidation. A Refresh that lands after one was overtaken
  // — a sign-out landed while it ran — must not put its older answer back, and
  // this is how it can tell.
  const generation = React.useRef(0);

  const value = React.useMemo<ModelAccessContextValue>(() => {
    /** Drop everything held and wake every surface that reads it. */
    const invalidate = (): void => {
      generation.current += 1;
      inspectRead.current = null;
      defaultsRead.current = null;
      hiddenRead.current = null;
      setRevision((current) => current + 1);
    };
    return {
      inspect: (input) => {
        if (input.refresh !== true) {
          return holdRead(inspectRead, () => client.inspect({ refresh: false }));
        }
        // A person pressed Refresh: go to the providers regardless of what is
        // held, and let the answer replace it. The revision bump is what
        // reaches the open composers — today's explicit Refresh never did —
        // and this snapshot is what their re-read finds, so the bump costs
        // them nothing rather than starting a fourth sweep. The refresh
        // report is left off what is published: it answers "what did pressing
        // Refresh do", and a surface that merely re-reads because of the bump
        // must not replay it as if it had refreshed again.
        const forGeneration = generation.current;
        return client.inspect({ refresh: true }).then((snapshot) => {
          if (generation.current === forGeneration) {
            const { refresh: _report, ...catalog } = snapshot;
            invalidate();
            inspectRead.current = Promise.resolve(catalog);
          }
          return snapshot;
        });
      },
      defaults: () => coalesceRead(defaultsRead, () => client.defaults()),
      hiddenModels: () => coalesceRead(hiddenRead, () => client.hiddenModels()),
      compactionPolicy: () => client.compactionPolicy(),
      // A completed sign-in changes what every open composer may offer, so the
      // shared revision — what their catalogs re-read on — bumps here too, not
      // only when a default is saved.
      beginSignIn: (providerId, type, onUpdate) =>
        client.beginSignIn(providerId, type, (update) => {
          if (update.kind === "settled" && update.outcome.kind === "signed-in") {
            invalidate();
          }
          onUpdate(update);
        }),
      signOut: async (providerId) => {
        await client.signOut(providerId);
        invalidate();
      },
      setDefault: async (purpose, selection) => {
        const saved = await client.setDefault(purpose, selection);
        invalidate();
        return saved;
      },
      setHiddenModels: async (hidden) => {
        const saved = await client.setHiddenModels(hidden);
        invalidate();
        return saved;
      },
      // No revision bump: the shared one exists so open composers re-read what
      // they may OFFER, and compaction changes nothing about that. The runtime
      // reads this policy per compaction, off the database, so a Session
      // already running picks the change up without anything here telling it.
      setCompactionPolicy: (policy) => client.setCompactionPolicy(policy),
      // No revision bump here either: the view is how a picker OPENS, not what
      // it may offer, and the pill that changed it already holds the new word.
      pickerView: () => client.pickerView(),
      setPickerView: (view) => client.setPickerView(view),
      revision,
    };
  }, [client, revision]);
  return <ModelAccessContext.Provider value={value}>{children}</ModelAccessContext.Provider>;
}

export function useModelAccessClient(): ModelAccessContextValue | null {
  return React.useContext(ModelAccessContext);
}
