import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(desktopDir, "../../packages/cli/dist/volli.cjs");
const destination = resolve(desktopDir, "dist-electron/volli-cli.cjs");

await mkdir(dirname(destination), { recursive: true });
await copyFile(source, destination);
