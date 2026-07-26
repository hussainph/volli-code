import { describe, expect, it } from "vite-plus/test";

import { detectDocumentLanguage, type DocumentIdentity } from "./document-identity";
import { shikiLangImportFor } from "./shiki-langs";

const mainFile = (relPath: string): DocumentIdentity => ({
  kind: "file",
  projectId: "project-1",
  checkout: { kind: "main" },
  relPath,
});

/** One path per Monaco language id that document-identity can produce. */
const DOCUMENT_LANGUAGE_FIXTURES: ReadonlyArray<{ relPath: string; language: string }> = [
  { relPath: "scripts/run.sh", language: "shell" },
  { relPath: "src/main.c", language: "c" },
  { relPath: "src/main.cpp", language: "cpp" },
  { relPath: "src/app.js", language: "javascript" },
  { relPath: "src/App.cs", language: "csharp" },
  { relPath: "styles/app.css", language: "css" },
  { relPath: "src/index.ts", language: "typescript" },
  { relPath: "cmd/main.go", language: "go" },
  { relPath: "schema.graphql", language: "graphql" },
  { relPath: "index.html", language: "html" },
  { relPath: "config.ini", language: "ini" },
  { relPath: "Main.java", language: "java" },
  { relPath: "package.json", language: "json" },
  { relPath: "Main.kt", language: "kotlin" },
  { relPath: "styles/app.less", language: "less" },
  { relPath: "README.md", language: "markdown" },
  { relPath: "index.php", language: "php" },
  { relPath: "app.properties", language: "properties" },
  { relPath: "main.py", language: "python" },
  { relPath: "app.rb", language: "ruby" },
  { relPath: "src/main.rs", language: "rust" },
  { relPath: "styles/app.scss", language: "scss" },
  { relPath: "query.sql", language: "sql" },
  { relPath: "data.xml", language: "xml" },
  { relPath: "App.swift", language: "swift" },
  { relPath: "Cargo.toml", language: "toml" },
  { relPath: "config.yaml", language: "yaml" },
  { relPath: "Makefile", language: "makefile" },
  { relPath: "Dockerfile", language: "dockerfile" },
  { relPath: "CMakeLists.txt", language: "cmake" },
];

describe("shikiLangImportFor", () => {
  it.each(DOCUMENT_LANGUAGE_FIXTURES)(
    "resolves an importable @shikijs/langs loader for $language ($relPath)",
    async ({ relPath, language }) => {
      expect(detectDocumentLanguage(mainFile(relPath))).toBe(language);

      const load = shikiLangImportFor(language);
      expect(load).not.toBeNull();
      const module = await load!();
      expect(module).toBeTruthy();
    },
  );

  it("returns null for plaintext and unknown language ids", () => {
    expect(detectDocumentLanguage(mainFile("LICENSE"))).toBe("plaintext");
    expect(shikiLangImportFor("plaintext")).toBeNull();
    expect(shikiLangImportFor("not-a-real-language")).toBeNull();
  });
});
