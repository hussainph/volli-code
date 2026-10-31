import { createServer } from "node:http";
import { expect, it } from "vite-plus/test";

import { LIVE_DOCTOR_PORTS, liveReach } from "./ports";

it("routes the real Node fetch probe through the command's proxy without a startup env flag", async () => {
  const destinations: (string | undefined)[] = [];
  const proxy = createServer((request, response) => {
    destinations.push(request.url);
    response.end("ok");
  });
  proxy.on("connect", (request, socket) => {
    destinations.push(request.url);
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    socket.once("data", () =>
      socket.end("HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: 2\r\n\r\nok"),
    );
  });
  await new Promise<void>((done) => proxy.listen(0, "127.0.0.1", done));
  const address = proxy.address() as { port: number };
  const restore = LIVE_DOCTOR_PORTS.configureProxy({
    HTTP_PROXY: `http://127.0.0.1:${address.port}`,
    NO_PROXY: "",
  });
  try {
    expect(await liveReach("http://doctor-probe.invalid/")).toMatchObject({
      reachable: true,
      status: 200,
    });
    expect(destinations).toContain("doctor-probe.invalid:80");
  } finally {
    restore();
    await new Promise<void>((done) => proxy.close(() => done()));
  }
});
