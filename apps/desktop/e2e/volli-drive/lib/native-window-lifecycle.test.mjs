import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";
import { quitNativeWindow, reopenNativeWindow } from "./native-window-lifecycle.mjs";

function fixture() {
  const calls = [];
  const old = new EventEmitter();
  old.closed = false;
  old.isClosed = () => old.closed;
  old.waitForEvent = (name, options) => {
    calls.push(["old.wait", name, options]);
    return new Promise((resolve) => old.once(name, resolve));
  };
  old.close = () => {
    old.closed = true;
    old.emit("close");
  };
  const fresh = {
    isClosed: () => false,
    waitForLoadState: async (state, options) => calls.push(["load", state, options]),
  };
  const app = new EventEmitter();
  app.createImmediately = true;
  app.closeImmediately = false;
  app.visible = true;
  app.waitForEvent = (name, options) => {
    calls.push(["app.wait", name, options]);
    return new Promise((resolve) => app.once(name, resolve));
  };
  // Reproduce the old ordering even after activation: firstWindow and the
  // first entry in windows still point at the retiring Page.
  app.firstWindow = () => {
    throw new Error("firstWindow returned the retiring Page");
  };
  app.windows = () => [old, fresh];
  app.evaluate = async (run) =>
    run({
      Menu: {
        getApplicationMenu: () => ({ items: [{ role: "quit", label: "Quit Volli" }] }),
        sendActionToFirstResponder: (selector) => {
          calls.push(["quit", selector]);
          app.visible = false;
          if (app.closeImmediately) old.close();
        },
      },
      BrowserWindow: {
        getAllWindows: () => (old.closed ? [] : [{ isVisible: () => app.visible }]),
      },
      app: {
        emit: (name) => {
          calls.push(["activate", name]);
          if (app.createImmediately) app.emit("window", fresh);
        },
      },
    });
  return { calls, old, fresh, app };
}

test("hidden but retiring main Page is not a completed Quit; close precedes reopen", async () => {
  const { calls, old, app, fresh } = fixture();
  let quitFinished = false;
  const quit = quitNativeWindow(app, old).then((result) => {
    quitFinished = true;
    return result;
  });
  await Promise.resolve();
  assert.equal(app.visible, false);
  assert.equal(quitFinished, false, "visible:0/retained:1 cannot race ahead of the close event");
  assert.deepEqual(calls.slice(0, 2), [
    ["old.wait", "close", { timeout: 10_000 }],
    ["quit", "terminate:"],
  ]);
  old.close();
  assert.deepEqual(await quit, { label: "Quit Volli", nativeWindows: { visible: 0, retained: 0 } });
  const page = await reopenNativeWindow(app);
  assert.equal(page, fresh);
  assert.deepEqual(calls.slice(2, 4), [
    ["app.wait", "window", { timeout: 10_000 }],
    ["activate", "activate"],
  ]);
  assert.equal(calls[4][1], "domcontentloaded");
  assert.ok(calls[4][2].timeout <= 10_000);
});

test("synchronous close cannot beat the close listener", async () => {
  const { app, old } = fixture();
  app.closeImmediately = true;
  await quitNativeWindow(app, old);
  assert.equal(old.isClosed(), true);
});

test("a window event after activation binds its Page, never the still-first old Page", async () => {
  const { app, fresh } = fixture();
  app.createImmediately = false;
  let bound = false;
  const reopening = reopenNativeWindow(app).then((page) => {
    bound = true;
    return page;
  });
  await Promise.resolve();
  assert.equal(bound, false);
  app.emit("window", fresh);
  assert.equal(await reopening, fresh);
});

test("close and replacement failures propagate without retries or fabricated readiness", async () => {
  const { app, old } = fixture();
  old.waitForEvent = async () => {
    throw new Error("old Page never closed");
  };
  await assert.rejects(quitNativeWindow(app, old), /old Page never closed/u);
  let events = 0;
  app.waitForEvent = async () => {
    events++;
    throw new Error("replacement missing");
  };
  await assert.rejects(reopenNativeWindow(app), /replacement missing/u);
  assert.equal(events, 1);
});

test("the supervisor snapshots the explicitly rebound Page, not windows()[0]", async () => {
  const source = readFileSync(new URL("../supervisor.mjs", import.meta.url), "utf8");
  const body = source.slice(
    source.indexOf("async function windowsList()"),
    source.indexOf("function wireWindow(page)"),
  );
  const { app, fresh, old } = fixture();
  const pick = new Function("app", "mainPage", `${body}; return pickWindow;`)(app, fresh);
  assert.equal((await pick("main")).page, fresh);
  assert.equal((await pick()).page, fresh);
  for (const [page, title] of [
    [old, "Retiring"],
    [fresh, "Volli"],
  ]) {
    page.title = async () => title;
    page.url = () => "about:blank";
  }
  const list = new Function("app", "mainPage", `${body}; return windowsList;`)(app, fresh);
  assert.deepEqual(
    (await list()).map(({ name }) => name),
    ["window-0", "main"],
  );
  assert.equal((await pick("Volli")).page, fresh);
  assert.match(source, /const label = \(\) => \(page === mainPage \? "main"/u);
  old.close();
  const closed = new Function("app", "mainPage", `${body}; return pickWindow;`)(app, old);
  await assert.rejects(closed("main"), /no bound main window/u);
  const unbound = new Function("app", "mainPage", `${body}; return pickWindow;`)(app, null);
  await assert.rejects(unbound(), /no bound main window/u);
  assert.match(source, /mainPage = await reopenNativeWindow\(app\)/u);
  assert.match(source, /quitNativeWindow\(app, page\);\s*mainPage = null/u);
});
