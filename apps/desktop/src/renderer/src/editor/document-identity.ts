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
  bash: "shell",
  c: "c",
  cc: "cpp",
  cjs: "javascript",
  cpp: "cpp",
  cs: "csharp",
  css: "css",
  cts: "typescript",
  cxx: "cpp",
  go: "go",
  gql: "graphql",
  graphql: "graphql",
  h: "c",
  hpp: "cpp",
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
  markdown: "markdown",
  md: "markdown",
  mjs: "javascript",
  mts: "typescript",
  php: "php",
  properties: "properties",
  py: "python",
  rb: "ruby",
  rs: "rust",
  scss: "scss",
  sh: "shell",
  sql: "sql",
  svg: "xml",
  swift: "swift",
  toml: "toml",
  ts: "typescript",
  tsx: "typescript",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  zsh: "shell",
};

function languageForPath(relPath: string): string {
  const name = relPath.slice(relPath.lastIndexOf("/") + 1).toLowerCase();
  if (name === "makefile" || name.startsWith("makefile.")) return "makefile";
  if (name === "dockerfile" || name.startsWith("dockerfile.")) return "dockerfile";
  if (name === "cmakelists.txt") return "cmake";
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "plaintext";
  return EXTENSION_LANGUAGES[name.slice(dot + 1)] ?? "plaintext";
}

/** Monaco language id for the canonical document role/path, with plaintext fallback. */
export function detectDocumentLanguage(identity: DocumentIdentity): string {
  if (identity.kind === "ticket-body") return "markdown";
  return languageForPath(identity.relPath);
}
