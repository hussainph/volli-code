import assert from "node:assert/strict";
import { test } from "node:test";

import { menuRowIndexFor } from "./strip-tabs.mjs";

const rows = [
  "Chat, pane 1, showing",
  "Session 1, pane 2",
  "Session 10, pane 2, behind",
  "Page, pane 3",
];

test("finds the menu row a folded tab's name belongs to", () => {
  assert.equal(menuRowIndexFor("Session 1", rows), 1);
  assert.equal(menuRowIndexFor("Page", rows), 3);
});

test("prefers the longest label, so Session 10 is not taken for Session 1", () => {
  assert.equal(menuRowIndexFor("Session 10", rows), 2);
});

test("matches a name that carries a hint after its label", () => {
  assert.equal(menuRowIndexFor("Chat\nWaiting for you", rows), 0);
});

test("answers -1 when no row names the tab", () => {
  assert.equal(menuRowIndexFor("Missing", rows), -1);
  assert.equal(menuRowIndexFor("Missing", [null]), -1);
});
