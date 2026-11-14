import assert from "node:assert/strict";
import test from "node:test";

import {
  boundedHasArgument,
  checkRelationalAllowlist,
  inspectRelationalSelectors,
  tailwindHasArguments,
} from "./check-relational-selectors.mjs";

const TSX = "apps/desktop/src/renderer/src/components/example.tsx";
const CSS = "apps/desktop/src/renderer/src/example.css";
const args = (source, path = TSX) =>
  inspectRelationalSelectors(path, source).map((item) => item.argument);

test("a :has() argument is bounded only when every branch steps by > + or ~", () => {
  for (const argument of [
    "> a",
    ">a",
    "> * > [data-control=button].control-material",
    '> [data-control="button"].control-material, > * > [data-control="button"].control-material',
    "+ .b",
    "~ .b > .c",
    "> :is(.a .b)",
    "> [data-x='a b']",
  ])
    assert.equal(boundedHasArgument(argument), true, argument);
  for (const argument of [
    '[data-slot="conversation-scroll-button"]',
    ":checked",
    "textarea:focus-visible",
    "> a .b",
    "> a, .b",
    ":is(select[aria-hidden=true]:last-child)",
  ])
    assert.equal(boundedHasArgument(argument), false, argument);
});

test("the rule VC-1231 removed is caught, and its replacement is not", () => {
  const before =
    '.chat-transcript:has([data-slot="conversation-scroll-button"]) [data-conversation-viewport] {\n  --x: 1px;\n}';
  assert.deepEqual(args(before, CSS), ['[data-slot="conversation-scroll-button"]']);
  const after = ".chat-transcript [data-conversation-viewport][data-scroll-button] { --x: 1px; }";
  assert.deepEqual(args(after, CSS), []);
});

test("CSS: nested and bounded rules, comments and declarations", () => {
  const css = [
    "/* .a:has(.ignored) */",
    ".control-group:not(:has(> [data-slot=button-group])):has(> [data-control=button], > * > [data-control=button]) {",
    "  box-shadow: none;",
    "  & > :has(.deep) { color: red; }",
    "}",
    ".x:has(.a, > .b) {}",
  ].join("\n");
  assert.deepEqual(args(css, CSS), [".deep", ".a, > .b"]);
  assert.equal(inspectRelationalSelectors(CSS, css)[0].line, 4);
});

test("Tailwind variants generate the :has() arguments Tailwind would", () => {
  assert.deepEqual(tailwindHasArguments("has-[>textarea]:h-auto"), [">textarea"]);
  assert.deepEqual(tailwindHasArguments("has-[:checked]:bg-accent"), [":checked"]);
  assert.deepEqual(tailwindHasArguments("has-checked:bg-accent"), [":checked"]);
  assert.deepEqual(tailwindHasArguments("has-data-[slot=media]:grid"), ["[data-slot=media]"]);
  assert.deepEqual(tailwindHasArguments("group-has-[.x_.y]:block"), [".x .y"]);
  assert.deepEqual(tailwindHasArguments("[&_div:has(>[data-slot=input])>span]:font-medium"), [
    ">[data-slot=input]",
  ]);
  assert.deepEqual(tailwindHasArguments("hover:bg-accent"), []);
  assert.deepEqual(tailwindHasArguments("has-[>[data-slot=x]]:gap-2"), [">[data-slot=x]"]);
});

test("TSX: class strings are read; comments and types are not", () => {
  const source = [
    "// has-[.comment]:block",
    "type T = 'has-[.type]:block';",
    'const a = <div className="flex has-[>input]:gap-1 has-[.deep]:gap-2" />;',
    "const b = `p-2 ${x} has-[[data-state=open]]:opacity-100`;",
  ].join("\n");
  assert.deepEqual(args(source), [".deep", "[data-state=open]"]);
});

test("the allowlist excuses listed arguments and reports stale ones", () => {
  const findings = [{ path: TSX, line: 1, argument: ":checked", context: "" }];
  const listed = { path: TSX, argument: ":checked", reason: "a label around one input" };
  const gone = { path: TSX, argument: ".gone", reason: "removed" };
  assert.deepEqual(checkRelationalAllowlist(findings, [listed]), { unexcused: [], stale: [] });
  assert.deepEqual(checkRelationalAllowlist(findings, [listed, gone]).stale, [gone]);
  assert.deepEqual(checkRelationalAllowlist(findings, []).unexcused, findings);
  assert.throws(() => checkRelationalAllowlist([], [{ path: TSX, argument: ":checked" }]));
});
