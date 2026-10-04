#!/usr/bin/env node
/**
 * Keep Electron out of workspace packages and the Linux host app.
 *
 *   node scripts/check-host-electron-imports.mjs             # gate packages/* and apps/hostd
 *   node scripts/check-host-electron-imports.mjs --self-test # scanner + failing CLI fixture
 *   node scripts/check-host-electron-imports.mjs --report    # inventory main-process reachability
 *
 * TypeScript 7 no longer exposes its compiler/parser API. This intentionally
 * uses a small lexer for import syntax instead of adding a parser dependency;
 * comments, quoted strings, regex literals and template raw text are opaque.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  globSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = realpathSync(resolve(HERE, ".."));
const FIXTURE_ROOT = resolve(HERE, "fixtures/host-electron-imports");
const SOURCE_GLOB = "**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}";
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const IGNORE_GLOBS = [
  "**/node_modules/**",
  "**/dist/**",
  "**/dist-electron/**",
  "**/out/**",
  "**/coverage/**",
  "**/.git/**",
];
const ASSET_EXTENSIONS = new Set([
  ".avif",
  ".bmp",
  ".css",
  ".csv",
  ".db",
  ".gif",
  ".graphql",
  ".gql",
  ".html",
  ".ico",
  ".icns",
  ".jpeg",
  ".jpg",
  ".json",
  ".md",
  ".mp3",
  ".mp4",
  ".otf",
  ".pdf",
  ".png",
  ".scss",
  ".sass",
  ".sql",
  ".svg",
  ".toml",
  ".txt",
  ".wasm",
  ".webp",
  ".woff",
  ".woff2",
  ".yaml",
  ".yml",
]);
const JS_TO_TS = new Map([
  [".js", [".ts", ".tsx", ".d.ts", ".js", ".jsx"]],
  [".jsx", [".tsx", ".jsx"]],
  [".mjs", [".mts", ".mjs"]],
  [".cjs", [".cts", ".cjs"]],
]);

function fail(message) {
  throw new Error(message);
}

function repoRelative(repoRoot, filePath) {
  return relative(repoRoot, filePath).split(sep).join("/") || ".";
}

function withinRoot(root, target) {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..");
}

function sourceFilesBelow(repoRoot, rootRelative, { required = true } = {}) {
  const root = resolve(repoRoot, rootRelative);
  if (!existsSync(root)) {
    if (required) fail(`required source root is missing: ${rootRelative}`);
    return [];
  }
  if (!statSync(root).isDirectory()) fail(`source root is not a directory: ${rootRelative}`);

  const files = [];
  for (const match of globSync(SOURCE_GLOB, { cwd: root, exclude: IGNORE_GLOBS })) {
    const filePath = resolve(root, match);
    if (!statSync(filePath).isFile()) continue;
    const physicalPath = realpathSync(filePath);
    if (!withinRoot(repoRoot, physicalPath)) {
      fail(`source file resolves outside the repository: ${repoRelative(repoRoot, filePath)}`);
    }
    files.push(physicalPath);
  }
  return files.toSorted();
}

function enumerateGuardFiles(repoRoot) {
  const files = [
    ...sourceFilesBelow(repoRoot, "packages"),
    // hostd joins the boundary when its package appears; it does not exist in M0.
    ...sourceFilesBelow(repoRoot, "apps/hostd", { required: false }),
  ];
  const unique = [...new Set(files)].toSorted();
  if (unique.length === 0) fail("no source files found under packages/ or apps/hostd");
  return unique;
}

function lineStartsFor(source) {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

function lineAt(starts, offset) {
  let low = 0;
  let high = starts.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (starts[middle] <= offset) low = middle + 1;
    else high = middle;
  }
  return low;
}

function decodeString(raw) {
  let result = "";
  for (let index = 1; index < raw.length - 1; index += 1) {
    const char = raw[index];
    if (char !== "\\") {
      result += char;
      continue;
    }
    index += 1;
    const escaped = raw[index];
    if (escaped === undefined) break;
    const simple = { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", 0: "\0" };
    if (Object.hasOwn(simple, escaped)) {
      result += simple[escaped];
    } else if (escaped === "\n") {
      // JavaScript line continuation.
    } else if (escaped === "\r") {
      if (raw[index + 1] === "\n") index += 1;
    } else if (escaped === "x" && /^[\da-f]{2}$/i.test(raw.slice(index + 1, index + 3))) {
      result += String.fromCodePoint(Number.parseInt(raw.slice(index + 1, index + 3), 16));
      index += 2;
    } else if (escaped === "u" && raw[index + 1] === "{") {
      const end = raw.indexOf("}", index + 2);
      if (end !== -1) {
        const codePoint = Number.parseInt(raw.slice(index + 2, end), 16);
        if (Number.isFinite(codePoint)) result += String.fromCodePoint(codePoint);
        index = end;
      } else result += escaped;
    } else if (escaped === "u" && /^[\da-f]{4}$/i.test(raw.slice(index + 1, index + 5))) {
      result += String.fromCharCode(Number.parseInt(raw.slice(index + 1, index + 5), 16));
      index += 4;
    } else {
      result += escaped;
    }
  }
  return result;
}

const isIdentifierStart = (char) => char !== undefined && /[A-Za-z_$]/.test(char);
const isIdentifierPart = (char) => char !== undefined && /[\w$]/.test(char);

/** Tokenize source while discarding comments and non-code string/template text. */
function tokenize(source) {
  const tokens = [];
  const lineStarts = lineStartsFor(source);
  let offset = 0;

  const add = (kind, value, start, raw = value) => {
    tokens.push({ kind, value, raw, start, line: lineAt(lineStarts, start) });
  };
  const regexAfterWords = new Set([
    "await",
    "case",
    "delete",
    "do",
    "else",
    "in",
    "instanceof",
    "new",
    "of",
    "return",
    "throw",
    "typeof",
    "void",
    "yield",
  ]);
  const regexAfterPunctuation = new Set([
    "(",
    "[",
    "{",
    ",",
    ";",
    ":",
    "=",
    "==",
    "===",
    "!",
    "!=",
    "!==",
    "?",
    "??",
    "&&",
    "||",
    "&",
    "|",
    "^",
    "+",
    "-",
    "*",
    "%",
    "~",
    "<",
    ">",
    "<=",
    ">=",
    "=>",
  ]);

  function regexMayStart() {
    const previous = tokens.at(-1);
    if (!previous) return true;
    if (previous.kind === "punctuation" && previous.value === ")") {
      const controlWords = new Set(["catch", "for", "if", "switch", "while", "with"]);
      let depth = 0;
      for (let index = tokens.length - 1; index >= 0; index -= 1) {
        if (tokens[index].value === ")") depth += 1;
        else if (tokens[index].value === "(" && --depth === 0) {
          return controlWords.has(tokens[index - 1]?.value);
        }
      }
    }
    if (previous.kind === "punctuation" && previous.value === "}") {
      let depth = 0;
      for (let index = tokens.length - 1; index >= 0; index -= 1) {
        if (tokens[index].value === "}") depth += 1;
        else if (tokens[index].value === "{" && --depth === 0) {
          const beforeBlock = tokens[index - 1]?.value;
          if (["else", "finally", "try", "do", "=>"].includes(beforeBlock)) return true;
          if (beforeBlock === ")") {
            let parens = 0;
            for (let open = index - 1; open >= 0; open -= 1) {
              if (tokens[open].value === ")") parens += 1;
              else if (tokens[open].value === "(" && --parens === 0) {
                return ["catch", "for", "if", "switch", "while", "with"].includes(
                  tokens[open - 1]?.value,
                );
              }
            }
          }
          return false;
        }
      }
    }
    return previous.kind === "punctuation"
      ? regexAfterPunctuation.has(previous.value)
      : previous.kind === "identifier" && regexAfterWords.has(previous.value);
  }

  function skipRegex() {
    offset += 1;
    let inCharacterClass = false;
    while (offset < source.length) {
      const char = source[offset];
      if (char === "\\") {
        offset += 2;
      } else if (char === "[") {
        inCharacterClass = true;
        offset += 1;
      } else if (char === "]") {
        inCharacterClass = false;
        offset += 1;
      } else if (char === "/" && !inCharacterClass) {
        offset += 1;
        while (/[A-Za-z]/.test(source[offset] ?? "")) offset += 1;
        return;
      } else if (char === "\n" || char === "\r") {
        return;
      } else {
        offset += 1;
      }
    }
  }

  function skipTemplate() {
    const start = offset;
    let interpolated = false;
    offset += 1;
    while (offset < source.length) {
      if (source[offset] === "\\") {
        offset += 2;
      } else if (source[offset] === "`") {
        offset += 1;
        if (!interpolated) {
          const raw = source.slice(start, offset);
          add("string", decodeString(raw), start, raw);
        } else add("punctuation", "<template-end>", offset);
        return;
      } else if (source[offset] === "$" && source[offset + 1] === "{") {
        // Keep code inside substitutions, but don't mistake it for the outer
        // import's literal argument. Constant backtick arguments ARE literals.
        if (!interpolated) add("punctuation", "<template>", start);
        interpolated = true;
        offset += 2;
        scanCode(true);
      } else {
        offset += 1;
      }
    }
  }

  function scanCode(stopAtTemplateBrace = false) {
    let nestedBraces = 0;
    while (offset < source.length) {
      const char = source[offset];
      if (/\s/.test(char)) {
        offset += 1;
      } else if (stopAtTemplateBrace && char === "}" && nestedBraces === 0) {
        offset += 1;
        return;
      } else if (char === "/" && source[offset + 1] === "/") {
        offset += 2;
        while (offset < source.length && source[offset] !== "\n" && source[offset] !== "\r")
          offset += 1;
      } else if (char === "/" && source[offset + 1] === "*") {
        const end = source.indexOf("*/", offset + 2);
        offset = end === -1 ? source.length : end + 2;
      } else if (char === "'" || char === '"') {
        const start = offset;
        const quote = char;
        offset += 1;
        while (offset < source.length) {
          if (source[offset] === "\\") offset += 2;
          else if (source[offset] === quote) {
            offset += 1;
            break;
          } else offset += 1;
        }
        const raw = source.slice(start, offset);
        add("string", decodeString(raw), start, raw);
      } else if (char === "`") {
        skipTemplate();
      } else if (char === "/" && regexMayStart()) {
        skipRegex();
      } else if (isIdentifierStart(char)) {
        const start = offset++;
        while (isIdentifierPart(source[offset])) offset += 1;
        add("identifier", source.slice(start, offset), start);
      } else {
        const start = offset;
        const punctuators = [
          "?.",
          "...",
          "=>",
          "===",
          "!==",
          "==",
          "!=",
          "<=",
          ">=",
          "??",
          "&&",
          "||",
          "++",
          "--",
          "**",
          "??=",
          "&&=",
          "||=",
        ];
        const punctuator = punctuators.find((value) => source.startsWith(value, offset));
        if (punctuator) offset += punctuator.length;
        else offset += 1;
        const value = source.slice(start, offset);
        add("punctuation", value, start);
        if (stopAtTemplateBrace && value === "{") nestedBraces += 1;
        else if (stopAtTemplateBrace && value === "}") nestedBraces -= 1;
      }
    }
  }

  scanCode();
  return tokens;
}

function importSpecifiers(source) {
  const tokens = tokenize(source);
  const found = [];
  const add = (token, kind) => {
    if (token?.kind === "string") found.push({ specifier: token.value, kind, line: token.line });
  };
  const previousIsProperty = (index) => [".", "?."].includes(tokens[index - 1]?.value);
  const addCall = (cursor, kind) => {
    const argument = tokens[cursor + 1];
    if (argument?.kind === "string" && [")", ","].includes(tokens[cursor + 2]?.value)) {
      add(argument, kind);
    } else found.push({ specifier: null, kind, line: tokens[cursor].line });
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind !== "identifier") continue;

    if (token.value === "import" && !previousIsProperty(index)) {
      const next = tokens[index + 1];
      if (next?.value === "(") {
        addCall(index + 1, "dynamic-import");
        continue;
      }
      if (
        tokens
          .slice(index + 1, index + 6)
          .map((part) => part.value)
          .join("") === ".meta.resolve("
      ) {
        addCall(index + 5, "import-meta-resolve");
        continue;
      }
      if (next?.kind === "string") {
        add(next, "import");
        continue;
      }
      let depth = 0;
      for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
        const current = tokens[cursor];
        if (depth === 0 && current.value === "from" && tokens[cursor + 1]?.kind === "string") {
          add(tokens[cursor + 1], "import");
          break;
        }
        if (depth === 0 && current.value === ";") break;
        if (depth === 0 && cursor > index + 1 && ["import", "export"].includes(current.value))
          break;
        if (["{", "[", "("].includes(current.value)) depth += 1;
        else if (["}", "]", ")"].includes(current.value)) depth = Math.max(0, depth - 1);
      }
    }

    if (token.value === "export" && !previousIsProperty(index)) {
      let cursor = index + 1;
      if (tokens[cursor]?.value === "type") cursor += 1;
      if (tokens[cursor]?.value === "{") {
        let depth = 0;
        do {
          if (tokens[cursor]?.value === "{") depth += 1;
          else if (tokens[cursor]?.value === "}") depth -= 1;
          cursor += 1;
        } while (cursor < tokens.length && depth > 0);
        if (tokens[cursor]?.value === "from" && tokens[cursor + 1]?.kind === "string") {
          add(tokens[cursor + 1], "export-from");
        }
      } else if (tokens[cursor]?.value === "*") {
        cursor += 1;
        while (
          cursor < tokens.length &&
          tokens[cursor]?.value !== ";" &&
          tokens[cursor]?.value !== "from"
        )
          cursor += 1;
        if (tokens[cursor]?.value === "from" && tokens[cursor + 1]?.kind === "string") {
          add(tokens[cursor + 1], "export-from");
        }
      }
    }

    if (
      token.value === "require" &&
      (!previousIsProperty(index) || tokens[index - 2]?.value === "module")
    ) {
      let cursor = index + 1;
      if (tokens[cursor]?.value === "." && tokens[cursor + 1]?.value === "resolve") cursor += 2;
      if (tokens[cursor]?.value === "?.") cursor += 1;
      if (tokens[cursor]?.value === "(") addCall(cursor, "require");
    }
  }
  return found;
}

function isElectronSpecifier(specifier) {
  return (
    typeof specifier === "string" && (specifier === "electron" || specifier.startsWith("electron/"))
  );
}

function isUnsupportedHostAlias(specifier) {
  return (
    specifier?.startsWith("#") || /^@(?:volli\/desktop|renderer)(?:\/|$)/.test(specifier ?? "")
  );
}

function sourceCandidate(repoRoot, candidate) {
  if (!existsSync(candidate) || !statSync(candidate).isFile()) return null;
  const physicalPath = realpathSync(candidate);
  if (!withinRoot(repoRoot, physicalPath)) {
    fail(`relative import resolves outside the repository: ${repoRelative(repoRoot, candidate)}`);
  }
  if (!SOURCE_EXTENSIONS.includes(extname(physicalPath))) return null;
  return physicalPath;
}

function resolveLocalImport(repoRoot, importer, specifier) {
  const pathPart = specifier.split(/[?#]/, 1)[0];
  const explicitExtension = extname(pathPart);
  if (ASSET_EXTENSIONS.has(explicitExtension.toLowerCase())) return { asset: true };
  const base = resolve(dirname(importer), pathPart);
  const candidates = [];
  if (SOURCE_EXTENSIONS.includes(explicitExtension)) {
    for (const replacement of JS_TO_TS.get(explicitExtension) ?? [explicitExtension]) {
      candidates.push(`${base.slice(0, -explicitExtension.length)}${replacement}`);
    }
  } else {
    candidates.push(base);
    for (const extension of SOURCE_EXTENSIONS) candidates.push(`${base}${extension}`);
    for (const extension of SOURCE_EXTENSIONS) candidates.push(resolve(base, `index${extension}`));
  }
  for (const candidate of candidates) {
    const resolved = sourceCandidate(repoRoot, candidate);
    if (resolved !== null) return { asset: false, file: resolved };
  }
  fail(
    `unresolved local code import ${JSON.stringify(specifier)} at ` +
      `${repoRelative(repoRoot, importer)} (tried ${candidates.map((path) => repoRelative(repoRoot, path)).join(", ")})`,
  );
}

function loadModule(repoRoot, filePath) {
  let source;
  try {
    source = readFileSync(filePath, "utf8");
  } catch (error) {
    fail(`cannot read source module ${repoRelative(repoRoot, filePath)}: ${error.message}`);
  }
  const imports = importSpecifiers(source);
  const electronImports = imports.filter(({ specifier }) => isElectronSpecifier(specifier));
  const edges = [];
  for (const imported of imports) {
    if (imported.specifier === null || !imported.specifier.startsWith(".")) continue;
    const resolved = resolveLocalImport(repoRoot, filePath, imported.specifier);
    if (resolved.asset) continue;
    edges.push({ file: resolved.file, line: imported.line, specifier: imported.specifier });
  }
  return { file: filePath, imports, electronImports, edges };
}

function buildGraph(repoRoot, roots) {
  const queue = [...new Set(roots)].toSorted();
  const graph = new Map();
  while (queue.length > 0) {
    const file = queue.shift();
    if (graph.has(file)) continue;
    const module = loadModule(repoRoot, file);
    graph.set(file, module);
    for (const edge of module.edges) if (!graph.has(edge.file)) queue.push(edge.file);
  }
  return graph;
}

function oneWitness(start, graph) {
  const queue = [{ file: start, chain: [start] }];
  const visited = new Set();
  while (queue.length > 0) {
    const current = queue.shift();
    if (visited.has(current.file)) continue;
    visited.add(current.file);
    const module = graph.get(current.file);
    if (!module) fail(`internal scanner error: module was not loaded: ${current.file}`);
    if (module.electronImports.length > 0) {
      return {
        chain: current.chain,
        electronAt: module.file,
        line: module.electronImports[0].line,
      };
    }
    for (const edge of module.edges) {
      if (!visited.has(edge.file))
        queue.push({ file: edge.file, chain: [...current.chain, edge.file] });
    }
  }
  return null;
}

function electronWitnesses(start, graph) {
  const module = graph.get(start);
  if (!module) fail(`internal scanner error: missing entry module: ${start}`);
  const witnesses = [];
  for (const imported of module.electronImports) {
    witnesses.push({ chain: [start], electronAt: start, line: imported.line });
  }
  for (const edge of module.edges) {
    const route = oneWitness(edge.file, graph);
    if (route !== null) witnesses.push({ ...route, chain: [start, ...route.chain] });
  }
  const seen = new Set();
  return witnesses.filter((witness) => {
    const key = `${witness.chain.join("\0")}\0${witness.electronAt}\0${witness.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function formatWitness(repoRoot, witness) {
  const chain = witness.chain.map((file) => repoRelative(repoRoot, file)).join(" -> ");
  return `${chain} -> electron (${repoRelative(repoRoot, witness.electronAt)}:${witness.line})`;
}

function runGuard(repoRoot) {
  const entries = enumerateGuardFiles(repoRoot);
  const graph = buildGraph(repoRoot, entries);
  for (const module of graph.values()) {
    for (const imported of module.imports) {
      if (isUnsupportedHostAlias(imported.specifier)) {
        fail(
          `unsupported host alias ${JSON.stringify(imported.specifier)} at ${repoRelative(repoRoot, module.file)}:${imported.line}; use a relative edge so the guard can verify its closure`,
        );
      }
      if (imported.specifier === null) {
        console.warn(
          `[host-electron-imports] computed ${imported.kind} at ${repoRelative(repoRoot, module.file)}:${imported.line}; target cannot be checked statically`,
        );
      }
    }
  }
  const violations = entries.flatMap((file) => {
    const witnesses = electronWitnesses(file, graph);
    return witnesses.length > 0 ? [{ file, witnesses }] : [];
  });
  if (violations.length > 0) {
    console.error(
      `[host-electron-imports] failed: ${violations.length} host/package source modules reach electron.`,
    );
    for (const violation of violations) {
      console.error(`  ${repoRelative(repoRoot, violation.file)}`);
      for (const witness of violation.witnesses)
        console.error(`    witness: ${formatWitness(repoRoot, witness)}`);
    }
    return 1;
  }
  console.log(
    `[host-electron-imports] passed: ${entries.length} packages/host source modules and their relative dependencies do not reach electron.`,
  );
  return 0;
}

function runReport(repoRoot, outputPath) {
  const mainEntries = sourceFilesBelow(repoRoot, "apps/desktop/src/main");
  if (mainEntries.length === 0) fail("no main-process source files found for --report");
  const graph = buildGraph(repoRoot, mainEntries);
  const modules = mainEntries.map((file) => {
    const witnesses = electronWitnesses(file, graph);
    return {
      file: repoRelative(repoRoot, file),
      classification: witnesses.length > 0 ? "reaches-electron" : "does-not-reach-electron",
      computedImports: graph.get(file).imports.filter((imported) => imported.specifier === null),
      witnesses: witnesses.map((witness) => ({
        chain: witness.chain.map((part) => repoRelative(repoRoot, part)),
        electronAt: repoRelative(repoRoot, witness.electronAt),
        line: witness.line,
      })),
    };
  });
  const inventory = {
    schemaVersion: 1,
    caveat:
      "Literal relative-import closure before mocks/type erasure; computed targets, aliases, JSDoc type comments and third-party internals are not resolved. Witnesses are illustrative, not exhaustive.",
    sourceRoot: "apps/desktop/src/main",
    summary: {
      modules: modules.length,
      reachingElectron: modules.filter((module) => module.classification === "reaches-electron")
        .length,
      notReachingElectron: modules.filter(
        (module) => module.classification === "does-not-reach-electron",
      ).length,
    },
    modules,
  };
  const destination = resolve(repoRoot, outputPath);
  if (!repoRelative(repoRoot, destination).startsWith(".tmp/") || extname(destination) !== ".json")
    fail(
      "--report output must be a JSON file under .tmp/; refusing to overwrite repository source or manifests",
    );
  mkdirSync(dirname(destination), { recursive: true });
  const physicalParent = realpathSync(dirname(destination));
  if (!withinRoot(repoRoot, physicalParent))
    fail("--report output parent resolves outside the repository root");
  if (existsSync(destination) && !withinRoot(repoRoot, realpathSync(destination))) {
    fail("--report output resolves outside the repository root");
  }
  writeFileSync(destination, `${JSON.stringify(inventory, null, 2)}\n`);
  console.log(
    `[host-electron-imports] report: ${inventory.summary.reachingElectron}/${modules.length} main modules reach electron; ` +
      `inventory written to ${repoRelative(repoRoot, destination)}`,
  );
}

function check(testName, actual, expected, failures) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures.push(
      `${testName}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
    );
  }
}

function selfTest() {
  const failures = [];
  const importCases = [
    ['import "electron";', ["import"]],
    ['import { app } from "electron";', ["import"]],
    ['import type { App } from "electron";', ["import"]],
    ['export * from "electron";', ["export-from"]],
    ['export type { App } from "electron";', ["export-from"]],
    ['void import("electron");', ["dynamic-import"]],
    ["void import(`electron`);", ["dynamic-import"]],
    ["const electron = require(`electron`);", ["require"]],
    ['type App = import("electron").App;', ["dynamic-import"]],
    ['const electron = require("electron");', ["require"]],
    ['const electron = module.require("electron");', ["require"]],
    ['const path = require.resolve("electron");', ["require"]],
    ['const path = import.meta.resolve("electron");', ["import-meta-resolve"]],
    ['import electron = require("electron");', ["require"]],
    ['const electron = `raw require("other") ${import("electron")}`;', ["dynamic-import"]],
    ['import "\\u0065lectron";', ["import"]],
  ];
  for (const [source, expectedKinds] of importCases) {
    const actual = importSpecifiers(source)
      .filter(({ specifier }) => isElectronSpecifier(specifier))
      .map(({ kind }) => kind);
    check(`import shape ${source}`, actual, expectedKinds, failures);
  }
  const decoys = [
    '// import "electron";\n/* require("electron") */',
    'const text = "import(\\"electron\\") require(\\"electron\\")";',
    '`raw import("electron") and require("electron")`;',
    'const pattern = /import\\("electron"\\)|require\\("electron"\\)/;',
    'if (ready) /import\\("electron"\\)/.test(message);',
    'object.import("electron"); object.require("electron");',
    'import "electronish"; import "@scope/electron";',
    'const text = `import("electron")`; void import(`text${text}`);',
  ];
  for (const source of decoys) {
    check(
      `non-import decoys ${source}`,
      importSpecifiers(source).filter(({ specifier }) => isElectronSpecifier(specifier)),
      [],
      failures,
    );
  }

  for (const specifier of ["#main", "#electron", "@volli/desktop/main", "@renderer/view"]) {
    check(
      `unsupported alias fails closed: ${specifier}`,
      isUnsupportedHostAlias(specifier),
      true,
      failures,
    );
  }
  check(
    "workspace packages are independently guarded roots",
    isUnsupportedHostAlias("@volli/shared"),
    false,
    failures,
  );
  for (const source of ["import(target)", "require(target)", 'require("electr" + "on")']) {
    check(
      `computed target is reported: ${source}`,
      importSpecifiers(source).map((entry) => entry.specifier),
      [null],
      failures,
    );
  }
  try {
    runReport(REPO_ROOT, "package.json");
    failures.push("report must not overwrite manifests");
  } catch (error) {
    if (!error.message.includes("under .tmp/"))
      failures.push(`wrong report safety error: ${error.message}`);
  }

  const fixtureFiles = enumerateGuardFiles(FIXTURE_ROOT);
  const fixtureGraph = buildGraph(FIXTURE_ROOT, fixtureFiles);
  const location = resolve(FIXTURE_ROOT, "apps/hostd/src/session-runtime/location.ts");
  const witnessModules = electronWitnesses(location, fixtureGraph).map((witness) =>
    repoRelative(FIXTURE_ROOT, witness.electronAt),
  );
  try {
    resolveLocalImport(FIXTURE_ROOT, location, "../missing-code-module");
    failures.push("unresolved local code imports should fail closed");
  } catch (error) {
    if (!error.message.includes("unresolved local code import")) {
      failures.push(`unresolved local code import had the wrong error: ${error.message}`);
    }
  }
  check(
    "asset imports are ignored",
    resolveLocalImport(FIXTURE_ROOT, location, "../assets/icon.svg").asset,
    true,
    failures,
  );
  check(
    "fixture location reaches both Electron chains",
    witnessModules.toSorted(),
    ["apps/desktop/src/main/broadcast.ts", "apps/desktop/src/main/worktree-runtime.ts"],
    failures,
  );

  const cli = spawnSync(
    process.execPath,
    [fileURLToPath(import.meta.url), "--root", FIXTURE_ROOT],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
    },
  );
  const cliOutput = `${cli.stdout ?? ""}\n${cli.stderr ?? ""}`;
  if (cli.error) failures.push(`fixture CLI could not start: ${cli.error.message}`);
  if (cli.status !== 1)
    failures.push(`fixture CLI should fail with status 1, received ${cli.status}`);
  for (const expected of [
    "apps/hostd/src/session-runtime/location.ts",
    "apps/desktop/src/main/broadcast.ts",
    "apps/desktop/src/main/worktree-runtime.ts",
  ]) {
    if (!cliOutput.includes(expected)) failures.push(`fixture CLI output omitted ${expected}`);
  }

  if (failures.length > 0) {
    console.error(
      [
        "check-host-electron-imports self-test failed:",
        ...failures.map((failure) => `  - ${failure}`),
      ].join("\n"),
    );
    return 1;
  }
  console.log(
    "check-host-electron-imports self-test passed (import shapes, both fixture chains, CLI failure)",
  );
  return 0;
}

function parseArguments(args) {
  const options = {
    mode: "check",
    root: REPO_ROOT,
    output: ".tmp/host-electron-import-inventory.json",
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--self-test") options.mode = "self-test";
    else if (arg === "--report") {
      options.mode = "report";
      if (args[index + 1] && !args[index + 1].startsWith("--")) options.output = args[++index];
    } else if (arg === "--root") {
      const value = args[++index];
      if (!value) fail("--root requires a repository root path");
      options.root = realpathSync(resolve(value));
    } else {
      fail(
        `unknown argument ${JSON.stringify(arg)}\nUsage: node scripts/check-host-electron-imports.mjs [--self-test | --report [output.json]] [--root path]`,
      );
    }
  }
  return options;
}

function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.mode === "self-test") process.exitCode = selfTest();
    else if (options.mode === "report") runReport(options.root, options.output);
    else process.exitCode = runGuard(options.root);
  } catch (error) {
    console.error(`[host-electron-imports] ${error.message}`);
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
)
  main();
