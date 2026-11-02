import assert from "node:assert/strict";
import { test } from "node:test";

import { menuRowIndexFor } from "./strip-tabs.mjs";

// A chip popover's row titles (`grouped-tab-row-title`), in pane order.
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
