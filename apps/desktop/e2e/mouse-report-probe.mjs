import { appendFileSync, writeFileSync } from "node:fs";

const [outputPath, readyPath] = process.argv.slice(2);

if (!outputPath || !readyPath) {
  throw new Error("usage: mouse-report-probe.mjs <output-path> <ready-path>");
}

process.stdin.setRawMode?.(true);
process.stdin.resume();

const stop = () => {
  process.stdout.write("\u001b[?1000l\u001b[?1006l");
  process.exit(0);
};

process.stdin.on("data", (chunk) => {
  appendFileSync(outputPath, chunk.toString("hex") + "\n");
  if (chunk.includes(0x03)) stop();
});

process.on("SIGTERM", stop);
process.stdout.write("\u001b[?1000h\u001b[?1006h");
writeFileSync(readyPath, "ready\n");
