import * as React from "react";
import type {
  HiddenModelRef,
  ModelAccessDefaults,
  ModelAccessSignInType,
  ModelAccessSignInUpdate,
  ModelAccessSnapshot,
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
  /** Null clears a ticket/utility choice back to "use the project default". */
  setDefault(purpose: ModelPurpose, selection: ModelSelection | null): Promise<ModelAccessDefaults>;
  /** The models the user toggled out of composers and pickers. */
  hiddenModels(): Promise<readonly HiddenModelRef[]>;
  setHiddenModels(hidden: readonly HiddenModelRef[]): Promise<readonly HiddenModelRef[]>;
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

export function ModelAccessProvider({
  client,
  children,
}: React.PropsWithChildren<{ client: ModelAccessClient }>) {
  const [revision, setRevision] = React.useState(0);
  const value = React.useMemo<ModelAccessContextValue>(
    () => ({
      inspect: (input) => client.inspect(input),
      defaults: () => client.defaults(),
      hiddenModels: () => client.hiddenModels(),
      // A completed sign-in changes what every open composer may offer, so the
      // shared revision — what their catalogs re-read on — bumps here too, not
      // only when a default is saved.
      beginSignIn: (providerId, type, onUpdate) =>
        client.beginSignIn(providerId, type, (update) => {
          if (update.kind === "settled" && update.outcome.kind === "signed-in") {
            setRevision((current) => current + 1);
          }
          onUpdate(update);
        }),
      signOut: async (providerId) => {
        await client.signOut(providerId);
        setRevision((current) => current + 1);
      },
      setDefault: async (purpose, selection) => {
        const saved = await client.setDefault(purpose, selection);
        setRevision((current) => current + 1);
        return saved;
      },
      setHiddenModels: async (hidden) => {
        const saved = await client.setHiddenModels(hidden);
        setRevision((current) => current + 1);
        return saved;
      },
      revision,
    }),
    [client, revision],
  );
  return <ModelAccessContext.Provider value={value}>{children}</ModelAccessContext.Provider>;
}

export function useModelAccessClient(): ModelAccessContextValue | null {
  return React.useContext(ModelAccessContext);
}
