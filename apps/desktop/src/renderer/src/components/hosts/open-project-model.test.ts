import type { RemoteHostProjects } from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";

import {
  canCreate,
  creatingLine,
  failedLine,
  failureRecovery,
  SUDO_TRIES,
  listNotice,
  projectRows,
  projectSource,
  sourceHint,
  sourceProblem,
  type ProjectListState,
} from "./open-project-model";

const ACME = { id: "w-acme", name: "Acme", prefix: "AC", path: "/srv/volli/acme", tickets: 3 };
const BETA = { id: "w-beta", name: "beta", prefix: "BE", path: "/srv/volli/beta", tickets: 1 };

const ready = (patch: Partial<RemoteHostProjects> = {}): ProjectListState => ({
  kind: "ready",
  listing: { hostId: "h", projects: [ACME, BETA], adds: { kind: "ready" }, ...patch },
});

describe("Open a project on <host>…, as its sheet reads it", () => {
  it("lists the host's projects by name, each marked when this Mac has it open", () => {
    expect(projectRows([BETA, ACME], new Set(["w-beta"]))).toEqual([
      { id: "w-acme", name: "Acme", meta: "AC · /srv/volli/acme · 3 tickets", opened: false },
      { id: "w-beta", name: "beta", meta: "BE · /srv/volli/beta · 1 ticket", opened: true },
    ]);
  });

  it("says one line with one recovery for every state that is not a list", () => {
    expect(listNotice({ kind: "loading" }, "box")).toBeNull();
    expect(listNotice({ kind: "error", message: "Couldn't reach box." }, "box")).toEqual({
      line: "Couldn't reach box.",
      recovery: { kind: "retry", label: "Try again" },
    });
    expect(listNotice(ready({ projects: [] }), "box")).toEqual({
      line: "No projects on box yet.",
      recovery: { kind: "new", label: "New project…" },
    });
    expect(listNotice(ready(), "box")).toBeNull();
    const command = "sudo volli-hostd operator-token --for 'deploy'";
    for (const projects of [[], [ACME]]) {
      expect(
        listNotice(ready({ projects, adds: { kind: "needs-operator", command } }), "box"),
      ).toEqual({
        line: "Run this once on box so this Mac can add projects there.",
        recovery: { kind: "copy", command },
      });
    }
    expect(listNotice(ready({ projects: [], adds: { kind: "user-install" } }), "box")).toEqual({
      line: "box runs Volli as your login, so this Mac can’t add projects to it.",
      recovery: { kind: "retry", label: "Refresh" },
    });
    expect(listNotice(ready({ adds: { kind: "user-install" } }), "box")).toBeNull();
  });

  it("offers New project… wherever the login can add one", () => {
    expect(canCreate({ kind: "loading" })).toBe(true);
    expect(canCreate({ kind: "error", message: "x" })).toBe(true);
    expect(canCreate(ready())).toBe(true);
    expect(canCreate(ready({ adds: { kind: "user-install" } }))).toBe(false);
  });

  it("reads the one field as a git URL to clone or a folder on the host", () => {
    expect(projectSource("  ")).toBeNull();
    expect(projectSource(" https://github.com/me/acme.git ")).toEqual({
      kind: "git",
      gitUrl: "https://github.com/me/acme.git",
    });
    expect(projectSource("git@github.com:me/acme.git")).toEqual({
      kind: "git",
      gitUrl: "git@github.com:me/acme.git",
    });
    expect(projectSource("/srv/volli/acme")).toEqual({ kind: "path", path: "/srv/volli/acme" });
    expect(projectSource("~/code/acme")).toEqual({ kind: "path", path: "~/code/acme" });
  });

  it("asks a folder for a full path, and leaves the rest to the host", () => {
    expect(sourceProblem(null, "box")).toBeNull();
    expect(sourceProblem({ kind: "path", path: "acme" }, "box")).toBe(
      "A folder on box is a full path, like /srv/volli/app.",
    );
    expect(sourceProblem({ kind: "path", path: "/srv/acme" }, "box")).toBeNull();
    expect(sourceProblem({ kind: "path", path: "~/acme" }, "box")).toBeNull();
    expect(sourceProblem({ kind: "git", gitUrl: "file:///x" }, "box")).toBeNull();
  });

  it("hints where a clone goes, and says what runs while it does", () => {
    expect(sourceHint(null)).toBe("A git URL, or a folder already on the host.");
    expect(sourceHint({ kind: "path", path: "/a" })).toBe(
      "A git URL, or a folder already on the host.",
    );
    expect(sourceHint({ kind: "git", gitUrl: "u" })).toBe(
      "Cloned into /srv/volli on the host, then added.",
    );
    expect(creatingLine({ kind: "git", gitUrl: "u" }, "box")).toBe("Cloning on box…");
    expect(creatingLine({ kind: "path", path: "/a" }, "box")).toBe("Adding it on box…");
  });

  it("words a call that threw", () => {
    expect(failedLine("open", "Acme", new Error("registry"))).toBe("Couldn’t open Acme: registry");
    expect(failedLine("close", "Acme", new Error(""))).toBe(
      "Couldn’t close Acme: That didn’t work.",
    );
    expect(failedLine("create", "box", "nope")).toBe("Couldn’t add box: That didn’t work.");
  });

  it("offers the sudo field (once more after a wrong one), Sign-ins, or a retry", () => {
    const failure = (code: Parameters<typeof failureRecovery>[0]["code"]) => ({
      code,
      message: "x",
      command: null,
    });
    expect(failureRecovery(failure("needs-password"), "box", 0)).toEqual({
      kind: "password",
      again: false,
    });
    expect(failureRecovery(failure("wrong-password"), "box", 1)).toEqual({
      kind: "password",
      again: true,
    });
    expect(failureRecovery(failure("wrong-password"), "box", SUDO_TRIES)).toEqual({
      kind: "retry",
    });
    expect(failureRecovery(failure("needs-credential"), "box", 0)).toEqual({
      kind: "sign-ins",
      label: "Sign-ins on box…",
    });
    expect(failureRecovery(failure("clone-failed"), "box", 0)).toEqual({ kind: "retry" });
  });
});
