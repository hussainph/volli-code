import type { RemoteHostProjects } from "@volli/shared";
import { describe, expect, it } from "vite-plus/test";

import {
  canCreate,
  creatingLine,
  createProjectIntent,
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

const refusal = (code: Parameters<typeof failureRecovery>[0]["code"]) => ({
  code,
  message: "x",
  command: null,
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
      line: "Update box to create projects from here",
      recovery: { kind: "re-add", label: "Re-add" },
    });
    expect(listNotice(ready({ adds: { kind: "user-install" } }), "box")).toEqual(
      listNotice(ready({ projects: [], adds: { kind: "user-install" } }), "box"),
    );
  });

  it("offers New project… beside a list only where the login can add one: one recovery a state", () => {
    expect(canCreate({ kind: "loading" })).toBe(false);
    expect(canCreate({ kind: "error", message: "x" })).toBe(false);
    expect(canCreate(ready())).toBe(true);
    expect(canCreate(ready({ adds: { kind: "user-install" } }))).toBe(false);
    expect(canCreate(ready({ adds: { kind: "needs-operator", command: "c" } }))).toBe(false);
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

  it("asks a folder for a full path and rejects unsafe clone URLs before transport", () => {
    expect(sourceProblem(null, "box")).toBeNull();
    expect(sourceProblem({ kind: "path", path: "acme" }, "box")).toBe(
      "A folder on box is a full path, like /srv/volli/app.",
    );
    expect(sourceProblem({ kind: "path", path: "/srv/acme" }, "box")).toBeNull();
    expect(sourceProblem({ kind: "path", path: "~/acme" }, "box")).toBeNull();
    // HOST path sources are absolute paths, not shell-expanded SSH arguments.
    expect(sourceProblem({ kind: "path", path: "~/acme" }, "box", true)).toBe(
      "A folder on box is a full path, like /srv/volli/app.",
    );
    expect(sourceProblem({ kind: "path", path: "/home/me/acme" }, "box", true)).toBeNull();
    expect(sourceProblem({ kind: "git", gitUrl: "file:///x" }, "box")).toBe(
      "That isn't a git URL this Mac can clone: use https or ssh.",
    );
    const plain =
      "Use the repository's plain URL: a token goes in Sign-ins on box, not in the URL.";
    for (const gitUrl of [
      "https://x.io/r.git?access_token=t",
      "https://u@x.io/r.git",
      "https://fixture_token@x.io/r.git",
      "https://x.io/r.git#t",
      "https://x.io/r.git%3Ft",
      "https://u:t0k@x.io/r.git",
    ]) {
      expect(sourceProblem({ kind: "git", gitUrl }, "box"), gitUrl).toBe(plain);
    }
    for (const gitUrl of ["https://x.io/r.git", "ssh://deploy@x.io/r.git", "git@x.io:r.git"]) {
      expect(sourceProblem({ kind: "git", gitUrl }, "box", true)).toBeNull();
    }
  });

  it("hints where a clone goes, and says what runs while it does", () => {
    expect(sourceHint(null)).toBe("A git URL, or a folder already on the host.");
    expect(sourceHint({ kind: "path", path: "/a" })).toBe(
      "A git URL, or a folder already on the host.",
    );
    expect(sourceHint({ kind: "git", gitUrl: "u" })).toBe(
      "Cloned into /srv/volli on the host, then added.",
    );
    expect(sourceHint({ kind: "git", gitUrl: "u" }, true)).toBe("Cloned on the host, then added.");
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
    expect(failureRecovery(refusal("needs-password"), "box", 0)).toEqual({
      kind: "password",
      again: false,
    });
    expect(failureRecovery(refusal("wrong-password"), "box", 1)).toEqual({
      kind: "password",
      again: true,
    });
    expect(failureRecovery(refusal("wrong-password"), "box", SUDO_TRIES)).toEqual({
      kind: "retry",
    });
    expect(failureRecovery(refusal("needs-credential"), "box", 0)).toEqual({
      kind: "sign-ins",
      label: "Sign-ins on box…",
    });
    expect(failureRecovery(refusal("clone-failed"), "box", 0)).toEqual({ kind: "retry" });
  });
});

describe("HOST project rows and create intent", () => {
  it("never fabricates ticket counts or prefixes for HOST rows", () => {
    expect(
      projectRows([{ id: "a", name: "A", path: "/a", gitRemoteUrl: null }], new Set()),
    ).toEqual([{ id: "a", name: "A", meta: "/a", opened: false }]);
  });
  it("keeps one command id through retries and changes it on any edit", () => {
    let ids = 0;
    const intent = createProjectIntent(() => `id-${++ids}`);
    expect(intent.accept({ kind: "path", path: "/a" }, " A ")).toBe("id-1");
    expect(intent.accept({ kind: "path", path: "/a" }, "A")).toBe("id-1");
    expect(intent.accept({ kind: "git", gitUrl: "https://host/r" }, "A")).toBe("id-2");
    expect(intent.accept({ kind: "git", gitUrl: "https://host/r" }, "B")).toBe("id-3");
    intent.edited();
    expect(intent.accept({ kind: "git", gitUrl: "https://host/r" }, "B")).toBe("id-4");
    expect(createProjectIntent().accept({ kind: "path", path: "/a" }, "")).toMatch(
      /^[a-f0-9-]{36}$/u,
    );
  });
  it.each([
    "invalid-source",
    "path-unreadable",
    "target-exists",
    "clone-timeout",
    "registration-failed",
    "still-running",
    "interrupted",
    "capacity",
  ] as const)("keeps %s as a visible refusal, without sudo", (code) => {
    expect(failureRecovery({ code, message: "failure", command: null }, "box", 0)).toEqual({
      kind: "retry",
    });
  });
});
