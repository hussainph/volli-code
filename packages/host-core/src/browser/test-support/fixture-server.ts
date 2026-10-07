/**
 * The loopback fixture the backend suite drives (VC-619). Pages are small, with
 * one observable per tool, so every effect is provable from the port's own
 * answers (snapshot text, title, console) without evaluating page script.
 * Scenarios follow `apps/desktop/e2e/browser-tools-stress.mjs` and
 * `browser-page-navigation-smoke.mjs`.
 */
import http from "node:http";

const PAGES: Record<string, string> = {
  "/start": `<!doctype html><html><head><meta charset="utf-8"><title>Stress Start</title></head>
<body>
  <h1>Stress Start</h1>
  <p id="count">Count: 0</p>
  <button id="inc">Increment</button>
  <button id="hov">Hover target</button>
  <form id="f">
    <input id="note" name="note" aria-label="Note" />
    <button type="submit">Submit note</button>
  </form>
  <select id="opt" aria-label="Choose">
    <option value="">Choose…</option>
    <option value="beta">beta</option>
  </select>
  <a id="to-second" href="/second">Second page</a>
  <div style="height: 4000px" aria-hidden="true"></div>
  <script>
    let count = 0;
    document.getElementById("inc").addEventListener("click", () => {
      count += 1;
      document.getElementById("count").textContent = "Count: " + count;
      console.log("stress-clicked-" + count);
    });
    document.getElementById("hov").addEventListener("mouseenter", () => {
      document.title = "Stress Hovered";
    });
    document.getElementById("f").addEventListener("submit", (event) => {
      event.preventDefault();
      document.title = "Stress Typed:" + document.getElementById("note").value;
    });
    document.getElementById("opt").addEventListener("change", (event) => {
      document.title = "Stress Selected:" + event.target.value;
    });
    let scrolled = false;
    window.addEventListener("scroll", () => {
      if (scrolled) return;
      scrolled = true;
      console.log("stress-scroll-marker");
    });
    console.log("stress-console-page-marker");
  </script>
</body></html>`,
  "/console": `<!doctype html><html><head><meta charset="utf-8"><title>Stress Console</title></head>
<body><h1>Console fixture</h1><script>
  console.log("stress-console-log-marker");
  console.warn("stress-console-warn-marker");
  console.error("stress-console-error-marker");
</script></body></html>`,
  "/link": `<!doctype html><title>Link start</title><a href="/linked">Follow plain link</a>`,
  "/linked": `<!doctype html><title>Link destination</title><h1>Link destination</h1>`,
  "/form-button": `<!doctype html><title>Button form</title>
    <form action="/submitted-button" method="get">
      <label>Button query <input name="q"></label>
      <button type="submit">Submit by button</button>
    </form>`,
  "/form-enter": `<!doctype html><title>Enter form</title>
    <form action="/submitted-enter" method="get">
      <label>Enter query <input name="q"></label>
      <button type="submit">Submit by Enter</button>
    </form>`,
  "/submitted-button": "<!doctype html><title>Button submitted</title><h1>Button submitted</h1>",
  "/submitted-enter": "<!doctype html><title>Enter submitted</title><h1>Enter submitted</h1>",
  "/popup": `<!doctype html><title>Popup opener</title>
    <a href="/linked" target="_blank">Open in a new window</a>`,
  "/blob": `<!doctype html><title>Blob opener</title>
    <button onclick="location.href = window.URL.createObjectURL(new Blob(['<title>Blob page</title>'], { type: 'text/html' }))">Go to blob</button>`,
  // A page cannot replace primitives in the backend's isolated policy world.
  "/blob-tampered": `<!doctype html><title>Blob opener</title>
    <script>
      console.error = () => {};
      navigation.addEventListener = () => {};
      if (typeof globalThis.__volliNavigationBlocked !== 'undefined') {
        document.title = 'Exposed policy binding';
      }
    </script>
    <button onclick="location.href = window.URL.createObjectURL(new Blob(['<title>Blob page</title>'], { type: 'text/html' }))">Go to blob</button>`,
  "/long-hash": `<!doctype html><title>Long hash</title>
    <button onclick="history.pushState(null, '', '#' + 'x'.repeat(9000)); document.title = 'hash-length:' + location.hash.length">Long fragment</button>`,
  "/cookie-set": `<!doctype html><title>cookie set</title><script>
    document.cookie = "volli_fixture=present; path=/";
    document.title = "cookie:" + document.cookie;
  </script>`,
  "/cookie-read": `<!doctype html><title>cookie read</title><script>
    document.title = "cookie:" + (document.cookie || "none");
  </script>`,
  "/permission": `<!doctype html><title>permission pending</title><script>
    navigator.permissions.query({ name: "geolocation" }).then(
      (status) => { document.title = "geolocation:" + status.state; },
      () => { document.title = "geolocation:error"; },
    );
  </script>`,
  "/dialog": `<!doctype html><title>Dialog page</title>
    <button onclick="alert('fixture alert'); document.title = 'Dialog dismissed'">Raise alert</button>`,
  // Input-to-frame and frame-rate probes for the parity bench. Static until
  // touched, with no caret, so the first screencast frame after an input is
  // the input's own effect.
  "/latency": `<!doctype html><html><head><meta charset="utf-8"><title>Latency</title>
<style>
  body { margin: 0; font: 32px sans-serif; caret-color: transparent; }
  #target { position: absolute; left: 0; top: 0; width: 400px; height: 300px; background: #222; border: 0; }
  #field { position: absolute; left: 0; top: 320px; width: 600px; font: 32px monospace; outline: none; }
</style></head>
<body>
  <button id="target" aria-label="Paint target"></button>
  <input id="field" aria-label="Latency field" />
  <script>
    let n = 0;
    document.getElementById("target").addEventListener("mousedown", () => {
      n += 1;
      document.getElementById("target").style.background = n % 2 ? "#e33" : "#3e3";
    });
  </script>
</body></html>`,
  "/animate": `<!doctype html><html><head><meta charset="utf-8"><title>Animate</title>
<style>body { margin: 0; } #box { width: 200px; height: 200px; background: #36c;
animation: slide 1s linear infinite alternate; } @keyframes slide { to { margin-left: 800px; } }</style>
</head><body><div id="box"></div></body></html>`,
  "/scroll": `<!doctype html><html><head><meta charset="utf-8"><title>Scroll</title>
<style>body { margin: 0; } .row { height: 40px; font: 24px sans-serif; }
.row:nth-child(odd) { background: #ddd; }</style></head>
<body>${Array.from({ length: 1_000 }, (_, i) => `<div class="row">Row ${i}</div>`).join("")}</body></html>`,
  "/dialogs": `<!doctype html><title>Dialogs</title>
    <button onclick="alert('fixture alert'); document.title = 'alert:done'">Raise alert</button>
    <button onclick="document.title = 'confirm:' + confirm('Sure?')">Ask confirm</button>
    <button onclick="document.title = 'prompt:' + prompt('Name?', 'default')">Ask prompt</button>`,
  // A page guarding unsaved work: leaving it asks first (beforeunload).
  "/guarded": `<!doctype html><title>Guarded draft</title>
    <input aria-label="Draft" />
    <a href="/second">Leave the draft</a>
    <script>
      addEventListener("beforeunload", (event) => { event.preventDefault(); event.returnValue = ""; });
    </script>`,
  // Frames of every kind a page can make. Each that runs says so in the title.
  "/frames": `<!doctype html><title>frames:</title><body><script>
    const ran = new Set();
    addEventListener("message", (event) => {
      ran.add(String(event.data));
      document.title = "frames:" + [...ran].sort().join(",");
    });
    const frame = (src, srcdoc) => {
      const element = document.createElement("iframe");
      if (srcdoc !== undefined) element.srcdoc = srcdoc; else element.src = src;
      document.body.appendChild(element);
    };
    const say = (who) => "<script>parent.postMessage('" + who + "', '*')<" + "/script>";
    frame("data:text/html," + encodeURIComponent(say("data")));
    frame(undefined, say("srcdoc"));
    frame(URL.createObjectURL(new Blob([say("blob")], { type: "text/html" })));
    // Cross-site (localhost is not 127.0.0.1): an out-of-process iframe,
    // which then navigates itself somewhere the policy refuses.
    frame(location.origin.replace("127.0.0.1", "localhost") + "/frame-child?who=oopif&then=long");
    frame("/redirect-long");
    frame("/redirect-ok");
  </script></body>`,
  // A viewer's drag: what buttons the page saw while the pointer moved, and what it selected.
  "/drag": `<!doctype html><html><head><meta charset="utf-8"><title>drag</title>
<style>body { margin: 0; font: 24px monospace; } p { margin: 0; padding: 10px; }</style></head>
<body><p>Select these words by dragging across them</p><script>
  const moves = [];
  addEventListener("mousemove", (event) => moves.push(event.buttons));
  addEventListener("mouseup", () => {
    document.title = "buttons:" + Math.max(0, ...moves) + " selected:" + getSelection().toString();
  });
</script></body></html>`,
  "/external": `<!doctype html><title>External opener</title>
    <button onclick="location.href = 'volli-test-scheme:hello'">Go external</button>`,
};

/** An HTTP(S) address longer than the policy allows: Chromium loads it, Volli must not. */
function overlongPath(who: string): string {
  return `/frame-child?who=${who}&pad=${"x".repeat(9_000)}`;
}

export interface BrowserFixture {
  origin: string;
  url(path: string): string;
  hits(path: string): number;
  close(): Promise<void>;
}

/** A loopback-only server this test process owns. */
export async function startBrowserFixture(): Promise<BrowserFixture> {
  const hits = new Map<string, number>();
  const server = http.createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    hits.set(path, (hits.get(path) ?? 0) + 1);
    if (path === "/dead") {
      request.socket.destroy();
      return;
    }
    response.setHeader("Cache-Control", "no-store");
    if (path === "/favicon.ico") {
      response.statusCode = 204;
      response.end();
      return;
    }
    if (path === "/download") {
      response.setHeader("Content-Type", "application/octet-stream");
      response.setHeader("Content-Disposition", 'attachment; filename="fixture.bin"');
      response.end("fixture download");
      return;
    }
    if (path === "/redirect-long" || path === "/redirect-ok") {
      response.statusCode = 302;
      response.setHeader(
        "Location",
        path === "/redirect-long" ? overlongPath("hop") : "/frame-child?who=hop-ok",
      );
      response.end();
      return;
    }
    if (path === "/frame-child") {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(`<!doctype html><title>frame child</title><script>
        const query = new URLSearchParams(location.search);
        parent.postMessage(query.get("who"), "*");
        if (query.get("then") === "long") {
          setTimeout(() => { location.href = ${JSON.stringify(overlongPath("oopif-long"))}; }, 50);
        }
      </script>`);
      return;
    }
    if (path.startsWith("/hist-") || path === "/second") {
      const title = `Stress ${path.slice(1)}`;
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(`<!doctype html><title>${title}</title><h1>${title}</h1>`);
      return;
    }
    const page = PAGES[path];
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    if (page === undefined) {
      response.statusCode = 404;
      response.end("<!doctype html><title>Not found</title><h1>Not found</h1>");
      return;
    }
    response.end(page);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("The browser fixture did not bind an IPv4 loopback port");
  }
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    url: (path) => `${origin}${path}`,
    hits: (path) => hits.get(path) ?? 0,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
