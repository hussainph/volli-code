import type { FileSource } from "@volli/shared";

export type DocumentIdentity =
  | {
      kind: "file";
      projectId: string;
      checkout: { kind: "main" } | { kind: "ticket"; ticketId: string };
      relPath: string;
    }
  | { kind: "ticket-body"; projectId: string; ticketId: string }
  | {
      kind: "diff-base";
      projectId: string;
      ticketId: string;
      baseRevision: string;
      relPath: string;
    };

export interface FileDocumentInput {
  projectId: string;
  ticketId?: string;
  relPath: string;
  source: FileSource;
}

/**
 * Builds identity from main's resolved source, never from the request context.
 * A ticket request can still resolve to Main (notably `.volli/**` and tickets
 * without a materialized worktree), and those views must share the Main model.
 */
export function fileDocumentIdentity(input: FileDocumentInput): DocumentIdentity {
  if (input.source === "main") {
    return {
      kind: "file",
      projectId: input.projectId,
      checkout: { kind: "main" },
      relPath: input.relPath,
    };
  }
  if (input.ticketId === undefined) {
    throw new Error("A worktree document requires a ticket id");
  }
  return {
    kind: "file",
    projectId: input.projectId,
    checkout: { kind: "ticket", ticketId: input.ticketId },
    relPath: input.relPath,
  };
}

const DOCUMENT_SCHEME = "volli-document";

function segment(value: string): string {
  return encodeURIComponent(value);
}

function pathSegments(relPath: string): string {
  return relPath.split("/").map(segment).join("/");
}

/** Stable, collision-free URI used as both the registry key and Monaco model URI. */
export function documentUri(identity: DocumentIdentity): string {
  if (identity.kind === "ticket-body") {
    return `${DOCUMENT_SCHEME}://ticket-body/${segment(identity.projectId)}/${segment(identity.ticketId)}/body.md`;
  }
  if (identity.kind === "diff-base") {
    return `${DOCUMENT_SCHEME}://diff-base/${segment(identity.projectId)}/${segment(identity.ticketId)}/${segment(identity.baseRevision)}/${pathSegments(identity.relPath)}`;
  }
  const checkout =
    identity.checkout.kind === "main" ? "main" : `ticket/${segment(identity.checkout.ticketId)}`;
  return `${DOCUMENT_SCHEME}://file/${segment(identity.projectId)}/${checkout}/${pathSegments(identity.relPath)}`;
}

export function documentIdentityKey(identity: DocumentIdentity): string {
  return documentUri(identity);
}

const EXTENSION_LANGUAGES: Readonly<Record<string, string>> = {
  astro: "astro",
  bash: "shell",
  bat: "bat",
  c: "c",
  cc: "cpp",
  cjs: "javascript",
  clj: "clojure",
  cljc: "clojure",
  cljs: "clojure",
  cmd: "bat",
  cpp: "cpp",
  cs: "csharp",
  css: "css",
  cts: "typescript",
  cxx: "cpp",
  dart: "dart",
  diff: "diff",
  edn: "clojure",
  erb: "erb",
  ex: "elixir",
  exs: "elixir",
  // Rubygems specs, Rake tasks, Rack configs (`.ru`) and Sorbet stubs (`.rbi`)
  // are Ruby source to every tool that reads them, and to anyone typing in one.
  gemspec: "ruby",
  go: "go",
  gql: "graphql",
  gradle: "groovy",
  graphql: "graphql",
  groovy: "groovy",
  h: "c",
  hcl: "hcl",
  hpp: "cpp",
  hs: "haskell",
  htm: "html",
  html: "html",
  ini: "ini",
  java: "java",
  js: "javascript",
  json: "json",
  jsonc: "json",
  jsx: "javascript",
  kt: "kotlin",
  kts: "kotlin",
  less: "less",
  liquid: "liquid",
  lua: "lua",
  // `.m` is Objective-C, not MATLAB: this is a macOS product and the grammar
  // pair (`.m` / `.mm`) follows VS Code's own association.
  m: "objective-c",
  markdown: "markdown",
  md: "markdown",
  mjs: "javascript",
  ml: "ocaml",
  mli: "ocaml",
  mm: "objective-cpp",
  mts: "typescript",
  nix: "nix",
  patch: "diff",
  php: "php",
  pl: "perl",
  pm: "perl",
  properties: "properties",
  proto: "proto",
  ps1: "powershell",
  psd1: "powershell",
  psm1: "powershell",
  py: "python",
  // Type stubs and the Windows launcher's extension are Python source to every
  // tool that reads them, and to anyone typing in one.
  pyi: "python",
  pyw: "python",
  // Lower-cased before lookup, so R's conventional `.R` lands here too.
  r: "r",
  rake: "ruby",
  rb: "ruby",
  rbi: "ruby",
  rs: "rust",
  ru: "ruby",
  sbt: "scala",
  sc: "scala",
  scala: "scala",
  scss: "scss",
  sh: "shell",
  sql: "sql",
  svelte: "svelte",
  svg: "xml",
  swift: "swift",
  // Terraform has its own grammar, separate from generic HCL.
  tf: "terraform",
  tfvars: "terraform",
  toml: "toml",
  ts: "typescript",
  tsx: "typescript",
  vue: "vue",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  zig: "zig",
  zsh: "shell",
};

/**
 * Dotfiles by exact name. A dotfile's only dot is its first character, so the
 * extension lookup below never sees one; these are the ones with a grammar
 * that fits. The ignore files (`.gitignore`, `.dockerignore`, `.npmignore`,
 * `.prettierignore`) are deliberately NOT here: shiki has no ignore-file
 * grammar, and INI — the nearest-looking one — paints a `[Bb]uild/` pattern as
 * a section header. Plaintext is the honest answer for them.
 */
const DOTFILE_LANGUAGES: Readonly<Record<string, string>> = {
  ".editorconfig": "ini",
  ".gitconfig": "ini",
  ".gitmodules": "ini",
  ".npmrc": "ini",
  ".bashrc": "shell",
  ".bash_profile": "shell",
  ".bash_aliases": "shell",
  ".profile": "shell",
  ".zshrc": "shell",
  ".zprofile": "shell",
  ".zshenv": "shell",
};

/**
 * Language id for a path, by filename rule and then by extension, with
 * plaintext fallback. This is the ONE table for "what is this file": the
 * editor asks it through {@link detectDocumentLanguage}, and chat asks it
 * directly to colour tool output under a Read, Edit or Write row (VC-125).
 * Neither side keeps a copy.
 */
export function languageForPath(relPath: string): string {
  const name = relPath.slice(relPath.lastIndexOf("/") + 1).toLowerCase();
  if (name === "makefile" || name.startsWith("makefile.")) return "makefile";
  if (name === "dockerfile" || name.startsWith("dockerfile.")) return "dockerfile";
  if (name === "cmakelists.txt") return "cmake";
  // Exact names only — no `startsWith` twin like Makefile's: `Gemfile.lock` is
  // Bundler's generated lockfile, its own format and not Ruby.
  if (name === "gemfile" || name === "rakefile") return "ruby";
  // `.env` and every `.env.<stage>` variant — the suffix names the stage, not
  // the format.
  if (name === ".env" || name.startsWith(".env.")) return "dotenv";
  const dotfile = DOTFILE_LANGUAGES[name];
  if (dotfile !== undefined) return dotfile;
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "plaintext";
  return EXTENSION_LANGUAGES[name.slice(dot + 1)] ?? "plaintext";
}

/**
 * Interpreter word on a `#!` line → language id. VS Code's first-line rules,
 * for the interpreters whose grammar is in the catalog. Matched anywhere on the
 * line, so `#!/usr/bin/env -S node --flags` still reads as node; a version
 * suffix (`python3`, `python2.7`) is allowed on python alone, where it is the
 * convention.
 */
const SHEBANG_LANGUAGES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(?:bash|sh|zsh|ksh|dash|fish)\b/, "shell"],
  [/\bpython(?:[\d.]*)\b/, "python"],
  [/\bnode\b/, "javascript"],
  [/\bruby\b/, "ruby"],
  [/\bpwsh\b/, "powershell"],
  [/\bperl\b/, "perl"],
];

/**
 * Language named by a script's first line, or `null` when line 1 is not a
 * shebang or names an interpreter with no grammar here. Reads line 1 only.
 */
function languageForShebang(content: string): string | null {
  if (!content.startsWith("#!")) return null;
  const newline = content.indexOf("\n");
  const line = newline === -1 ? content : content.slice(0, newline);
  for (const [pattern, language] of SHEBANG_LANGUAGES) {
    if (pattern.test(line)) return language;
  }
  return null;
}

/**
 * Monaco language id for the canonical document role/path, with plaintext
 * fallback.
 *
 * `content` is the file's text at open, and it only speaks when the path was
 * silent: a script with no extension says what it is on its `#!` line, and
 * that is the one place the text gets a vote. A path that already named a
 * language keeps it whatever line 1 says. Sniffed once, at open — callers do
 * not re-run this as the user types.
 */
export function detectDocumentLanguage(identity: DocumentIdentity, content?: string): string {
  if (identity.kind === "ticket-body") return "markdown";
  const fromPath = languageForPath(identity.relPath);
  if (fromPath !== "plaintext" || content === undefined) return fromPath;
  return languageForShebang(content) ?? "plaintext";
}
