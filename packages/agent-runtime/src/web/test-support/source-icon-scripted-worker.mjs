// Parent-gate wire fixtures, not a replacement for the real libvips tests.
import { parentPort } from "node:worker_threads";
const port = parentPort;
const ready = (data) => ({ type: "ready", bytes: data });
port.once("message", ({ bytes }) => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/6ZkAAAAASUVORK5CYII=",
    "base64",
  );
  const cases = [
    null,
    [],
    "invalid",
    {},
    { type: "omitted" },
    ready("not bytes"),
    ready(new Uint8Array()),
    ready(new Uint8Array(65537)),
    ready(png.subarray(0, 32)),
  ];
  let answer;
  const code = bytes[0];
  if (code < cases.length) answer = cases[code];
  else {
    if (code === 9) png[0] = 0;
    if (code === 10) png.write("XXXX", 12);
    if (code === 11) png.writeUInt32BE(0, 16);
    if (code === 12) png.writeUInt32BE(0, 20);
    if (code === 13) png.writeUInt32BE(65, 16);
    if (code === 14) png.writeUInt32BE(65, 20);
    answer = ready(png);
  }
  port.postMessage(answer);
  port.close();
});
