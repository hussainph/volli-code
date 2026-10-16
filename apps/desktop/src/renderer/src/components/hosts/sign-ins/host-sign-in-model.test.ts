/** Git push rows before the host holds its first credential, and after it takes one. */
import type { HostSignInStatus } from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";

import { signInRowsOf } from "./host-sign-in-model";

const EMPTY: HostSignInStatus = { providers: [], git: [] };

describe("git sign-in rows", () => {
  it("always offers GitHub on a fresh host, without changing the host's status", () => {
    expect(signInRowsOf(EMPTY, new Set())).toEqual([
      {
        key: "git:github.com",
        kind: "git",
        id: "github.com",
        label: "github.com",
        state: "missing",
        held: null,
        subscription: false,
        takesKey: true,
        macHasKey: false,
        source: "host",
      },
    ]);
    expect(EMPTY.git).toEqual([]);
  });

  it("keeps stored rows first, then offers GitHub and the surface's added hosts once", () => {
    const status: HostSignInStatus = {
      providers: [],
      git: [{ host: "gitlab.com", state: "expired", kind: "git" }],
    };
    const hosts = ["gitlab.com", "github.com", "git.example.com:8443", "git.example.com:8443"];
    const rows = signInRowsOf(status, new Set(), hosts);
    expect(rows.map((row) => [row.id, row.state, row.held])).toEqual([
      ["gitlab.com", "expired", "git"],
      ["github.com", "missing", null],
      ["git.example.com:8443", "missing", null],
    ]);
    expect(hosts).toHaveLength(4);
    expect(status.git).toHaveLength(1);
  });

  it("lets stored GitHub and added-host credentials own their rows without duplicates", () => {
    const status: HostSignInStatus = {
      providers: [],
      git: [
        { host: "github.com", state: "signed-in", kind: "git" },
        { host: "git.example.com:8443", state: "signed-in", kind: "git" },
      ],
    };
    expect(
      signInRowsOf(status, new Set(), ["github.com", "git.example.com:8443"]).map((row) => [
        row.key,
        row.state,
        row.held,
      ]),
    ).toEqual([
      ["git:github.com", "signed-in", "git"],
      ["git:git.example.com:8443", "signed-in", "git"],
    ]);
  });
});
