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
};

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
