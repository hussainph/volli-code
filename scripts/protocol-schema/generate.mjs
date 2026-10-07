import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { createServer } from "vite-plus";

import { protocolChanges, protocolReportLines, unapprovedChanges } from "./compatibility.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const schemaPath = "docs/protocol/protocol.schema.json";
const exceptionPath = "docs/protocol/compatibility-allowlist.json";
const args = process.argv.slice(2);
const checking = args.includes("--check");
const baseIndex = args.indexOf("--base");
const base = baseIndex < 0 ? undefined : args[baseIndex + 1];
if (baseIndex >= 0 && (!base || base.startsWith("-")))
  throw new Error("--base requires a git revision");

/** Object keys are canonical; array order (including enums) is declaration order. */
export function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.keys(value)
      .toSorted()
      .map((key) => [key, stable(value[key])]),
  );
}

const server = await createServer({
  root,
  configFile: false,
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, watch: null },
  appType: "custom",
});
try {
  const { generateProtocolSchema } = await server.ssrLoadModule(
    "/packages/session-rpc/src/protocol-schema.ts",
  );
  const generated = stable(generateProtocolSchema());
  const content = `${JSON.stringify(generated, null, 2)}\n`;
  if (checking) {
    if ((await readFile(new URL(`../../${schemaPath}`, import.meta.url), "utf8")) !== content)
      throw new Error(`Stale ${schemaPath}; run pnpm generate:protocol-schema`);
    console.log(`Fresh schema: ${schemaPath}`);
  } else {
    await writeFile(new URL(`../../${schemaPath}`, import.meta.url), content);
    console.log(`Generated ${schemaPath}`);
  }
  if (base) {
    // Only an absent artifact may bootstrap. Invalid refs/git failures are not
    // silently treated as the initial baseline.
    const paths = execFileSync("git", ["ls-tree", "--name-only", base, "--", schemaPath], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    if (paths) {
      const previous = JSON.parse(
        // The published schema is past Node's 1 MiB default output buffer (VC-565).
        execFileSync("git", ["show", `${base}:${schemaPath}`], {
          cwd: root,
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
        }),
      );
      const allowlist = JSON.parse(
        await readFile(new URL(`../../${exceptionPath}`, import.meta.url), "utf8"),
      );
      for (const line of protocolReportLines(protocolChanges(previous, generated)))
        console.log(line);
      const changes = unapprovedChanges(previous, generated, allowlist);
      if (changes.length)
        throw new Error(
          `Non-additive protocol changes:\n${changes.map(({ path, reason }) => `  ${path}: ${reason}`).join("\n")}`,
        );
      console.log(`Additive protocol check passed against ${base}`);
    } else {
      console.log(`Initial schema baseline: ${base} has no ${schemaPath}`);
    }
  }
} finally {
  await server.close();
}
