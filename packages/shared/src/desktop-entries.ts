/**
 * The desktop-only tier of the host's command set (VC-608; HP § Command
 * catalog, D-A1 = (c) hybrid).
 *
 * A desktop-only entry is a host command only the desktop's own window calls:
 * an IPC channel moved out of `data-ipc.ts` onto the router-generic bridge
 * without the public catalog's ceremony (frozen features, N−1 fixtures). It is
 * still one key in the host's ONE handler map (`@volli/host-core/handlers`),
 * still built from an entry by the catalog's builders, and still policed:
 *
 * - **Policy is the channel's VC-574 placement, nothing else.** A `workspace`
 *   entry is workspace-scoped: its procedure names the resources the input
 *   addresses and the router authorizes each one's Workspace before the
 *   handler runs. A `host` entry is host-scoped: device-as-user only. Both are
 *   the person's (`actor: "user"`) and have no access mode, so no network
 *   door serves them and no Session reaches them. A `client-local` channel
 *   never enters the host map; its row stays desktop IPC.
 *   `desktopCatalogEntry` is that derivation, and the only one.
 * - **Additive only** across supported skew: never renamed, removed or
 *   changed in meaning. Its schemas are published in the committed protocol
 *   schema's `desktop` tier and diffed by the same compatibility gate.
 * - **Promotion** to the public tier moves the entry into the Verb Registry
 *   (with `hostApi`, schemas, features and fixtures) under the same key, and
 *   its procedure into the public area router. The handler does not move.
 *
 * Keys are host command names, never Electron channel names: the channel a
 * key replaced is recorded by the desktop, beside its placement table
 * (`apps/desktop/src/ipc/placement.ts`). This table lives in `@volli/shared`
 * for the reason the public key sets do: both the host's map (host-core) and
 * the router package build from it, and neither may import the other (D2).
 */
import type { CloudPlacement } from "./app-state-keys";
import type { VerbCatalogDeclaration, VerbEntry, VerbIdempotency } from "./verb-registry";

/** The placements a host command can have: never `client-local`, never `split` (name the half). */
export type DesktopEntryPlacement = Extract<CloudPlacement, "workspace" | "host">;

/** One desktop-only host command. */
export interface DesktopEntryDeclaration {
  /** Its identity on the bridge and in the map, chosen once (additive only). */
  readonly key: string;
  /**
   * The VC-574 placement of the channel it replaced (a `split` channel's
   * non-client half names its `split.scope`). The whole of its policy.
   */
  readonly placement: DesktopEntryPlacement;
  readonly idempotency: VerbIdempotency;
  readonly summary: string;
}

/**
 * Every desktop-only command, in the order they joined. Append only: a key
 * here is a promise to every supported desktop build.
 */
export const DESKTOP_ENTRIES = [
  {
    key: "ticket.body",
    placement: "workspace",
    idempotency: "read",
    summary: "One ticket's Markdown body, for the ticket that is open.",
  },
  {
    key: "label.setColor",
    placement: "workspace",
    idempotency: "natural",
    summary: "Set or clear one label's stored color.",
  },
] as const satisfies readonly DesktopEntryDeclaration[];

export type DesktopEntry = (typeof DESKTOP_ENTRIES)[number];

/** Every desktop-only key. */
export type DesktopKey = DesktopEntry["key"];

/** A desktop entry as the catalog's builders read it: its policy, derived from its placement. */
export type DesktopCatalogEntry<Entry extends DesktopEntryDeclaration = DesktopEntry> =
  Entry extends DesktopEntryDeclaration
    ? {
        readonly key: Entry["key"];
        readonly accessModes: readonly [];
        readonly actor: "user";
        readonly handler: { readonly site: "main"; readonly id: Entry["key"] };
        readonly listed: false;
        readonly group: "App";
        readonly summary: Entry["summary"];
        readonly options: readonly [];
        readonly catalog: {
          readonly actor: "user";
          readonly scope: Entry["placement"];
          readonly idempotency: Entry["idempotency"];
        };
      }
    : never;

/**
 * The one derivation of a desktop entry's policy from its placement: the
 * person only, no network door, scoped as the channel was placed.
 */
export function desktopCatalogEntry<Entry extends DesktopEntryDeclaration>(
  entry: Entry,
): DesktopCatalogEntry<Entry> {
  const catalog: VerbCatalogDeclaration = {
    actor: "user",
    scope: entry.placement,
    idempotency: entry.idempotency,
  };
  const derived: VerbEntry = {
    key: entry.key,
    accessModes: [],
    actor: "user",
    handler: { site: "main", id: entry.key },
    listed: false,
    group: "App",
    summary: entry.summary,
    options: [],
    catalog,
  };
  return Object.freeze(derived) as DesktopCatalogEntry<Entry>;
}

/** Every desktop entry, catalog-shaped: what the desktop router family and the map's policy read. */
export const DESKTOP_CATALOG_ENTRIES: readonly DesktopCatalogEntry[] = Object.freeze(
  DESKTOP_ENTRIES.map((entry) => desktopCatalogEntry<DesktopEntry>(entry)),
);
