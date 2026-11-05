/** Disambiguate the native shape enum from Tailwind's unrelated bare `rounded`. */
import { parseAst } from "vite";

export function semanticShapeLiterals(source, path) {
  const offsets = new Set();
  if (!/["']rounded["']/.test(source)) return offsets;
  const ast = parseAst(source, { lang: path.endsWith("tsx") ? "tsx" : "ts" }, path);
  function walk(node, ancestors = []) {
    if (!node || typeof node.type !== "string") return;
    if (node.type === "Literal" && node.value === "rounded") {
      const parent = ancestors.at(-1);
      const semantic =
        ancestors.some((entry) => entry.type.startsWith("TS")) ||
        (parent?.type === "JSXAttribute" && parent.name?.name === "shape") ||
        (path.endsWith("ui/control-shape.tsx") &&
          ancestors.some((entry) => entry.type === "ReturnStatement")) ||
        ancestors.some(
          (entry) =>
            entry.type === "CallExpression" &&
            (entry.callee?.name === "resolveControlShape" ||
              ["toBe", "toEqual", "toStrictEqual"].includes(entry.callee?.property?.name)),
        ) ||
        ancestors.some(
          (entry) =>
            entry.type === "ForOfStatement" &&
            entry.left?.declarations?.some((declaration) => declaration.id?.name === "shape"),
        );
      if (semantic) offsets.add(node.start);
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) for (const child of value) walk(child, [...ancestors, node]);
      else if (value && typeof value === "object") walk(value, [...ancestors, node]);
    }
  }
  walk(ast);
  return offsets;
}
