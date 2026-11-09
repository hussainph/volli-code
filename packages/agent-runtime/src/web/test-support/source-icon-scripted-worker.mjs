// Parent-gate wire fixtures, not a replacement for the real libvips tests.
import { parentPort } from "node:worker_threads";
const port = parentPort;
const ready = (data) => ({ type: "ready", bytes: data });
port.once("message", ({ bytes }) => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/6ZkAAAAASUVORK5CYII=",
    "base64",
  );
  let answer;
  // Stable wire codes: never infer the success case from an array boundary.
  switch (bytes[0]) {
    case 0:
      answer = null;
      break; // null reply
    case 1:
      answer = [];
      break; // array reply
    case 2:
      answer = "invalid";
      break; // string reply
    case 3:
      answer = {};
      break; // missing reply type
    case 4:
      answer = { type: "omitted" };
      break;
    case 5:
      answer = ready("not bytes");
      break;
    case 6:
      answer = ready(new Uint8Array());
      break;
    case 7:
      answer = ready(new Uint8Array(65537));
      break;
    case 8:
      answer = ready(png.subarray(0, 32));
      break;
    case 9:
      png[0] = 0;
      answer = ready(png);
      break; // invalid signature
    case 10:
      png.write("XXXX", 12);
      answer = ready(png);
      break; // missing IHDR
    case 11:
      png.writeUInt32BE(0, 16);
      answer = ready(png);
      break; // zero width
    case 12:
      png.writeUInt32BE(0, 20);
      answer = ready(png);
      break; // zero height
    case 13:
      png.writeUInt32BE(65, 16);
      answer = ready(png);
      break; // oversized width
    case 14:
      png.writeUInt32BE(65, 20);
      answer = ready(png);
      break; // oversized height
    case 15:
      answer = ready(png);
      break; // valid original one-pixel PNG
    default:
      throw new Error(`Unknown scripted icon reply code ${bytes[0]}`);
  }
  port.postMessage(answer);
  if (bytes[1] === 1) {
    // A real live thread for the physical-lease ordering test. The parent's
    // independent finally must terminate it even when production teardown fails.
    port.once("message", (control) => {
      if (control?.action === "throw-after-reply") throw new Error("scripted late worker failure");
      port.close();
    });
  } else port.close();
});
