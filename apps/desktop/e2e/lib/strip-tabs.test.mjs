import assert from "node:assert/strict";
import { test } from "node:test";

import { menuRowIndexFor, readChipRows, selectStripTab, ungroupChip } from "./strip-tabs.mjs";

// A chip popover's row titles, in pane order.
const titles = ["Chat", "Session 1", "Session 10", "Page"];

test("finds the popover row a tab's name belongs to", () => {
  assert.equal(menuRowIndexFor("Session 1", titles), 1);
  assert.equal(menuRowIndexFor("Page", titles), 3);
});

test("prefers the longest title, so Session 10 is not taken for Session 1", () => {
  assert.equal(menuRowIndexFor("Session 10", titles), 2);
});

test("matches a name that carries a hint after its label", () => {
  assert.equal(menuRowIndexFor("Chat\nWaiting for you", titles), 0);
  assert.equal(menuRowIndexFor("Page · 127.0.0.1:5173/settings", titles), 3);
});

test("ignores surrounding whitespace in a row title", () => {
  assert.equal(menuRowIndexFor("Page", ["  Page \n"]), 0);
});

test("answers -1 when no row names the tab", () => {
  assert.equal(menuRowIndexFor("Missing", titles), -1);
  assert.equal(menuRowIndexFor("Missing", [null]), -1);
  assert.equal(menuRowIndexFor("Missing", [""]), -1);
});

// --- selectStripTab's two accepted target forms -----------------------------
//
// A minimal Playwright-shaped fake: just the surface the helper touches. The
// callbacks the helper hands to evaluate/evaluateAll run here in Node, so
// `window`/`document` stubs stand in for the browser for `parkPointer`.
globalThis.window = { innerWidth: 800, innerHeight: 600 };
globalThis.document = { elementFromPoint: () => null };

const CHIP = '[data-slot="grouped-tab-chip"]';
const POPOVER = '[data-slot="grouped-tab-popover"]';
const ROW = '[data-slot="grouped-tab-row"]';

function fakeRow({ id, title, pane = 1, front = false, name }) {
  return {
    getAttribute: (attr) =>
      attr === "data-tab-id"
        ? id
        : attr === "data-pane"
          ? String(pane)
          : attr === "data-front"
            ? String(front)
            : attr === "aria-label"
              ? (name ?? title)
              : null,
    querySelector: (selector) =>
      selector === ".truncate.text-ui" ? { textContent: ` ${title} ` } : null,
  };
}

function fakeLocator(name, spec = {}, calls = [], specs = {}) {
  const loc = {
    first() {
      return loc;
    },
    and() {
      return loc;
    },
    nth() {
      return loc;
    },
    isVisible: async () => spec.visible ?? false,
    count: async () => spec.count ?? 0,
    getAttribute: async (attr) => (spec.attrs ?? {})[attr] ?? null,
    evaluateAll: async (fn) => fn(spec.elements ?? []),
    waitFor: async () => {},
    scrollIntoViewIfNeeded: async () => {},
    boundingBox: async () => ({ x: 0, y: 0, width: 8, height: 8 }),
    getByRole: (role, options) =>
      fakeLocator(
        `${name} ${role}${options?.name === undefined ? "" : ` ${JSON.stringify(options.name)}`}`,
        spec,
        calls,
        specs,
      ),
    filter: () => fakeLocator(`${name} filtered`, spec, calls, specs),
    locator: (selector) =>
      fakeLocator(
        `${name} ${selector}`,
        spec.children?.[selector] ??
          specs[selector] ??
          (selector.includes("grouped-tab-chip")
            ? { count: spec.inChip ?? 0 }
            : selector.includes("tab-label")
              ? { visible: spec.hasLabel ?? false }
              : {}),
        calls,
        specs,
      ),
    click: async (options) => {
      calls.push(["click", name, options?.button ?? "left"]);
    },
    focus: async () => {
      calls.push(["focus", name]);
    },
    press: async (key) => {
      calls.push(["press", name, key]);
    },
  };
  return loc;
}

function fakePage(locatorSpecs = {}) {
  const calls = [];
  return {
    calls,
    locator: (selector) => fakeLocator(selector, locatorSpecs[selector] ?? {}, calls, locatorSpecs),
    evaluate: async (fn) => fn(),
    mouse: {
      move: async (x, y) => {
        calls.push(["move", x, y]);
      },
    },
  };
}

const chipElement = (groupId) => ({
  getAttribute: (attr) => (attr === "data-group-id" ? groupId : null),
});

test("a RAW LOCATOR (main's form) activates an ordinary tab with Enter, never a click", async () => {
  const page = fakePage();
  const tab = fakeLocator("chat tab", { visible: true }, page.calls);
  await selectStripTab(page, tab);
  assert.deepEqual(
    page.calls.filter(([kind]) => kind !== "move"),
    [
      ["focus", "chat tab"],
      ["press", "chat tab", "Enter"],
    ],
  );
});

test("a RAW LOCATOR inside a chip clicks the tab's label, never its centre", async () => {
  const page = fakePage();
  const front = fakeLocator("chip front", { visible: true, inChip: 1, hasLabel: true }, page.calls);
  await selectStripTab(page, front);
  assert.deepEqual(
    page.calls.filter(([kind]) => kind !== "move"),
    [["click", 'chip front [data-slot="tab-label"]', "left"]],
  );
});

test("descriptor { tab, id } (VC-1052's form) behaves like the raw locator", async () => {
  const page = fakePage();
  const tab = fakeLocator("chat tab", { visible: true }, page.calls);
  await selectStripTab(page, { tab, id: "chat:1" });
  assert.deepEqual(
    page.calls.filter(([kind]) => kind !== "move"),
    [
      ["focus", "chat tab"],
      ["press", "chat tab", "Enter"],
    ],
  );
});

test("descriptor { id } (main's form) finds an ORDINARY strip tab by its data-strip-tab-id", async () => {
  const page = fakePage({
    '[data-strip-tab-id="chat:1"]': { visible: true },
  });
  await selectStripTab(page, { id: "chat:1" });
  // Activated on the strip — no chip was right-clicked.
  assert.deepEqual(
    page.calls.filter(([kind]) => kind !== "move"),
    [
      ["focus", '[data-strip-tab-id="chat:1"] tab filtered'],
      ["press", '[data-strip-tab-id="chat:1"] tab filtered', "Enter"],
    ],
  );
});

test("descriptor { label } (main's form) finds an ORDINARY strip tab by its name", async () => {
  const page = fakePage({
    '[data-slot="tab-strip"] [data-strip-tab-id]': { visible: true },
  });
  await selectStripTab(page, { label: "Chat" });
  assert.deepEqual(
    page.calls.filter(([kind]) => kind !== "move"),
    [
      ["focus", '[data-slot="tab-strip"] [data-strip-tab-id] tab "Chat" filtered'],
      ["press", '[data-slot="tab-strip"] [data-strip-tab-id] tab "Chat" filtered', "Enter"],
    ],
  );
});

test("descriptor { id } with the tab in NO strip falls back to a chip's popover", async () => {
  const page = fakePage({
    [`${CHIP}:visible`]: { elements: [chipElement("g1")] },
    [`${CHIP}[data-group-id="g1"]`]: {},
    [POPOVER]: {},
    [ROW]: { elements: [fakeRow({ id: "chat:1", title: "Chat", front: true })] },
  });
  await selectStripTab(page, { id: "chat:1" }, { strip: page.locator("body") });
  assert.ok(
    page.calls.some(
      ([kind, name, button]) => kind === "click" && name.endsWith(ROW) && button === "left",
    ),
  );
});

test("descriptor { label } (main's form) matches a popover row by title", async () => {
  const page = fakePage({
    [`${CHIP}:visible`]: { elements: [chipElement("g1")] },
    [`${CHIP}[data-group-id="g1"]`]: {},
    [POPOVER]: {},
    [ROW]: {
      elements: [
        fakeRow({ id: "session:1", title: "Session 1" }),
        fakeRow({ id: "session:10", title: "Session 10", front: true }),
      ],
    },
  });
  await selectStripTab(page, { label: "Session 10" }, { strip: page.locator("body") });
  assert.ok(
    page.calls.some(
      ([kind, name, button]) => kind === "click" && name.endsWith(ROW) && button === "left",
    ),
  );
});

test("neither form resolves: the error names what was sought", async () => {
  const page = fakePage();
  const tab = fakeLocator("chat tab", { visible: false }, page.calls);
  await assert.rejects(
    selectStripTab(page, tab, { timeout: 60 }),
    /neither on the strip nor in any group chip's popover/,
  );
  await assert.rejects(selectStripTab(page, { id: "chat:9" }, { timeout: 60 }), /chat:9/);
});

test("readChipRows reads each popover row's id, pane, front and title", async () => {
  const page = fakePage({
    [POPOVER]: {},
    [ROW]: {
      elements: [
        fakeRow({
          id: "chat:1",
          title: "Chat",
          pane: 1,
          front: true,
          name: "Chat, Waiting for you",
        }),
        fakeRow({ id: "browser:7", title: "Agent Fixture", pane: 2, front: false }),
      ],
    },
  });
  const chip = fakeLocator("group chip", {}, page.calls);
  const rows = await readChipRows(page, chip);
  assert.deepEqual(rows, [
    {
      id: "chat:1",
      pane: 1,
      front: true,
      title: "Chat",
      name: "Chat, Waiting for you",
    },
    { id: "browser:7", pane: 2, front: false, title: "Agent Fixture", name: "Agent Fixture" },
  ]);
});

test("ungroupChip right-clicks the chip and chooses its popover's Ungroup row", async () => {
  const ungroupRow = '[data-slot="grouped-tab-ungroup"]';
  const page = fakePage({ [POPOVER]: {}, [ungroupRow]: {} });
  const chip = fakeLocator("group chip", {}, page.calls);
  await ungroupChip(page, chip);
  assert.ok(
    page.calls.some(
      ([kind, name, button]) => kind === "click" && name === "group chip" && button === "right",
    ),
  );
  assert.ok(page.calls.some(([kind, name]) => kind === "click" && name.endsWith(ungroupRow)));
});
