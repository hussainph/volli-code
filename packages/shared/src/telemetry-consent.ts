/**
 * Whether Volli's own telemetry may send, decided once, as a pure function
 * (VC-505).
 *
 * Two tiers, each with its own switch: crash reports and usage statistics
 * ({@link TelemetryEvent}). {@link resolveTelemetry} decides both from
 * everything that has a say, so the desktop app, the runner and their tests
 * read one precedence instead of re-deriving it:
 *
 * 1. A development build or CI sends nothing.
 * 2. `DO_NOT_TRACK`, or `VOLLI_TELEMETRY` set to anything but on, sends
 *    nothing.
 * 3. Otherwise the person's own choice: the account's once this device is
 *    linked to it, this device's otherwise.
 * 4. With no current choice: where the region is a {@link CHOICE_REGIONS}
 *    region, or unknown, nothing is sent until the person chooses. Anywhere
 *    else both tiers are on, once the first-run notice has been shown.
 *
 * **Linking.** The first time a signed-in device resolves against an account,
 * its choice and the account's are reconciled per tier, the more private
 * value winning, and the result is written to both — so a device where the
 * person turned a tier off never has it silently turned back on by an
 * account, and that tier goes off on their other devices too. After that the
 * account is the authority, and a later change on any device is written to
 * the account like any other decision.
 *
 * Nothing here reads the environment, the clock or storage; the caller passes
 * them in and persists what {@link TelemetryResolution} says to write. This
 * governs Volli's own destination only. The collector a person configures for
 * the Agent Runtime's events (VC-119) has its own setting.
 */

import { isoRegionCode, type IsoRegionCode } from "./telemetry-vocabulary";

/**
 * Where nothing is sent until the person chooses, and the first-run card asks
 * rather than tells: the EEA, the United Kingdom and Canada. The OS reports
 * `CA` for every Canadian province, so Canada is listed whole.
 */
export const CHOICE_REGIONS = [
  // EU member states.
  "AT",
  "BE",
  "BG",
  "CY",
  "CZ",
  "DE",
  "DK",
  "EE",
  "ES",
  "FI",
  "FR",
  "GR",
  "HR",
  "HU",
  "IE",
  "IT",
  "LT",
  "LU",
  "LV",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SE",
  "SI",
  "SK",
  // EU territory with its own ISO code: Åland, and the outermost regions.
  "AX",
  "GF",
  "GP",
  "MF",
  "MQ",
  "RE",
  "YT",
  // The rest of the EEA.
  "IS",
  "LI",
  "NO",
  // The United Kingdom.
  "GB",
  "CA", // Canada, every province.
] as const satisfies readonly IsoRegionCode[];

const CHOICE_REGION_SET: ReadonlySet<string> = new Set(CHOICE_REGIONS);

/**
 * The version of the first-run text. Bump it only when the field list gains a
 * new *category* of data — not a new field in an existing category — so the
 * card asks again. A choice made under an older version keeps only the tiers
 * it turned off. A choice made under a newer version (written by a newer
 * build) is current.
 */
export const TELEMETRY_NOTICE_VERSION = 1;

export interface TelemetryTiers {
  crash: boolean;
  usage: boolean;
}

/** One person's decision for both tiers, with what proves it. */
export interface TelemetryChoice extends TelemetryTiers {
  /** The {@link TELEMETRY_NOTICE_VERSION} the decision was made under. */
  noticeVersion: number;
  /** Epoch ms. */
  decidedAt: number;
  regionAtDecision: IsoRegionCode | null;
}

/**
 * A decision the person just made — on the first-run card or in Settings — as
 * the record to store: on this device, and on the account when signed in.
 */
export function telemetryChoice(
  tiers: TelemetryTiers,
  at: { decidedAt: number; region: unknown },
): TelemetryChoice {
  return {
    crash: tiers.crash,
    usage: tiers.usage,
    noticeVersion: TELEMETRY_NOTICE_VERSION,
    decidedAt: at.decidedAt,
    regionAtDecision: isoRegionCode(at.region) ?? null,
  };
}

export interface TelemetryAccountState {
  /** The account's stored decision, or `null` until it holds one. */
  choice: TelemetryChoice | null;
  /** The account's region, when it has one. Narrowed here; anything else is unknown. */
  region?: unknown;
  /** Whether this device has already reconciled with this account. */
  linked: boolean;
}

export interface TelemetryInputs {
  /** False for a development or otherwise unpackaged build. */
  packaged: boolean;
  /** The process environment, as `process.env`. */
  env: Readonly<Record<string, string | undefined>>;
  /** What the OS reports as its country. Narrowed here; anything else is unknown. */
  osRegion: unknown;
  /** This device's stored decision, if any. */
  local: TelemetryChoice | null;
  /** `null` when signed out. */
  account: TelemetryAccountState | null;
  /** The newest notice version this device has shown its first-run notice for. */
  noticeShownVersion: number | null;
}

/**
 * Why the tiers came out as they did, in the order of the precedence above.
 * `awaiting-choice` and `awaiting-notice` come with the first-run card.
 */
export type TelemetryReason =
  | "dev-build"
  | "ci"
  | "env"
  | "choice"
  | "awaiting-choice"
  | "awaiting-notice"
  | "notice-default";

export interface TelemetryResolution extends TelemetryTiers {
  why: TelemetryReason;
  /**
   * The first-run card to show now, or none. Never shown while the build or
   * the environment turns telemetry off, so a development build never shows
   * it: exercise the card with a packaged build or a fixture.
   */
  card: "notice" | "choice" | null;
  /**
   * The person's own decision as it now stands, whatever the build or
   * environment says — what Settings shows. `null` when they have made none.
   */
  choice: TelemetryChoice | null;
  /** Store this on this device, when it differs from what is stored. */
  localWrite: TelemetryChoice | null;
  /** Store this on the account, when it differs from what is stored. */
  accountWrite: TelemetryChoice | null;
  /** Record that this device is now linked to the account. */
  linkAccount: boolean;
}

/** Decides both tiers and what to store. See the module comment for the precedence. */
export function resolveTelemetry(input: TelemetryInputs): TelemetryResolution {
  const stored = storedChoice(input.local ?? null, input.account ?? null);
  const choice = stored.choice;
  const off = { crash: false, usage: false, card: null, ...stored } as const;

  if (!input.packaged) return { ...off, why: "dev-build" };
  if (envSet(input.env.CI)) return { ...off, why: "ci" };
  // Read strictly: only a recognised "on" counts as on (it skips the notice,
  // never more), and any other value it is set to is off.
  const volliTelemetry = envSwitch(input.env.VOLLI_TELEMETRY);
  if (envSet(input.env.DO_NOT_TRACK) || volliTelemetry === "off" || volliTelemetry === "other") {
    return { ...off, why: "env" };
  }

  if (choice !== null && choice.noticeVersion >= TELEMETRY_NOTICE_VERSION) {
    return { crash: choice.crash, usage: choice.usage, why: "choice", card: null, ...stored };
  }

  // No current choice. A choice made under an older notice still keeps every
  // tier it turned off; the region decides the rest.
  const ask = asksFirst(input.osRegion, input.account?.region);
  const noticeDue =
    !ask && volliTelemetry !== "on" && (input.noticeShownVersion ?? 0) < TELEMETRY_NOTICE_VERSION;
  const sends = !ask && !noticeDue;
  return {
    crash: sends && (choice?.crash ?? true),
    usage: sends && (choice?.usage ?? true),
    why: ask ? "awaiting-choice" : noticeDue ? "awaiting-notice" : "notice-default",
    card: ask ? "choice" : noticeDue ? "notice" : null,
    ...stored,
  };
}

/**
 * Whether the person must be asked first: when any region we know of is a
 * choice region, or we know of none. A region that is not an assigned ISO
 * code — empty, lower-case garbage, a UN area — is not known.
 */
function asksFirst(osRegion: unknown, accountRegion: unknown): boolean {
  const known = [isoRegionCode(osRegion), isoRegionCode(accountRegion)].filter(
    (region) => region !== undefined,
  );
  return known.length === 0 || known.some((region) => CHOICE_REGION_SET.has(region));
}

/** The decision in force, and what to store so this device and the account agree on it. */
function storedChoice(
  local: TelemetryChoice | null,
  account: TelemetryAccountState | null,
): Pick<TelemetryResolution, "choice" | "localWrite" | "accountWrite" | "linkAccount"> {
  if (account === null) {
    return { choice: local, localWrite: null, accountWrite: null, linkAccount: false };
  }
  const accountChoice = account.choice ?? null;
  const choice = !account.linked ? reconcile(local, accountChoice) : (accountChoice ?? local);
  return {
    choice,
    localWrite: changes(local, choice),
    accountWrite: changes(accountChoice, choice),
    linkAccount: !account.linked,
  };
}

/**
 * Two decisions as one, per tier, off winning. A tier left on is on in both,
 * so the newer of the two notices covers it, and the later decision is the
 * one on record.
 */
function reconcile(
  local: TelemetryChoice | null,
  account: TelemetryChoice | null,
): TelemetryChoice | null {
  if (local === null || account === null) return local ?? account;
  const later = account.decidedAt > local.decidedAt ? account : local;
  return {
    crash: local.crash && account.crash,
    usage: local.usage && account.usage,
    noticeVersion: Math.max(local.noticeVersion, account.noticeVersion),
    decidedAt: later.decidedAt,
    regionAtDecision: later.regionAtDecision,
  };
}

/** `next`, when storing it would change what `current` holds; otherwise `null`. */
function changes(
  current: TelemetryChoice | null,
  next: TelemetryChoice | null,
): TelemetryChoice | null {
  if (next === null) return null;
  const same =
    current !== null &&
    current.crash === next.crash &&
    current.usage === next.usage &&
    current.noticeVersion === next.noticeVersion &&
    current.decidedAt === next.decidedAt &&
    current.regionAtDecision === next.regionAtDecision;
  return same ? null : next;
}

/**
 * An environment switch. Unset or empty is `unset`; `0`, `false`, `off` and
 * `no` are `off`; `1`, `true`, `on` and `yes` are `on`, in any case and with
 * surrounding space; anything else is `other`, which each caller reads in the
 * private direction.
 */
function envSwitch(value: string | undefined): "on" | "off" | "unset" | "other" {
  const normalized = value?.trim().toLowerCase() ?? "";
  if (normalized === "") return "unset";
  if (["0", "false", "off", "no"].includes(normalized)) return "off";
  if (["1", "true", "on", "yes"].includes(normalized)) return "on";
  return "other";
}

/**
 * Whether a variable whose only purpose is to turn telemetry off — `CI`,
 * `DO_NOT_TRACK` — is set. Any value but an explicit off counts, so
 * `CI=woodpecker` is CI.
 */
function envSet(value: string | undefined): boolean {
  const state = envSwitch(value);
  return state === "on" || state === "other";
}
