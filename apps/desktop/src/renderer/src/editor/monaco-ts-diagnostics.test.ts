/**
 * What the configuration in `monaco-runtime.ts` actually does to a file (plan
 * §4.2).
 *
 * Every other test of that configuration checks the OPTIONS. This one checks
 * the diagnostics, by running monaco 0.56's own bundled TypeScript service —
 * the exact code its worker runs, imported from the same package the app ships
 * — over models built the way the worker builds them: the open files, the
 * standard library, and nothing else on disk. It is the empirical loop the
 * ignore list was enumerated with, kept, so that a well-meant edit to the
 * options or the codes cannot quietly put the wall of red back.
 *
 * The host below is a faithful port of monaco's `TypeScriptWorker` language
 * service host (`esm/vs/languages/features/typescript/tsWorker.js`): the same
 * script-kind switch on the URI's extension, the same `libFileMap` lookups, the
 * same empty current directory, the same target-derived default lib. One
 * service serves a whole fixture set, for the same reason monaco's worker does
 * — parsing the standard library is the expensive part, and doing it per case
 * costs more than this suite is worth.
 */
import { describe, expect, it } from "vite-plus/test";

// @ts-expect-error - monaco ships its bundled TypeScript service untyped
import * as tsServices from "monaco-editor/languages/features/typescript/lib/typescriptServices.js";
// @ts-expect-error - monaco ships its bundled lib map untyped
import { libFileMap } from "monaco-editor/languages/features/typescript/lib/lib.js";

import {
  typeScriptCompilerOptions,
  UNRESOLVABLE_MODULE_DIAGNOSTIC_CODES,
  type ProjectTypeScriptOptions,
} from "./monaco-runtime";

/* eslint-disable typescript/no-explicit-any -- the bundled service is untyped */
const ts = tsServices as any;
const libs = libFileMap as Record<string, string>;

interface Diagnostic {
  code: number;
  messageText: string | { messageText: string };
}

/** Model URIs are what the registry builds; the worker reads the extension off the end. */
const modelUri = (relPath: string) => `volli-document://file/p1/main/${relPath}`;

/**
 * A worker over one set of open models, checked under one project's options.
 * Returns the diagnostics monaco would paint: syntactic plus semantic, minus
 * the ignore list its `DiagnosticsAdapter` filters out before it sets markers.
 */
function workerOver(files: Record<string, string>, project: ProjectTypeScriptOptions) {
  const compilerOptions = typeScriptCompilerOptions(project) as Record<string, any>;
  const models = Object.fromEntries(
    Object.entries(files).map(([relPath, text]) => [modelUri(relPath), text]),
  );
  const scriptText = (name: string): string | undefined =>
    models[name] ?? libs[name] ?? libs[`lib.${name}.d.ts`];
  const service = ts.createLanguageService({
    getCompilationSettings: () => compilerOptions,
    getScriptFileNames: () => Object.keys(models),
    getScriptVersion: () => "1",
    getScriptKind: (name: string) => {
      const suffix = name.slice(name.lastIndexOf(".") + 1);
      if (suffix === "ts") return ts.ScriptKind.TS;
      if (suffix === "tsx") return ts.ScriptKind.TSX;
      if (suffix === "js") return ts.ScriptKind.JS;
      if (suffix === "jsx") return ts.ScriptKind.JSX;
      return compilerOptions["allowJs"] ? ts.ScriptKind.JS : ts.ScriptKind.TS;
    },
    getScriptSnapshot: (name: string) => {
      const value = scriptText(name);
      if (value === undefined) return undefined;
      return {
        getText: (start: number, end: number) => value.substring(start, end),
        getLength: () => value.length,
        getChangeRange: () => undefined,
      };
    },
    getCurrentDirectory: () => "",
    getDefaultLibFileName: (options: { target?: number }) => {
      const target = options.target ?? 99;
      if (target === 99 && "lib.esnext.full.d.ts" in libs) return "lib.esnext.full.d.ts";
      const named = `lib.es${2013 + target}.full.d.ts`;
      return named in libs ? named : "lib.es6.d.ts";
    },
    readFile: scriptText,
    fileExists: (name: string) => scriptText(name) !== undefined,
  });
  return (relPath: string): { code: number; message: string }[] => {
    const uri = modelUri(relPath);
    return [
      ...(service.getSyntacticDiagnostics(uri) as Diagnostic[]),
      ...(service.getSemanticDiagnostics(uri) as Diagnostic[]),
    ]
      .filter((diagnostic) => !UNRESOLVABLE_MODULE_DIAGNOSTIC_CODES.includes(diagnostic.code))
      .map((diagnostic) => ({
        code: diagnostic.code,
        message:
          typeof diagnostic.messageText === "string"
            ? diagnostic.messageText
            : diagnostic.messageText.messageText,
      }));
  };
}

/** How this repository's own configuration reads once the tsconfig walk is done. */
const THIS_REPO: ProjectTypeScriptOptions = { target: "ESNext", strict: true, jsx: "react-jsx" };

/**
 * Building a program means parsing the whole standard library, so the fixtures
 * share one worker per project answer rather than one each — three programs for
 * the file instead of sixteen. The first case through each pays for it, which
 * is why the cases that open one carry their own timeout.
 */
const SLOW = 30_000;

const HEALTHY_AND_WRONG = {
  "src/store.ts":
    `import { errorMessage, type Ticket } from "@volli/shared";\n` +
    `import { useBoardStore } from "./board";\n` +
    `export function label(ticket: Ticket): string {\n` +
    `  try {\n` +
    `    return useBoardStore.getState().title(ticket);\n` +
    `  } catch (error) {\n` +
    `    return errorMessage(error);\n` +
    `  }\n` +
    `}\n`,
  "src/panel.tsx":
    `import * as React from "react";\n` +
    `import { Button } from "@renderer/components/ui/button";\n` +
    `export function Panel({ label }: { label: string }) {\n` +
    `  const [open, setOpen] = React.useState(false);\n` +
    `  return (\n` +
    `    <div className="panel" data-open={open}>\n` +
    `      <Button onClick={() => setOpen(!open)}>{label.toUpperCase()}</Button>\n` +
    `    </div>\n` +
    `  );\n` +
    `}\n`,
  "scripts/build.ts":
    `const config = await import("./config");\n` +
    `const url = import.meta.url;\n` +
    `export const built = { config, url };\n`,
  "src/edits.ts":
    `import { findTextEdits } from "./text-reconciliation";\n` +
    `export function shift(text: string, next: string) {\n` +
    `  return findTextEdits(text, next).map((edit) => edit.start + edit.replacement.length);\n` +
    `}\n`,
  "src/version.ts":
    `import manifest from "../package.json";\n` +
    `import type { Project } from "@volli/shared";\n` +
    `export const version = (manifest as { version: string }).version;\n` +
    `export type Named = Pick<Project, "id">;\n`,
  "scripts/run.ts": `export const root = process.cwd();\nexport const bytes = Buffer.from("x");\n`,
  "src/typo.ts": `const v = { name: "x" };\nexport const n = v.nmae;\n`,
  "src/assign.ts": `const n: number = "no";\nexport { n };\n`,
  "src/arity.ts": `function f(a: number) { return a; }\nexport const r = f(1, 2);\n`,
  "src/undeclared.ts": `export const r = notDeclaredAnywhere + 1;\n`,
  "src/jsx.tsx": `export function A() {\n  const x: { a: number } = { a: 1 };\n  return <div>{x.b}</div>;\n}\n`,
  "src/syntax.ts": `export function broken( {\n`,
  "src/strict.ts": `export function m(v?: string) {\n  return v.length;\n}\n`,
};

/** The same two files again, under a checkout that states no project at all. */
const NO_PROJECT = {
  "scratch.tsx": `import { render } from "some-ui";\nexport const view = <main>{render()}</main>;\n`,
  "src/strict.ts": HEALTHY_AND_WRONG["src/strict.ts"],
};

const underThisRepo = workerOver(HEALTHY_AND_WRONG, THIS_REPO);
const underNoProject = workerOver(NO_PROJECT, {});

describe("a healthy file on a single-file model", () => {
  it.each([
    ["cross-package imports that cannot resolve", "src/store.ts"],
    ["JSX over unresolvable component imports", "src/panel.tsx"],
    ["top-level await, dynamic import and import.meta", "scripts/build.ts"],
    ["callbacks over values that come from unresolved modules", "src/edits.ts"],
    ["a JSON import and a type-only import", "src/version.ts"],
    ["globals that only an @types package could provide", "scripts/run.ts"],
  ])(
    "reports nothing for %s",
    (_case, relPath) => {
      expect(underThisRepo(relPath)).toEqual([]);
    },
    SLOW,
  );

  it(
    "reports nothing for a project with no tsconfig at all",
    () => {
      expect(underNoProject("scratch.tsx")).toEqual([]);
    },
    SLOW,
  );
});

describe("a file that is genuinely wrong", () => {
  it.each([
    ["a mistyped property", "src/typo.ts", 2339],
    ["a wrong assignment", "src/assign.ts", 2322],
    ["a bad call arity", "src/arity.ts", 2554],
    ["an undeclared name", "src/undeclared.ts", 2304],
    ["a missing property on a JSX-built object", "src/jsx.tsx", 2339],
    // Syntax validation stays on everywhere: a missing brace is true about the
    // file no matter what else the worker cannot see.
    ["a syntax error", "src/syntax.ts", 1005],
    // The project's `strict` is adopted, so what it turned on keeps reporting.
    ["what the project's strict mode turned on", "src/strict.ts", 18048],
  ])(
    "still reports %s",
    (_case, relPath, code) => {
      expect(underThisRepo(relPath)).toContainEqual(expect.objectContaining({ code }));
    },
    SLOW,
  );

  it(
    "does not invent strictness the project never asked for",
    () => {
      expect(underNoProject("src/strict.ts")).toEqual([]);
    },
    SLOW,
  );
});

describe("what the configuration is worth", () => {
  const relPath = "src/panel.tsx";
  const text = HEALTHY_AND_WRONG[relPath];

  /**
   * The same file monaco checks with its stock options, for the size of the lie
   * being removed: unresolved modules, `--jsx` not set, and the implicit-`any`
   * cascade that follows from both.
   */
  it(
    "turns monaco's unconfigured wall of red into silence",
    () => {
      const uri = modelUri(relPath);
      const service = ts.createLanguageService({
        getCompilationSettings: () => ({ allowNonTsExtensions: true, target: 99 }),
        getScriptFileNames: () => [uri],
        getScriptVersion: () => "1",
        getScriptKind: () => ts.ScriptKind.TSX,
        getScriptSnapshot: (name: string) => {
          const value = name === uri ? text : libs[name];
          if (value === undefined) return undefined;
          return {
            getText: (start: number, end: number) => value.substring(start, end),
            getLength: () => value.length,
            getChangeRange: () => undefined,
          };
        },
        getCurrentDirectory: () => "",
        getDefaultLibFileName: () => "lib.esnext.full.d.ts",
        readFile: (name: string) => libs[name],
        fileExists: (name: string) => name === uri || name in libs,
      });
      const unconfigured = service.getSemanticDiagnostics(uri) as Diagnostic[];

      expect(unconfigured.map((diagnostic) => diagnostic.code)).toEqual(
        expect.arrayContaining([
          2792, // Cannot find module '@renderer/components/ui/button'.
          17004, // Cannot use JSX unless the '--jsx' flag is provided.
        ]),
      );
      expect(underThisRepo(relPath)).toEqual([]);
    },
    SLOW,
  );
});
