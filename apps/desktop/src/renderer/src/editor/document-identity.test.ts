import { describe, expect, it } from "vite-plus/test";

import {
  detectDocumentLanguage,
  documentIdentityKey,
  documentUri,
  fileDocumentIdentity,
  type DocumentIdentity,
} from "./document-identity";

const mainFile: DocumentIdentity = {
  kind: "file",
  projectId: "project-1",
  checkout: { kind: "main" },
  relPath: "src/index.ts",
};

describe("documentUri", () => {
  it("is deterministic and keeps the relative-path extension visible to language services", () => {
    expect(documentUri(mainFile)).toBe(documentUri({ ...mainFile }));
    expect(documentUri(mainFile)).toMatch(/^volli-document:\/\/file\//);
    expect(documentUri(mainFile)).toMatch(/\/src\/index\.ts$/);
    expect(documentIdentityKey(mainFile)).toBe(documentUri(mainFile));
  });

  it("separates Main-checkout and ticket-worktree copies of the same path", () => {
    const ticketFile: DocumentIdentity = {
      ...mainFile,
      checkout: { kind: "ticket", ticketId: "ticket-1" },
    };
    expect(documentUri(ticketFile)).not.toBe(documentUri(mainFile));
  });

  it("shares one identity for multiple views of the same logical ticket file", () => {
    const first: DocumentIdentity = {
      kind: "file",
      projectId: "project-1",
      checkout: { kind: "ticket", ticketId: "ticket-1" },
      relPath: "src/index.ts",
    };
    const second: DocumentIdentity = {
      kind: "file",
      projectId: "project-1",
      checkout: { kind: "ticket", ticketId: "ticket-1" },
      relPath: "src/index.ts",
    };
    expect(documentUri(first)).toBe(documentUri(second));
  });

  it("separates projects, ticket bodies, and immutable diff revisions", () => {
    expect(documentUri({ ...mainFile, projectId: "project-2" })).not.toBe(documentUri(mainFile));

    const bodyA: DocumentIdentity = {
      kind: "ticket-body",
      projectId: "project-1",
      ticketId: "ticket-1",
    };
    const bodyB: DocumentIdentity = { ...bodyA, ticketId: "ticket-2" };
    expect(documentUri(bodyA)).not.toBe(documentUri(bodyB));

    const baseA: DocumentIdentity = {
      kind: "diff-base",
      projectId: "project-1",
      ticketId: "ticket-1",
      baseRevision: "abc123",
      relPath: "src/index.ts",
    };
    const baseB: DocumentIdentity = { ...baseA, baseRevision: "def456" };
    expect(documentUri(baseA)).not.toBe(documentUri(baseB));
    expect(documentUri(baseA)).not.toBe(documentUri(mainFile));
  });

  it("encodes identity segments so separators inside record ids cannot collide", () => {
    const slashId: DocumentIdentity = {
      kind: "ticket-body",
      projectId: "project/one",
      ticketId: "ticket one",
    };
    const separateSegments: DocumentIdentity = {
      kind: "ticket-body",
      projectId: "project",
      ticketId: "one/ticket one",
    };
    expect(documentUri(slashId)).not.toBe(documentUri(separateSegments));
    expect(documentUri(slashId)).toContain("project%2Fone");
    expect(documentUri(slashId)).toContain("ticket%20one");
  });
});

describe("fileDocumentIdentity", () => {
  it("uses the resolved Main source even when the file was requested from a ticket", () => {
    const identity = fileDocumentIdentity({
      projectId: "project-1",
      ticketId: "ticket-1",
      relPath: ".volli/artifacts/plan.md",
      source: "main",
    });
    expect(identity).toEqual({
      kind: "file",
      projectId: "project-1",
      checkout: { kind: "main" },
      relPath: ".volli/artifacts/plan.md",
    });
  });

  it("shares a Main model across different ticket request contexts", () => {
    const first = fileDocumentIdentity({
      projectId: "project-1",
      ticketId: "ticket-1",
      relPath: "src/index.ts",
      source: "main",
    });
    const second = fileDocumentIdentity({
      projectId: "project-1",
      ticketId: "ticket-2",
      relPath: "src/index.ts",
      source: "main",
    });
    expect(documentUri(first)).toBe(documentUri(second));
  });

  it("uses the permanent ticket id only for a resolved worktree source", () => {
    const identity = fileDocumentIdentity({
      projectId: "project-1",
      ticketId: "ticket-1",
      relPath: "src/index.ts",
      source: "worktree",
    });
    expect(identity).toEqual({
      kind: "file",
      projectId: "project-1",
      checkout: { kind: "ticket", ticketId: "ticket-1" },
      relPath: "src/index.ts",
    });
    expect(documentUri(identity)).not.toBe(documentUri(mainFile));
  });

  it("rejects an impossible worktree source without a ticket identity", () => {
    expect(() =>
      fileDocumentIdentity({
        projectId: "project-1",
        relPath: "src/index.ts",
        source: "worktree",
      }),
    ).toThrow("ticket id");
  });
});

describe("detectDocumentLanguage", () => {
  it("selects Markdown for Ticket Bodies", () => {
    expect(
      detectDocumentLanguage({
        kind: "ticket-body",
        projectId: "project-1",
        ticketId: "ticket-1",
      }),
    ).toBe("markdown");
  });

  it.each([
    ["src/index.ts", "typescript"],
    ["src/Component.TSX", "typescript"],
    ["scripts/task.mjs", "javascript"],
    ["package.json", "json"],
    ["styles/app.scss", "scss"],
    ["templates/index.html", "html"],
    ["config/app.yaml", "yaml"],
    ["Dockerfile", "dockerfile"],
    ["Makefile", "makefile"],
    ["CMakeLists.txt", "cmake"],
    // Every Python extension someone might hand-write in, not just `.py` —
    // a stub file that came up plaintext would lose highlighting AND the
    // colon/indent rules Monaco's python configuration brings with the id.
    ["models/train.py", "python"],
    ["typings/train.pyi", "python"],
    ["scripts/launch.PYW", "python"],
    // The Ruby surface of a Rails-shaped repo: templates, the DSL family, and
    // the two canonical extensionless names — while Bundler's generated
    // lockfile keeps its own non-Ruby format.
    ["app/views/orders/show.html.erb", "erb"],
    ["sections/product.liquid", "liquid"],
    ["lib/tasks/db.rake", "ruby"],
    ["sorbet/rbi/gems/rails.rbi", "ruby"],
    ["config.ru", "ruby"],
    ["volli.gemspec", "ruby"],
    ["Gemfile", "ruby"],
    ["Rakefile", "ruby"],
    ["Gemfile.lock", "plaintext"],
    // The VC-125 gap fill: component frameworks, the macOS-native pair, diffs,
    // infra and config languages, and the long tail of general-purpose ones.
    ["src/App.vue", "vue"],
    ["src/App.svelte", "svelte"],
    ["src/pages/index.astro", "astro"],
    ["Sources/AppDelegate.m", "objective-c"],
    ["Sources/Bridge.mm", "objective-cpp"],
    ["fix.diff", "diff"],
    ["0001-fix.patch", "diff"],
    ["config.hcl", "hcl"],
    ["main.tf", "terraform"],
    ["prod.tfvars", "terraform"],
    ["api/v1/service.proto", "proto"],
    ["init.lua", "lua"],
    ["Main.scala", "scala"],
    ["script.sc", "scala"],
    ["build.sbt", "scala"],
    ["lib/main.dart", "dart"],
    ["lib/app.ex", "elixir"],
    ["test/app_test.exs", "elixir"],
    ["src/Main.hs", "haskell"],
    ["lib/parser.ml", "ocaml"],
    ["lib/parser.mli", "ocaml"],
    ["src/main.zig", "zig"],
    ["scripts/build.ps1", "powershell"],
    ["modules/Util.psm1", "powershell"],
    ["modules/Util.psd1", "powershell"],
    ["analysis/model.r", "r"],
    // Paths are lower-cased before the lookup, so R's conventional capital works.
    ["analysis/model.R", "r"],
    ["src/core.clj", "clojure"],
    ["src/ui.cljs", "clojure"],
    ["src/shared.cljc", "clojure"],
    ["deps.edn", "clojure"],
    ["build.groovy", "groovy"],
    ["build.gradle", "groovy"],
    ["scripts/deploy.pl", "perl"],
    ["lib/Util.pm", "perl"],
    ["scripts/build.bat", "bat"],
    ["scripts/build.cmd", "bat"],
    ["flake.nix", "nix"],
  ])("selects %s as %s", (relPath, expected) => {
    expect(detectDocumentLanguage({ ...mainFile, relPath })).toBe(expected);
  });

  // A dotfile's only dot is its first character, so the extension lookup sees
  // nothing. These are exact-name rules for the ones with a real grammar. The
  // ignore files are deliberately absent: they have no grammar, and INI paints
  // a `[Bb]uild/` pattern as a section header.
  it.each([
    [".env", "dotenv"],
    [".env.local", "dotenv"],
    [".env.production", "dotenv"],
    ["apps/desktop/.env.example", "dotenv"],
    [".editorconfig", "ini"],
    [".gitconfig", "ini"],
    [".gitmodules", "ini"],
    [".npmrc", "ini"],
    [".bashrc", "shell"],
    [".bash_profile", "shell"],
    [".bash_aliases", "shell"],
    [".profile", "shell"],
    [".zshrc", "shell"],
    [".zprofile", "shell"],
    [".zshenv", "shell"],
    [".gitignore", "plaintext"],
    [".dockerignore", "plaintext"],
    [".npmignore", "plaintext"],
    [".prettierignore", "plaintext"],
  ])("selects dotfile %s as %s", (relPath, expected) => {
    expect(detectDocumentLanguage({ ...mainFile, relPath })).toBe(expected);
  });

  // Scripts with no extension say what they are on line 1. Same first-line
  // rules VS Code applies; the interpreter word may sit anywhere on the line so
  // `env -S node --flags` still reads as node.
  it.each([
    ["#!/bin/bash\necho hi\n", "shell"],
    // A valid one-line script need not end with a newline.
    ["#!/bin/sh", "shell"],
    ["#!/bin/sh\n", "shell"],
    ["#!/usr/bin/env zsh\n", "shell"],
    ["#!/bin/ksh\n", "shell"],
    ["#!/bin/dash\n", "shell"],
    ["#!/usr/bin/env fish\n", "shell"],
    ["#!/usr/bin/env python3\nprint(1)\n", "python"],
    ["#!/usr/bin/python2.7\n", "python"],
    ["#!/usr/bin/env node\n", "javascript"],
    ["#!/usr/bin/env -S node --enable-source-maps\n", "javascript"],
    ["#!/usr/bin/env ruby\n", "ruby"],
    ["#!/usr/bin/env pwsh\n", "powershell"],
    ["#!/usr/bin/perl -w\n", "perl"],
    // Not a shebang, or one nobody has a grammar for: plain text, as before.
    ["echo hi\n#!/bin/bash\n", "plaintext"],
    ["# a comment, not a shebang\n", "plaintext"],
    ["#!/usr/bin/env lolcode\n", "plaintext"],
    ["", "plaintext"],
  ])("sniffs an extensionless script starting %j as %s", (content, expected) => {
    expect(detectDocumentLanguage({ ...mainFile, relPath: "bin/run" }, content)).toBe(expected);
  });

  it("lets the path win over the first line whenever the path knows the language", () => {
    // A `.py` file that happens to start `#!/usr/bin/env node` is still Python
    // to the tools that will run it, and to the person editing it.
    expect(
      detectDocumentLanguage({ ...mainFile, relPath: "tool.py" }, "#!/usr/bin/env node\n"),
    ).toBe("python");
    // And the Ticket Body never sniffs — it is Markdown by role.
    expect(
      detectDocumentLanguage(
        { kind: "ticket-body", projectId: "project-1", ticketId: "ticket-1" },
        "#!/bin/bash\n",
      ),
    ).toBe("markdown");
  });

  it("uses the diff path and falls back to plaintext for unknown files", () => {
    expect(
      detectDocumentLanguage({
        kind: "diff-base",
        projectId: "project-1",
        ticketId: "ticket-1",
        baseRevision: "abc123",
        relPath: "src/main.rs",
      }),
    ).toBe("rust");
    expect(detectDocumentLanguage({ ...mainFile, relPath: "fixtures/data.unknown" })).toBe(
      "plaintext",
    );
    expect(detectDocumentLanguage({ ...mainFile, relPath: "LICENSE" })).toBe("plaintext");
  });
});
