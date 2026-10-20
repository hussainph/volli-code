import type { DecisionModelCatalogEntry, DecisionModelSetting } from "./decision-model";

/** The attempt id every later message about one sign-in is correlated by. */
export type ModelAccessSignInBeginResult = Result<{ attemptId: string }>;

/** Which search provider this profile brings, if any. `off` is the default. */
export type WebAccessProvider = "off" | "brave" | "searxng" | "exa";

/**
 * The providers that authenticate with a key a person pastes.
 *
 * Named apart from {@link WebAccessProvider} because carrying a credential is
 * what decides most of this surface: a keyed provider has a secret row, a key
 * state to report, and a "replace stored key" affordance, while SearXNG has an
 * address and `off` has neither.
 */
export type KeyedWebAccessProvider = "brave" | "exa";

/**
 * What the renderer may know about a stored API key: that there is one, or that
 * there is none.
 *
 * A state rather than the value, and there is no third member that carries one.
 * There was a third member — "unreadable", for a key the OS keychain would no
 * longer open — until the keys stopped being keychain material. A key the
 * profile holds is a key it can read.
 */
export type WebAccessKeyState = "absent" | "present";

/**
 * Whether the saved keys' sealed copy is current (VC-643, step E of their move
 * into the sealed credential store). Never a claim that the keys are
 * encrypted: until the read switch (VC-644) they rest in the profile database
 * in the clear, which stays the one source of truth, and the sealed copy is a
 * mirror of it.
 *
 * - `sealed`: a sealed copy of exactly the saved keys was written and read
 *   back.
 * - `pending`: the keys are saved; their sealed copy is not current yet (the
 *   keychain is locked, another Volli process held the credential lock, or
 *   sealing failed). It is rebuilt from the saved keys on the next save or
 *   launch.
 * - `none`: no key is saved and no sealed copy holds one.
 */
export type WebKeySealing = "sealed" | "pending" | "none";

/** The whole of what Settings is told about Web Access. */
export interface WebAccessSettingsView {
  /** Whether the saved keys' sealed copy is current; see {@link WebKeySealing}. */
  sealing: WebKeySealing;
  provider: WebAccessProvider;
  /** The normalized instance URL a person configured, or null. Never a secret. */
  searxngUrl: string | null;
  /**
   * What is stored for each keyed provider, and never what it is.
   *
   * One entry per provider rather than one for the selected one, because the
   * rows are independent: configuring Exa does not discard a Brave key, and a
   * person switching back should not be asked to paste one they already gave.
   */
  keys: Readonly<Record<KeyedWebAccessProvider, WebAccessKeyState>>;
}

/**
 * Everything Settings is told about decision models, for one page.
 *
 * `project` is present when the page asked about a project: its override, or
 * `null` when it inherits. `catalog` is every cloud classifier Pi offers, each
 * with whether this profile has signed in to its provider — the only
 * credential fact the renderer is given, and a state rather than a value.
 */
export interface DecisionModelSettingsView {
  global: DecisionModelSetting;
  project?: DecisionModelSetting | null;
  catalog: readonly DecisionModelCatalogEntry[];
}

/** What a connection test found, end to end: one small question asked for real. */
export type DecisionModelTestView =
  | { ok: true; elapsedMs: number; probability: number }
  | { ok: false; elapsedMs: number; message: string };

/** Which setting a write changes: the app-wide one, or one project's override. */
export type DecisionModelScope = { scope: "global" } | { scope: "project"; projectId: string };

/**
 * Result types below travel as typed discriminated unions rather than
 * thrown errors: `ipcMain.handle` rejections serialize into useless
 * strings across the IPC boundary, and every failure must be surfaceable
 * in the UI.
 *
 * {@link Result} is the shared shape every one of them had by hand: a success
 * carrying payload `T`, or a failure carrying an `error` string. Bare
 * `Result` (no payload) is a plain ok/error ack.
 */
export type Result<T = unknown> = ({ ok: true } & T) | { ok: false; error: string };
