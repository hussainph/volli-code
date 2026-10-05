/**
 * What this profile has decided about reaching the Internet, and whether that
 * decision amounts to a working configuration.
 *
 * Two jobs, and the split between them is the point of the module.
 * {@link WebAccessSettings.view} answers the renderer and is defined by what it
 * leaves out — a provider, an endpoint, and three words about a key that are not
 * the key. {@link WebAccessSettings.resolve} answers the wiring and is the only
 * caller in the app that ever holds the plaintext, for exactly as long as it
 * takes to build a provider with it.
 *
 * **The endpoint is judged twice, deliberately.** Once here, at the moment a
 * person saves it, so a bad address is an error in Settings rather than a
 * refusal mid-turn six hours later. And once inside `createWebSearch`, on every
 * single search, because a row in SQLite is not a promise — a database edited
 * by hand, restored from a backup, or written by some future code path that
 * forgot this rule still has to get past the policy before a socket opens.
 * Neither check makes the other redundant: this one exists to be readable, that
 * one exists to be true.
 *
 * **Off is the resting state and the default.** A profile that has never opened
 * this page resolves to nothing configured, which is what makes a Session with
 * no web tools the normal case rather than an opt-out.
 */
import type Database from "better-sqlite3";
import { admitSearchEndpoint } from "@volli/agent-runtime";

import { prepared } from "@volli/host-core/db/prepared";
import type {
  KeyedWebAccessProvider,
  WebAccessProvider,
  WebAccessSettingsView,
} from "@volli/shared";
import type { WebCredentialStore } from "./credential";
import type {
  WebCredentialMirror,
  WebMirrorResult,
  WebSealingPendingReason,
} from "./credential-mirror";

export type { KeyedWebAccessProvider, WebAccessProvider, WebAccessSettingsView };

/** The choice a person is making, as it crosses from Settings. */
export interface WebAccessProviderInput {
  provider: WebAccessProvider;
  /** Required for `searxng`, ignored otherwise. Judged before it is stored. */
  searxngUrl: string | null;
}

/**
 * Why a Session is being offered no web, when it is.
 *
 * Named rather than boolean because every one of these reads differently to the
 * person who set it up: `off` is a choice, `no-key` and `no-endpoint` are two
 * halves of an unfinished one. None of them are a secret, so all of them are
 * safe to log. There used to be a fourth, `unreadable-key`, for a keychain that
 * would not open what Volli had stored; nothing can refuse a key now, so no
 * Session has that to be told about.
 */
export type WebAccessUnconfigured = "off" | "no-key" | "no-endpoint";

/**
 * The wiring's answer. The `brave` arm carries the plaintext key — this is the
 * one type in the desktop app that does, and it never crosses an IPC boundary,
 * never reaches an observation, and is consumed by the provider constructor in
 * the same expression that produced it.
 */
export type ResolvedWebAccess =
  | { configured: false; reason: WebAccessUnconfigured }
  | { configured: true; provider: KeyedWebAccessProvider; apiKey: string }
  | { configured: true; provider: "searxng"; endpoint: string };

/** A refusal a person reads in Settings. Never carries a key; it never sees one. */
export class WebAccessSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebAccessSettingsError";
  }
}

interface SettingsRow {
  provider: string;
  searxng_url: string | null;
}

const PROVIDERS: readonly WebAccessProvider[] = ["off", "brave", "searxng", "exa"];

/** The providers with a key, in the order Settings lists them. */
export const KEYED_PROVIDERS: readonly KeyedWebAccessProvider[] = ["brave", "exa"];

/** The stored provider, or `off` for anything this version does not recognise. */
function readProvider(value: string): WebAccessProvider {
  return PROVIDERS.find((provider) => provider === value) ?? "off";
}

export interface WebAccessSettingsOptions {
  db: Database.Database;
  /** One store per keyed provider. Total, so no lookup here can miss. */
  credentials: Readonly<Record<KeyedWebAccessProvider, WebCredentialStore>>;
  /**
   * The keys' sealed mirror (VC-643, step E), resealed after every save and
   * clear. Absent: no host key backend, so sealing stays pending.
   */
  mirror?: WebCredentialMirror | null;
  now?: () => number;
}

/** Why a save's reseal is finished in the background rather than left pending. */
const RESEAL_LATER: ReadonlySet<WebSealingPendingReason> = new Set<WebSealingPendingReason>([
  "busy",
  "key-pending",
  "moved",
]);

export class WebAccessSettings {
  readonly #db: Database.Database;
  readonly #credentials: Readonly<Record<KeyedWebAccessProvider, WebCredentialStore>>;
  readonly #mirror: WebCredentialMirror | null;
  readonly #now: () => number;

  constructor(options: WebAccessSettingsOptions) {
    this.#db = options.db;
    this.#credentials = options.credentials;
    this.#mirror = options.mirror ?? null;
    this.#now = options.now ?? Date.now;
  }

  /** The renderer's whole picture. */
  view(): WebAccessSettingsView {
    const row = this.#row();
    const keys = { brave: this.#credentials.brave.state(), exa: this.#credentials.exa.state() };
    const held = keys.brave === "present" || keys.exa === "present";
    return {
      provider: readProvider(row.provider),
      searxngUrl: row.searxng_url,
      keys,
      sealing: this.#mirror?.sealing() ?? (held ? "pending" : "none"),
    };
  }

  /**
   * Record the provider a person chose, refusing an endpoint that policy will
   * not call.
   *
   * Choosing Brave with no key stored is allowed on purpose: a person picks the
   * provider and then pastes the key, and refusing the first half of that would
   * make the page argue with them. What it costs is nothing — {@link resolve}
   * reports `no-key` and the Session is offered no search — and the view says
   * so plainly enough for Settings to ask for the key.
   *
   * The stored URL is the one admission normalized, not the string typed. They
   * differ (a missing trailing slash, a dropped fragment, a lowercased host),
   * and storing the typed one would mean the thing validated and the thing
   * saved were two different strings.
   */
  setProvider(input: WebAccessProviderInput): WebAccessSettingsView {
    let searxngUrl = this.#row().searxng_url;
    if (input.provider === "searxng") {
      const typed = input.searxngUrl?.trim() ?? "";
      if (typed === "") {
        throw new WebAccessSettingsError("Enter the address of your SearXNG instance.");
      }
      const admission = admitSearchEndpoint(typed);
      if (admission.outcome === "refuse") throw new WebAccessSettingsError(admission.reason);
      searxngUrl = admission.endpoint.url;
    }
    this.#write(input.provider, searxngUrl);
    return this.view();
  }

  /**
   * Store one provider's key. Refuses an empty paste rather than recording one.
   *
   * The key is committed to the profile database first, which is the save;
   * then its sealed mirror is resealed (step E). A reseal that cannot happen
   * now does not undo or fail the save: the view answers `sealing: "pending"`,
   * "saved; sealing pending", and the mirror is rebuilt later.
   */
  saveKey(provider: KeyedWebAccessProvider, key: string): WebAccessSettingsView {
    this.#credentials[provider].save(key);
    this.#reseal();
    return this.view();
  }

  /**
   * Forget one provider's key. The provider choice, and the other key, are left alone.
   * Like a save: the database first, then the mirror, which drops the key.
   */
  clearKey(provider: KeyedWebAccessProvider): WebAccessSettingsView {
    this.#credentials[provider].clear();
    this.#reseal();
    return this.view();
  }

  /**
   * Reconciles the keys' sealed mirror from the database, as every launch
   * does (step E): asynchronous, retried while another process holds the
   * credential lock, never rejecting. `null` with no mirror wired.
   */
  reconcileSealing(): Promise<WebMirrorResult | null> {
    return this.#mirror === null ? Promise.resolve(null) : this.#mirror.reconcileSoon();
  }

  /**
   * Stops sealing for the rest of this launch (an accepted quit): see
   * {@link WebCredentialMirror.stop}. Saves and clears still commit to the
   * database; nothing reseals after this.
   */
  stopSealing(): void {
    this.#mirror?.stop();
  }

  /**
   * One attempt now, never a wait on another process or the keychain (this
   * runs on Electron's main thread). A busy lock, a key the keychain has not
   * given yet, or a source that moved while sealing is finished in the
   * background: a person saved or cleared, so the keychain may be asked.
   */
  #reseal(): void {
    if (this.#mirror === null) return;
    const result = this.#mirror.reconcile();
    if (result.sealing === "pending" && RESEAL_LATER.has(result.reason)) {
      void this.#mirror.reconcileSoon({ person: true });
    }
  }

  /**
   * Whether this profile can actually search, and with what.
   *
   * Main-only. The plaintext key is read here and nowhere else in the app, and
   * the only caller is the one that constructs a provider out of it.
   *
   * **This never throws, and that is load-bearing.** It runs on the attach
   * path, so a throw would not cost a Session its web tools — it would cost it
   * the attachment. A profile with no key is a Session that starts without web
   * tools and a Settings page that says why. Since the key stopped being
   * keychain material there is nothing left here that could throw anyway; the
   * rule is kept because it is a rule about this method's place in the attach
   * path, not about what it happens to call today.
   */
  resolve(): ResolvedWebAccess {
    const row = this.#row();
    const provider = readProvider(row.provider);
    if (provider === "off") return { configured: false, reason: "off" };
    if (provider === "brave" || provider === "exa") {
      // Read rather than asked about first: the plaintext is wanted either way,
      // and a `state()` call ahead of it would only be the same lookup twice,
      // with a window between them for the two answers to disagree.
      const apiKey = this.#credentials[provider].read();
      if (apiKey === null) return { configured: false, reason: "no-key" };
      return { configured: true, provider, apiKey };
    }
    const endpoint = row.searxng_url;
    // Re-judged rather than trusted. What was admitted at save time is not what
    // is necessarily in this row now.
    if (endpoint === null || admitSearchEndpoint(endpoint).outcome === "refuse") {
      return { configured: false, reason: "no-endpoint" };
    }
    return { configured: true, provider: "searxng", endpoint };
  }

  /** The one row, or the default a profile that never configured anything has. */
  #row(): SettingsRow {
    return (
      prepared<[], SettingsRow>(
        this.#db,
        "SELECT provider, searxng_url FROM web_access_settings WHERE id = 1",
      ).get() ?? { provider: "off", searxng_url: null }
    );
  }

  #write(provider: WebAccessProvider, searxngUrl: string | null): void {
    prepared(
      this.#db,
      `INSERT INTO web_access_settings (id, provider, searxng_url, updated_at) VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         provider = excluded.provider,
         searxng_url = excluded.searxng_url,
         updated_at = excluded.updated_at`,
    ).run(provider, searxngUrl, this.#now());
  }
}
