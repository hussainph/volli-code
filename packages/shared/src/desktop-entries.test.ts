import { describe, expect, expectTypeOf, it } from "vite-plus/test";

import {
  DESKTOP_CATALOG_ENTRIES,
  DESKTOP_ENTRIES,
  desktopCatalogEntry,
  type DesktopEntryPlacement,
} from "./desktop-entries";
import { catalogActorOf, catalogEntriesFrom, verbTier } from "./verb-registry";

describe("the desktop-only tier", () => {
  // The whole of a desktop entry's policy is its VC-574 placement: the
  // person's, on no network door, scoped as the channel was placed.
  it("derives every entry's policy from its placement and nothing else", () => {
    expect(DESKTOP_CATALOG_ENTRIES).toHaveLength(DESKTOP_ENTRIES.length);
    DESKTOP_ENTRIES.forEach((entry, index) => {
      const derived = DESKTOP_CATALOG_ENTRIES[index]!;
      expect(derived).toEqual({
        key: entry.key,
        accessModes: [],
        actor: "user",
        handler: { site: "main", id: entry.key },
        listed: false,
        group: "App",
        summary: entry.summary,
        options: [],
        catalog: { actor: "user", scope: entry.placement, idempotency: entry.idempotency },
      });
      expect(Object.isFrozen(derived)).toBe(true);
    });
    expect(Object.isFrozen(DESKTOP_CATALOG_ENTRIES)).toBe(true);
  });

  it("is a catalog the router builders accept, on no surface an agent or a network caller reaches", () => {
    const checked = catalogEntriesFrom(DESKTOP_CATALOG_ENTRIES);
    expect(checked.map(({ key }) => key)).toEqual(DESKTOP_ENTRIES.map(({ key }) => key));
    for (const entry of checked) {
      expect(catalogActorOf(entry)).toBe("user");
      expect(verbTier(entry)).toBeNull();
    }
  });

  it("scopes a host-placed command to the host", () => {
    expect(
      desktopCatalogEntry({
        key: "example.hostPlaced",
        placement: "host",
        idempotency: "natural",
        summary: "A host-level setting.",
      }).catalog,
    ).toEqual({ actor: "user", scope: "host", idempotency: "natural" });
  });

  it("has no client-local or split placement to give a host command", () => {
    expectTypeOf<DesktopEntryPlacement>().toEqualTypeOf<"workspace" | "host">();
  });
});
