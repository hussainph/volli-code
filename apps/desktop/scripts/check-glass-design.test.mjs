import assert from "node:assert/strict";
import test from "node:test";

import { inspectGlass } from "./check-glass-design.mjs";
import { checkAllowlist } from "./design-guardrail-allowlist.mjs";

const PATH = "apps/desktop/src/renderer/src/components/example.tsx";
const cssPath = PATH.replace(".tsx", ".css");
const rules = (source, path = PATH) => inspectGlass(path, source).map((item) => item.rule);

const cases = [
  ['import { SearchIcon } from "@phosphor-icons/react";', ["icon-set-import"]],
  ['import { SearchIcon } from "@phosphor-icons/react/dist/csr/Search";', ["icon-set-import"]],
  ['import { HugeiconsIcon } from "@hugeicons/react";', ["icon-set-import"]],
  ['import { Search01Icon } from "@hugeicons/core-free-icons";', ["icon-set-import"]],
  ['export { Search01Icon } from "@hugeicons/core-free-icons";', ["icon-set-import"]],
  ['export * from "@hugeicons/core-free-icons";', ["icon-set-import"]],
  ['const icons = import("@hugeicons/core-free-icons");', ["icon-set-import"]],
  ['import { SearchIcon } from "@renderer/components/ui/icon";', []],
  ['// import { X } from "@phosphor-icons/react";', []],
  [
    'import { Search01Icon } from "@hugeicons/core-free-icons";',
    [],
    "apps/desktop/src/renderer/src/components/ui/icon.tsx",
  ],
  [
    'import { HugeiconsIcon } from "@hugeicons/react";',
    [],
    "apps/desktop/src/renderer/src/components/ui/icon.tsx",
  ],
  [
    'import { Search01Icon } from "@hugeicons/core-stroke-rounded";',
    ["icon-set-import"],
    "apps/desktop/src/renderer/src/components/ui/icon.tsx",
  ],
  [
    'import * as pack from "@hugeicons/core-free-icons";',
    ["icon-set-import"],
    "apps/desktop/src/renderer/src/components/ui/icon.tsx",
  ],

  ['<p className="text-[13px]/6" />', ["type-literal-size"]],
  ['import { useReducedMotion } from "another-library";', ["motion-reduced-hook"]],
  ['const color = "#fff";', [], "apps/desktop/src/renderer/src/theme/canvas-paint.ts"],
  ['const row = { className: "duration-200" } as const;', ["motion-literal"]],
  ['<div style={{ color: "white" }} />', ["colour-literal"]],
  ['<div style={{ transition: "opacity 200ms ease-out" }} />', ["motion-literal"]],
  ['<div style={{ color: "#c08a62" }} />', ["colour-literal"]],
  ['<div className="bg-[#fff]" />', ["colour-literal"]],
  ["const paint = `rgb(10 20 30 / ${alpha})`;", ["colour-literal"]],
  ['<div className="hover:bg-red-500" />', ["colour-literal"]],
  ['<div className="bg-card text-foreground" />', []],
  ['<div style={{ color: "var(--foreground)" }} />', []],
  ['// #fff duration-200\ntype X = "#fff";', []],
  ['<p className="md:text-[13px]" />', ["type-literal-size"]],
  ['<p className="text-[var(--text-ui)] text-ui" />', []],
  ['<p className="uppercase" />', ["eyebrow-uppercase"]],
  ['<p className="normal-case" />', []],
  ['<I weight={active ? "fill" : "duotone"} />', ["icon-duotone"]],
  ['const icon = { weight: "duotone" };', ["icon-duotone"]],
  ['<I weight="bold" />', []],
  ['<div className="supports-[display:grid]:backdrop-blur-lg" />', ["material-hand-rolled-blur"]],
  ['<div className="[backdrop-filter:blur(8px)]" />', ["material-hand-rolled-blur"]],
  ['<div style={{ backdropFilter: "blur(8px)" }} />', ["material-hand-rolled-blur"]],
  ['<div className="backdrop-filter-none backdrop-blur-none glass" />', []],
  ['<div className="hover:rounded-[10px]" />', ["radius-off-scale"]],
  ['<div className="rounded-2xl" />', ["radius-off-scale"]],
  ['<div className="rounded rounded-full" />', ["radius-off-scale"]],
  ['<div className="rounded-control rounded-card rounded-t-none rounded-floating" />', []],
  ["<div style={{ borderRadius: 10 }} />", ["radius-off-scale"]],
  ['<div style={{ borderRadius: "var(--radius-card)" }} />', []],
  ['<div className="data-[state=open]:duration-200" />', ["motion-literal"]],
  ['<div className="duration-0 ease-out duration-(--duration-snappy)" />', []],
  ['<div className="ease-in-out" />', ["motion-literal"]],
  [
    "const transition = { duration: .2, ease: [0, .1, .2, 1] };",
    ["motion-literal", "motion-literal"],
  ],
  ["const transition = { duration: durationToken, ease: curveToken };", []],
  ['import { useReducedMotion as reduced } from "motion/react";', ["motion-reduced-hook"]],
  ['import * as motion from "motion/react";', ["motion-reduced-hook"]],
  ['import { motion } from "motion/react";', []],
  ['import { useReducedMotion } from "@renderer/hooks/use-reduced-motion";', []],
];
for (const [source, expected, path = PATH] of cases)
  test(source, () => assert.deepEqual(rules(source, path), expected));

test("CSS declarations, comments, variables and zero resets", () => {
  assert.deepEqual(
    rules(
      "/* color: #fff */ .x { color: var(--foreground); border-radius: var(--radius-card); transition: opacity var(--duration-press) var(--ease-out); }",
      cssPath,
    ),
    [],
  );
  assert.deepEqual(
    rules(".x { color: #fff; border-radius: 7px; transition: opacity 200ms ease-out; }", cssPath),
    ["colour-literal", "radius-off-scale", "motion-literal"],
  );
  assert.deepEqual(rules(".x { transition-duration: 0ms; border-radius: 0; }", cssPath), []);
  assert.deepEqual(rules(".x { backdrop-filter: blur(8px); }", cssPath), [
    "material-hand-rolled-blur",
  ]);
});
test("only the material owner's CSS may draw backdrop filtering", () => {
  const globals = "apps/desktop/src/renderer/src/globals.css";
  assert.deepEqual(rules(".glass { backdrop-filter: blur(20px); }", globals), []);
  assert.deepEqual(rules(".unrelated { backdrop-filter: blur(20px); }", globals), [
    "material-hand-rolled-blur",
  ]);
  assert.deepEqual(rules(".glass { backdrop-filter: blur(20px); }", cssPath), [
    "material-hand-rolled-blur",
  ]);
});
test("generated fallback blocks only are exempt from literal colour checks", () => {
  const globals = "apps/desktop/src/renderer/src/globals.css";
  const source =
    "/* GENERATED THEME TOKENS — BEGIN */\n:root { --foreground: #fff; }\n/* GENERATED THEME TOKENS — END */\n.x { color: #fff; }";
  assert.deepEqual(rules(source, globals), ["colour-literal"]);
  assert.equal(inspectGlass(globals, source)[0].line, 4);
});
test("only globals may define numeric geometry/motion tokens", () => {
  assert.deepEqual(rules(":root { --duration-custom: 200ms; --radius-new: 9px; }", cssPath), [
    "motion-literal",
    "radius-off-scale",
  ]);
  assert.deepEqual(
    rules(
      ":root { --duration-snappy: 225ms; --radius-card: 10px; }",
      "apps/desktop/src/renderer/src/globals.css",
    ),
    [],
  );
});
test("allowlist grows neither pairs nor occurrence ceilings; repairs require shrinkage", () => {
  const finding = { path: PATH, rule: "colour-literal" };
  const entry = { ...finding, maxCount: 1, reason: "Pending adoption" };
  assert.deepEqual(checkAllowlist([finding], [entry], [entry.rule]), { unexcused: [], stale: [] });
  assert.equal(checkAllowlist([finding, finding], [entry], [entry.rule]).unexcused.length, 2);
  assert.equal(checkAllowlist([], [entry], [entry.rule]).stale.length, 1);
  assert.equal(checkAllowlist([finding], [], [entry.rule]).unexcused.length, 1);
  assert.throws(() => checkAllowlist([], [entry, entry], [entry.rule]), /duplicate/);
  assert.throws(
    () => checkAllowlist([], [{ ...entry, rule: "unknown" }], [entry.rule]),
    /Malformed/,
  );
  assert.throws(() => checkAllowlist([], [{ ...entry, reason: "" }], [entry.rule]), /Malformed/);
});
