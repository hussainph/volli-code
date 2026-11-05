/**
 * Volli Glass source guard. CI runs this beside check-ui-copy and the existing
 * token-ladder check. TS/TSX is parsed, so comments and types are not drawings;
 * CSS is read as declarations, with generated fallback blocks removed.
 *
 * Deliberately static: dynamic values, indirect variable assignments and CSS
 * assembled at runtime still need review. This is not a contrast/layout proof.
 * Tests, fixtures and the browser-only lab do not ship and are excluded.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseAst } from "vite";

import { semanticShapeLiterals } from "./ui-class-context.mjs";
import { reportFindings } from "./design-guardrail-allowlist.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");
const RENDERER = "apps/desktop/src/renderer/";
const ICON_SEAM = `${RENDERER}src/components/ui/icon.tsx`;
const GLOBALS = `${RENDERER}src/globals.css`;
// The colour pipeline's renderer writer emits derived CSS variables, not UI paint.
const CANVAS_PAINT = `${RENDERER}src/theme/canvas-paint.ts`;
const RULES = [
  "colour-literal",
  "type-literal-size",
  "icon-duotone",
  "icon-set-import",
  "material-hand-rolled-blur",
  "radius-off-scale",
  "motion-literal",
  "motion-reduced-hook",
  "eyebrow-uppercase",
];
const COLOUR =
  /#[\da-f]{8}\b|#[\da-f]{6}\b|#[\da-f]{4}\b|#[\da-f]{3}\b|\b(?:rgba?|hsla?|oklch|oklab|lch|lab|color)\(\s*(?!from\b|var\()/i;
const PALETTE =
  /(?:^|[\s:])(?:bg|text|border|ring|fill|stroke|from|via|to)-(?:white|black|(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone)-\d{2,3})(?=[/\s!]|$)/;
const RAW_TIME = /(?:^|[^\w.-])((?:\d*\.)?\d+)(?:ms|s)\b/g;
const RAW_EASE =
  /\b(?:cubic-bezier|linear)\(|\b(?:ease-in-out|ease-in|ease-out|ease|linear|step-start|step-end)\b/;
const RADIUS_NAMES =
  "none|full|sm|md|lg|xl|control-mini|control-small|control|container|row|menu-item|menu|keycap|sheet|floating|card|column|native-control";
const RADIUS_UTILITY = new RegExp(
  `^rounded(?:-(?:t|r|b|l|tl|tr|br|bl|s|e|ss|se|es|ee))?-(?:${RADIUS_NAMES})$`,
);

function walk(node, visit) {
  if (
    !node ||
    typeof node.type !== "string" ||
    /^(?:TSType|TSInterface|TSLiteral|TSDeclare)/.test(node.type)
  )
    return;
  visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) for (const child of value) walk(child, visit);
    else if (value && typeof value === "object") walk(value, visit);
  }
}

/** Strip variants without splitting arbitrary values such as [color:var(...)]. */
function baseUtility(token) {
  let depth = 0;
  let start = 0;
  for (let i = 0; i < token.length; i += 1) {
    if (token[i] === "[" || token[i] === "(") depth += 1;
    if (token[i] === "]" || token[i] === ")") depth -= 1;
    if (token[i] === ":" && depth === 0) start = i + 1;
  }
  return token.slice(start).replace(/^!|!$/g, "");
}

function literalMotion(value) {
  const withoutVars = value.replace(/var\(--[\w-]+(?:,[^)]*)?\)/g, "");
  return (
    [...withoutVars.matchAll(RAW_TIME)].some(([, time]) => Number(time) !== 0) ||
    RAW_EASE.test(withoutVars)
  );
}

function radiusLiteral(value) {
  // Variables from the radius scale, zero seams and circles/capsules are legal.
  return value
    .replace(
      /(?:calc\()?var\(--(?:radius-[\w-]+|skeleton-radius)\)(?:\s*[-+*/]\s*[\d.]+(?:px|rem)?)?\)?/g,
      "",
    )
    .split(/[\s/]+/)
    .some((part) => part && !/^(?:0(?:px)?|50%|999px|9999px|inherit|initial|unset)$/.test(part));
}

export function inspectGlass(path, source) {
  const found = [];
  const shapeValues = path.endsWith(".css") ? new Set() : semanticShapeLiterals(source, path);
  const seen = new Set();
  const add = (rule, offset, text) => {
    const line = source.slice(0, offset).split("\n").length;
    const key = `${rule}:${offset}`;
    if (!seen.has(key)) found.push({ path, line, rule, text: text.slice(0, 180) });
    seen.add(key);
  };
  const checkString = (text, offset) => {
    if (path !== CANVAS_PAINT && (COLOUR.test(text) || PALETTE.test(text)))
      add("colour-literal", offset, text);
    for (const token of text.split(/\s+/)) {
      const base = baseUtility(token);
      if (/^text-\[(?:\d*\.)?\d+(?:px|rem)\](?:\/[^\s]+)?$/.test(base))
        add("type-literal-size", offset, token);
      if (base === "uppercase") add("eyebrow-uppercase", offset, token);
      if (
        /^backdrop-(?:blur|filter)(?:-(?!none$).+)?$/.test(base) ||
        /^\[(?:-webkit-)?backdrop-filter:(?!none\])/.test(base)
      )
        add("material-hand-rolled-blur", offset, token);
      if (/^rounded(?:-|$)/.test(base) && !RADIUS_UTILITY.test(base))
        add("radius-off-scale", offset, token);
      if (
        /^(?:duration|delay)-(?!0$|\(--duration-|\[var\(--duration-)/.test(base) ||
        /^ease-(?!out$|swift$|\(--(?:ease|spring)-|\[var\(--(?:ease|spring)-)/.test(base)
      )
        add("motion-literal", offset, token);
    }
  };

  if (path.endsWith(".css")) {
    // Preserve offsets and line numbers while removing comments and generated tokens.
    let css = source.replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " "));
    if (path === GLOBALS) {
      const begin = source.indexOf("/* GENERATED THEME TOKENS — BEGIN */");
      const end = source.indexOf("/* GENERATED THEME TOKENS — END */", begin);
      if (begin >= 0 && end >= 0)
        css = css.slice(0, begin) + css.slice(begin, end).replace(/[^\n]/g, " ") + css.slice(end);
    }
    // A declaration begins after { or ; (not inside a selector/pseudo-class).
    const declarations = /(?:^|[;{])\s*([\w-]+)\s*:\s*([^;{}]+)/g;
    for (const match of css.matchAll(declarations)) {
      const [, property, value] = match;
      const offset = match.index + match[0].indexOf(property);
      const tokenDefinition = path === GLOBALS && property.startsWith("--");
      if (
        !(path === GLOBALS && /^--shadow-glass(?:-small)?$/.test(property)) &&
        (COLOUR.test(value) ||
          (/^(?:color|background(?:-color)?|border(?:-color)?|fill|stroke)$/.test(property) &&
            /\b(?:white|black|red|blue|green|orange|purple|gray|grey)\b/.test(value)))
      )
        add("colour-literal", offset, `${property}: ${value}`);
      if (!tokenDefinition && /^--(?:radius)-/.test(property) && radiusLiteral(value))
        add("radius-off-scale", offset, value);
      if (!tokenDefinition && /^--(?:duration|ease|spring)-/.test(property) && literalMotion(value))
        add("motion-literal", offset, value);
      if (property === "font-size" && /(?:\d*\.)?\d+(?:px|rem)\b/.test(value))
        add("type-literal-size", offset, value);
      if (property === "text-transform" && value.trim() === "uppercase")
        add("eyebrow-uppercase", offset, value);
      if (property.endsWith("backdrop-filter") && !/^none(?:\s*!important)?$/.test(value.trim())) {
        const selector =
          css
            .slice(0, match.index + 1)
            .split("}")
            .at(-1)
            .split("{")
            .slice(0, -1)
            .at(-1) ?? "";
        const materialOwner =
          path === GLOBALS &&
          /\.(?:glass|material-(?:floating|clear|regular|thick|solid))\b|\[data-glass-blur=/.test(
            selector,
          );
        if (!materialOwner) add("material-hand-rolled-blur", offset, `${property}: ${value}`);
      }
      if (
        /^border-(?:(?:top|bottom|left|right|start|end)-)?(?:radius|(?:left|right|start|end)-radius)$/.test(
          property,
        ) &&
        radiusLiteral(value)
      )
        add("radius-off-scale", offset, value);
      if (
        !tokenDefinition &&
        /^(?:transition|animation)(?:-(?:duration|delay|timing-function))?$/.test(property) &&
        literalMotion(value)
      )
        add("motion-literal", offset, `${property}: ${value}`);
    }
  } else {
    const ast = parseAst(source, { lang: path.endsWith("tsx") ? "tsx" : "ts" }, path);
    walk(ast, (node) => {
      if (node.type === "Literal" && typeof node.value === "string" && !shapeValues.has(node.start))
        checkString(node.value, node.start);
      if (node.type === "TemplateElement")
        checkString(node.value.cooked ?? node.value.raw, node.start);
      if (
        /^(?:ImportDeclaration|ImportExpression|ExportNamedDeclaration|ExportAllDeclaration)$/.test(
          node.type,
        ) &&
        typeof node.source?.value === "string"
      ) {
        const name = node.source.value;
        if (
          /^@phosphor-icons\/react(?:\/|$)/.test(name) ||
          (name.startsWith("@hugeicons/") &&
            (path !== ICON_SEAM ||
              !["@hugeicons/react", "@hugeicons/core-free-icons"].includes(name) ||
              node.specifiers?.some((item) => item.type === "ImportNamespaceSpecifier")))
        )
          add(
            "icon-set-import",
            node.start,
            "Use the semantic ui/icon seam and only the MIT free Stroke Rounded set",
          );
      }
      if (
        node.type === "ImportDeclaration" &&
        !/(?:^|\/)hooks\/use-reduced-motion$/.test(node.source.value) &&
        node.specifiers.some(
          (item) =>
            item.imported?.name === "useReducedMotion" ||
            (/^(?:motion\/react|framer-motion)$/.test(node.source.value) &&
              item.type === "ImportNamespaceSpecifier"),
        )
      )
        add("motion-reduced-hook", node.start, "Import the shared hooks/use-reduced-motion hook");
      if (node.type === "Property" || node.type === "JSXAttribute") {
        const key = node.key?.name ?? node.key?.value ?? node.name?.name;
        const value = node.value?.expression ?? node.value;
        if (
          /^(?:color|background|backgroundColor|borderColor|fill|stroke)$/.test(key) &&
          /^(?:white|black|red|blue|green|orange|purple|gray|grey)$/.test(value?.value)
        )
          add("colour-literal", node.start, source.slice(node.start, node.end));
        if (key === "weight" && source.slice(value?.start, value?.end).includes("duotone"))
          add("icon-duotone", node.start, "duotone");
        if (
          /^(?:borderRadius|borderTopLeftRadius|borderTopRightRadius|borderBottomLeftRadius|borderBottomRightRadius)$/.test(
            key,
          ) &&
          ((value?.type === "Literal" &&
            typeof value.value === "number" &&
            ![0, 999, 9999].includes(value.value)) ||
            (typeof value?.value === "string" && radiusLiteral(value.value)))
        )
          add("radius-off-scale", node.start, source.slice(node.start, node.end));
        if (
          /^(?:duration|delay|ease|easing|transition|animation|transitionDuration|transitionDelay|animationDuration|animationDelay|transitionTimingFunction|animationTimingFunction)$/.test(
            key,
          ) &&
          ((value?.type === "Literal" && typeof value.value === "number" && value.value !== 0) ||
            value?.type === "ArrayExpression" ||
            (typeof value?.value === "string" &&
              (literalMotion(value.value) || /^(?:ease|linear|cubic-bezier)/.test(value.value))))
        )
          add("motion-literal", node.start, source.slice(node.start, node.end));
        if (/^(?:backdropFilter|WebkitBackdropFilter)$/.test(key) && value?.value !== "none")
          add("material-hand-rolled-blur", node.start, source.slice(node.start, node.end));
      }
    });
  }
  return found;
}

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory())
      return /^(?:lab|__tests__|__fixtures__|fixtures|coverage|dist|node_modules)$/.test(entry.name)
        ? []
        : sourceFiles(path);
    return /\.(?:tsx?|css)$/.test(path) && !/\.(?:test|spec|test-support|bench)\./.test(path)
      ? [path]
      : [];
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const findings = sourceFiles(resolve(ROOT, RENDERER)).flatMap((path) =>
    inspectGlass(relative(ROOT, path), readFileSync(path, "utf8")),
  );
  if (process.argv.includes("--json")) console.log(JSON.stringify(findings));
  else reportFindings(findings, RULES, resolve(HERE, "glass-design-shrinking-allowlist.json"));
}
