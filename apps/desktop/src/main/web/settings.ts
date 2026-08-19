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

import { prepared } from "../db/prepared";
import type {
  KeyedWebAccessProvider,
  WebAccessProvider,
  WebAccessSettingsView,
} from "../../ipc/contract";
import type { WebCredentialStore } from "./credential";

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
 * person who set it up: `off` is a choice, `no-key` is an unfinished setup, and
 * `unreadable-key` is a machine that stopped being able to open its own
 * keychain. None of them are a secret, so all of them are safe to log.
 */
export type WebAccessUnconfigured = "off" | "no-key" | "unreadable-key" | "no-endpoint";

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
  now?: () => number;
}

export class WebAccessSettings {
  readonly #db: Database.Database;
  readonly #credentials: Readonly<Record<KeyedWebAccessProvider, WebCredentialStore>>;
  readonly #now: () => number;

  constructor(options: WebAccessSettingsOptions) {
    this.#db = options.db;
    this.#credentials = options.credentials;
    this.#now = options.now ?? Date.now;
  }

  /** The renderer's whole picture. */
  view(): WebAccessSettingsView {
    const row = this.#row();
    return {
      provider: readProvider(row.provider),
      searxngUrl: row.searxng_url,
      keys: { brave: this.#credentials.brave.state(), exa: this.#credentials.exa.state() },
      // A property of the machine rather than of a provider, so either store
      // answers it and both answer the same.
      encryptionAvailable: this.#credentials.brave.encryptionAvailable(),
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

  /** Store one provider's key. Refuses, loudly, rather than storing one in the clear. */
  saveKey(provider: KeyedWebAccessProvider, key: string): WebAccessSettingsView {
    this.#credentials[provider].save(key);
    return this.view();
  }

  /** Forget one provider's key. The provider choice, and the other key, are left alone. */
  clearKey(provider: KeyedWebAccessProvider): WebAccessSettingsView {
    this.#credentials[provider].clear();
    return this.view();
  }

  /**
   * Whether this profile can actually search, and with what.
   *
   * Main-only. The plaintext key is read here and nowhere else in the app, and
   * the only caller is the one that constructs a provider out of it.
   *
   * **This never throws, and that is load-bearing.** It runs on the attach
   * path, so a throw would not cost a Session its web tools — it would cost it
   * the attachment. A key this machine cannot decrypt is a profile with no
   * working search, which is a Session that starts without web tools and a
   * Settings page that says why.
   */
  resolve(): ResolvedWebAccess {
    const row = this.#row();
    const provider = readProvider(row.provider);
    if (provider === "off") return { configured: false, reason: "off" };
    if (provider === "brave" || provider === "exa") {
      const credentials = this.#credentials[provider];
      const state = credentials.state();
      if (state === "absent") return { configured: false, reason: "no-key" };
      if (state === "unreadable") return { configured: false, reason: "unreadable-key" };
      let apiKey: string | null;
      try {
        apiKey = credentials.read();
      } catch {
        // The keychain answered and the ciphertext still would not open: a
        // profile restored from a backup, or an entry replaced underneath this
        // one. `state()` cannot see that without decrypting, so this is where
        // it is found out.
        return { configured: false, reason: "unreadable-key" };
      }
      /* v8 ignore next -- `state()` already said a key is here and readable; this is the racing writer nobody has. */
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
