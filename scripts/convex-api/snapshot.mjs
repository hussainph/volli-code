/** Offline equivalent of the validator portion of `convex function-spec`.
 * The pinned CLI queries a deployment (_system/cli/modules:apiSpec); it cannot
 * inspect codegen offline. Read the registered functions' own exportArgs /
 * exportReturns instead: shared validators, aliases and re-exports are evaluated
 * by Convex, not guessed from TypeScript syntax. Handlers are never invoked.
 */
import { readdir } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { createServer } from "vite-plus";

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  const result = Object.fromEntries(
    Object.keys(value)
      .toSorted()
      .map((key) => [key, canonical(value[key])]),
  );
  // Union order has no meaning. Keep other arrays (including literal data) intact.
  if (result.type === "union") {
    result.value = result.value.toSorted((a, b) => {
      const left = JSON.stringify(a),
        right = JSON.stringify(b);
      return left < right ? -1 : left > right ? 1 : 0;
    });
  }
  return result;
}

export const serialize = (snapshot) => `${JSON.stringify(canonical(snapshot), null, 2)}\n`;

async function modules(directory) {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith("_") || entry.name === "node_modules") continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) paths.push(...(await modules(path)));
    else if (/\.(ts|js|mjs)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) paths.push(path);
  }
  return paths.toSorted();
}

export async function generateSnapshot(root) {
  const directory = resolve(root, "convex/functions");
  const server = await createServer({
    root,
    configFile: false,
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, watch: null },
    appType: "custom",
  });
  try {
    const functions = {};
    for (const path of await modules(directory)) {
      const exports = await server.ssrLoadModule(`/${relative(root, path).split(sep).join("/")}`);
      for (const [name, fn] of Object.entries(exports)) {
        if (!fn?.isPublic) continue;
        const kind = fn.isQuery
          ? "query"
          : fn.isMutation
            ? "mutation"
            : fn.isAction
              ? "action"
              : null;
        if (!kind) continue; // HTTP actions are routes, not the generated public API.
        const identifier = `${relative(directory, path)
          .split(sep)
          .join("/")
          .replace(/\.(ts|js|mjs)$/, "")}:${name}`;
        functions[identifier] = {
          kind,
          args: JSON.parse(fn.exportArgs()),
          returns: JSON.parse(fn.exportReturns()),
        };
      }
    }
    if (Object.keys(functions).length === 0) throw new Error("No public Convex functions found");
    return canonical({ format: 1, functions });
  } finally {
    await server.close();
  }
}
