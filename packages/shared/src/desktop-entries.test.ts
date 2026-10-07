import { describe, expect, expectTypeOf, it } from "vite-plus/test";

import {
  DESKTOP_CATALOG_ENTRIES,
  DESKTOP_ENTRIES,
  desktopCatalogEntry,
  type DesktopEntryPlacement,
} from "./index";
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

  it("classifies every entry without changing its placement or policy", () => {
    const hostCommands = DESKTOP_ENTRIES.filter(
      ({ compatibility }) => compatibility === "host-command",
    );
    expect(hostCommands.map(({ key }) => key)).toEqual([
      "project.reorder",
      "worktree.trimSettings",
    ]);
    for (const entry of DESKTOP_ENTRIES) {
      const clientLocal = /^(hosts|hostAdd|hostSignIns|hostLink)\./u.test(entry.key);
      expect(entry.compatibility, entry.key).toBe(clientLocal ? "client-local" : "host-command");
    }
  });

  it("scopes a host-placed command to the host", () => {
    expect(
      desktopCatalogEntry({
        key: "example.hostPlaced",
        compatibility: "host-command",
        placement: "host",
        idempotency: "natural",
        summary: "A host-level setting.",
      }).catalog,
    ).toEqual({ actor: "user", scope: "host", idempotency: "natural" });
  });

  // VC-700 PR 2: the remote hosts registry and its add flows are desktop
  // main's, across every Workspace, so every one of them is host-placed.
  it("declares the remote hosts commands host-placed, reads as reads", () => {
    const remote = DESKTOP_ENTRIES.filter(
      ({ key }) => key.startsWith("hosts.") || key.startsWith("hostAdd."),
    );
    expect(remote.map(({ key }) => key)).toEqual([
      "hosts.snapshot",
      "hosts.subscribe",
      "hosts.retry",
      "hosts.updateHost",
      "hosts.cancelScheduledUpdate",
      "hosts.signIn",
      "hosts.forget",
      "hostAdd.start",
      "hostAdd.subscribe",
      "hostAdd.answer",
      "hostAdd.sudoPassword",
      "hostAdd.retry",
      "hostAdd.cancel",
      "hosts.rename",
      "hosts.devices",
      "hostAdd.facts",
      "hosts.projects",
      "hosts.createProject",
      "hosts.openWorkspace",
      "hosts.closeWorkspace",
      "hostAdd.active",
    ]);
    for (const entry of remote) expect(entry.placement, entry.key).toBe("host");
    expect(
      remote.filter(({ idempotency }) => idempotency === "read").map(({ key }) => key),
    ).toEqual([
      "hosts.snapshot",
      "hosts.subscribe",
      "hostAdd.subscribe",
      "hosts.devices",
      "hostAdd.facts",
      "hosts.projects",
      "hostAdd.active",
    ]);
    expect(new Set(DESKTOP_ENTRIES.map(({ key }) => key)).size).toBe(DESKTOP_ENTRIES.length);
  });

  // VC-711: a remote project's operations ride its Workspace link in main.
  // The Workspace is the remote host's, never one this host authorizes, so
  // the relay is host-placed like the rest of remote hosts.
  it("declares the Workspace link relay host-placed, its query and stream as reads", () => {
    const relay = DESKTOP_ENTRIES.filter(({ key }) => key.startsWith("hostLink."));
    expect(relay.map(({ key, placement, idempotency }) => [key, placement, idempotency])).toEqual([
      ["hostLink.query", "host", "read"],
      ["hostLink.mutate", "host", "natural"],
      ["hostLink.subscribe", "host", "read"],
    ]);
  });

  it("has no client-local or split placement to give a host command", () => {
    expectTypeOf<DesktopEntryPlacement>().toEqualTypeOf<"workspace" | "host">();
  });
});
