/**
 * Writes `docs/telemetry.md`, the list of every field Volli's own telemetry
 * destination may receive, from the vocabulary that defines it (VC-505).
 *
 *     node scripts/generate-telemetry-fields.mjs         # rewrite in place
 *     node scripts/generate-telemetry-fields.mjs --check # fail if stale (CI)
 *
 * The page is generated so it cannot drift: `TELEMETRY_EVENTS` in
 * `packages/shared/src/telemetry-vocabulary.ts` is the schema the TypeScript
 * event types are derived from and the exporter's conformance check reads, so
 * this page, the types and the check all describe one thing. Change the
 * vocabulary, then run this; CI's `--check` fails on a stale page.
 *
 * `@volli/shared` ships raw TypeScript with extensionless relative imports.
 * Node strips the types; the resolve hook below supplies the extension.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, relative, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolvePath(HERE, "..");
const VOCABULARY = resolvePath(ROOT, "packages/shared/src/telemetry-vocabulary.ts");
const OUTPUT = resolvePath(ROOT, "docs/telemetry.md");

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && !/\.[cm]?[jt]sx?$/.test(specifier)) {
      for (const suffix of [".ts", "/index.ts"]) {
        const candidate = new URL(specifier + suffix, context.parentURL);
        if (existsSync(fileURLToPath(candidate)))
          return { url: candidate.href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
});

const {
  TELEMETRY_EVENTS,
  REPORTABLE_ERROR_CODES,
  CUSTOM_CATALOG_ID,
  UNKNOWN_VERSION,
  MAX_TELEMETRY_ROWS,
} = await import(pathToFileURL(VOCABULARY).href);

const code = (value) => `\`${value}\``;

/**
 * Each field type: its "Type" cell, and the sentence the page's overview uses
 * for it. Only the types the schema actually uses reach the overview.
 */
const FIELD_TYPES = {
  word: {
    cell: (field) =>
      field.summary === undefined
        ? `One of: ${field.values.map(code).join(", ")}`
        : `${field.summary} (${field.values.length} values)`,
    overview: "a word from a fixed list",
  },
  count: { cell: () => "Count (integer, 0 or more)", overview: "a count" },
  integer: { cell: () => "Integer", overview: "an integer, such as an exit code" },
  duration: { cell: () => "Duration in milliseconds", overview: "a duration" },
  rate: {
    cell: () => "Fraction, above 0 and at most 1",
    overview: "a fraction, such as a sampling rate",
  },
  flag: { cell: () => "true or false", overview: "true or false" },
  version: {
    cell: () => `A release version such as ${code("0.3.0")}, or ${code(UNKNOWN_VERSION)}`,
    overview: `a release version, or ${code(UNKNOWN_VERSION)}`,
  },
  provider: {
    cell: () => `A provider id from the model catalog Volli ships, or ${code(CUSTOM_CATALOG_ID)}`,
    overview: `a provider or model id from the model catalog Volli ships, or ${code(CUSTOM_CATALOG_ID)}`,
  },
  model: {
    cell: (field) =>
      `A model id the model catalog Volli ships lists under ${code(field.provider)}, or ${code(CUSTOM_CATALOG_ID)}`,
    overview: null,
  },
  tally: {
    cell: (field) =>
      `A count for each of: ${field.keys.map(code).join(", ")}. A word that counted nothing may be left out`,
    overview: "a count for each word of a fixed list",
  },
  rows: {
    cell: () => `A list of at most ${MAX_TELEMETRY_ROWS} rows, each with the fields below`,
    overview: `a list of rows made of the above, at most ${MAX_TELEMETRY_ROWS} long`,
  },
};

function fieldType(field) {
  const type = FIELD_TYPES[field.type];
  if (type === undefined) throw new Error(`unknown telemetry field type ${field.type}`);
  return type;
}

/** One table row per field; a `rows` field adds its own fields under `name[].`. */
function fieldRows(fields, prefix = "", out = []) {
  for (const [key, field] of Object.entries(fields)) {
    const optional = field.optional === true ? " (optional)" : "";
    out.push(
      `| ${code(`${prefix}${key}`)}${optional} | ${fieldType(field).cell(field)} | ${field.doc} |`,
    );
    if (field.type === "rows") fieldRows(field.fields, `${prefix}${key}[].`, out);
  }
  return out;
}

/** The overview sentence of every field type in use, in `FIELD_TYPES` order. */
function typesInUse() {
  const used = new Set();
  const walk = (fields) => {
    for (const field of Object.values(fields)) {
      used.add(field.type);
      if (field.type === "rows") walk(field.fields);
    }
  };
  for (const spec of Object.values(TELEMETRY_EVENTS)) walk(spec.fields);
  return Object.entries(FIELD_TYPES)
    .filter(([type, { overview }]) => used.has(type) && overview !== null)
    .map(([, { overview }]) => `- ${overview}`);
}

function render() {
  const source = relative(ROOT, VOCABULARY);
  const lines = [
    "# Telemetry fields",
    "",
    `<!-- Generated by \`node scripts/generate-telemetry-fields.mjs\` from \`${source}\`. Do not edit by hand. -->`,
    "",
    "Volli's own telemetry will have two parts, each with its own switch: usage statistics and",
    "crash reports. No build sends either yet. The exporter, its identifiers and its consent",
    "controls ship separately, and are held to this page.",
    "",
    "## Usage statistics",
    "",
    "Every usage event Volli's own telemetry service may receive is listed below, with every",
    "property it may carry. A property that is not listed is never part of a usage event.",
    "The identifier and timestamp each event is sent with will be described here when the",
    "exporter ships.",
    "",
    "No property can hold free text. Each one is:",
    "",
    ...typesInUse(),
    "",
    "In particular, Volli never sends:",
    "",
    "- ticket, project, workspace or repository names",
    "- file paths, commands, prompts, model output or tool arguments",
    "- error messages",
    "- email addresses, account ids or host names",
    `- the names of providers or models you configured yourself (these are sent as ${code(CUSTOM_CATALOG_ID)})`,
    "",
    "This list is separate from the collector you can configure in Settings → System →",
    "Telemetry, which receives the Agent Runtime's own events and is controlled there.",
    "",
  ];
  for (const [name, spec] of Object.entries(TELEMETRY_EVENTS)) {
    lines.push(
      `### ${code(name)}`,
      "",
      spec.doc,
      "",
      "| Property | Type | Meaning |",
      "| --- | --- | --- |",
      ...fieldRows(spec.fields),
      "",
    );
  }
  lines.push(
    "## Crash reports",
    "",
    "Not sent yet. Crash reports will keep an error's stack trace but never its message. When",
    "the error is one of Volli's own typed errors with one of these codes, the report carries",
    "the code instead:",
    "",
    ...REPORTABLE_ERROR_CODES.map((value) => `- ${code(value)}`),
    "",
  );
  return lines.join("\n");
}

const next = render();
if (process.argv.includes("--check")) {
  const current = existsSync(OUTPUT) ? readFileSync(OUTPUT, "utf8") : "";
  if (current !== next) {
    console.error(
      `${relative(ROOT, OUTPUT)} is stale. Regenerate it with: node scripts/generate-telemetry-fields.mjs`,
    );
    process.exit(1);
  }
  console.log(`${relative(ROOT, OUTPUT)} is up to date.`);
} else {
  writeFileSync(OUTPUT, next);
  console.log(`wrote ${relative(ROOT, OUTPUT)}`);
}
