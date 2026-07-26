import type { LanguageInput } from "shiki";

/**
 * Static ES-module importer for a Monaco language id.
 * Bundler resolves `@shikijs/langs/<id>` at build time — no runtime network fetch.
 */
export type ShikiLangImporter = () => Promise<LanguageInput>;

/**
 * Monaco language ids produced by `detectDocumentLanguage` that have a matching
 * `@shikijs/langs` grammar. Plaintext has no grammar entry.
 */
const SHIKI_LANG_IMPORTS: Readonly<Record<string, ShikiLangImporter>> = {
  shell: () => import("@shikijs/langs/shell"),
  c: () => import("@shikijs/langs/c"),
  cpp: () => import("@shikijs/langs/cpp"),
  javascript: () => import("@shikijs/langs/javascript"),
  csharp: () => import("@shikijs/langs/csharp"),
  css: () => import("@shikijs/langs/css"),
  typescript: () => import("@shikijs/langs/typescript"),
  go: () => import("@shikijs/langs/go"),
  graphql: () => import("@shikijs/langs/graphql"),
  html: () => import("@shikijs/langs/html"),
  ini: () => import("@shikijs/langs/ini"),
  java: () => import("@shikijs/langs/java"),
  json: () => import("@shikijs/langs/json"),
  kotlin: () => import("@shikijs/langs/kotlin"),
  less: () => import("@shikijs/langs/less"),
  markdown: () => import("@shikijs/langs/markdown"),
  php: () => import("@shikijs/langs/php"),
  properties: () => import("@shikijs/langs/properties"),
  python: () => import("@shikijs/langs/python"),
  ruby: () => import("@shikijs/langs/ruby"),
  rust: () => import("@shikijs/langs/rust"),
  scss: () => import("@shikijs/langs/scss"),
  sql: () => import("@shikijs/langs/sql"),
  xml: () => import("@shikijs/langs/xml"),
  swift: () => import("@shikijs/langs/swift"),
  toml: () => import("@shikijs/langs/toml"),
  yaml: () => import("@shikijs/langs/yaml"),
  makefile: () => import("@shikijs/langs/makefile"),
  dockerfile: () => import("@shikijs/langs/dockerfile"),
  cmake: () => import("@shikijs/langs/cmake"),
};

/**
 * Returns a static importer for the TextMate grammar matching a Monaco language
 * id, or `null` when there is no grammar (plaintext / unknown).
 */
export function shikiLangImportFor(monacoLanguageId: string): ShikiLangImporter | null {
  return SHIKI_LANG_IMPORTS[monacoLanguageId] ?? null;
}
