import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { generateSnapshot, serialize } from "./snapshot.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
test("snapshot uses evaluated Convex registrations: aliases, re-exports, nested modules, all kinds, declared returns only", async () => {
  const scratch = resolve(root, ".scratch");
  await mkdir(scratch, { recursive: true });
  const tree = await mkdtemp(resolve(scratch, "api-test-"));
  const directory = resolve(tree, "convex/functions");
  await mkdir(resolve(directory, "nested"), { recursive: true });
  try {
    const registration = pathToFileURL(resolve(root, "convex/functions/_generated/server.js")).href;
    // Load the validator from the installed Convex package, just like backend sources.
    const values = pathToFileURL(
      resolve(root, "convex/node_modules/convex/dist/esm/values/index.js"),
    ).href;
    await writeFile(
      resolve(directory, "nested/one.ts"),
      `
      import { query as q, mutation, action, internalQuery, httpAction } from ${JSON.stringify(registration)};
      import { v } from ${JSON.stringify(values)};
      const shared = v.union(v.string(), v.number());
      export const read = q({ args: { id: shared }, returns: v.object({ id: v.string() }), handler() { throw new Error("never invoke handlers"); } });
      export const write = mutation({ args: {}, handler() {} });
      export const act = action({ args: {}, handler() {} });
      export const hidden = internalQuery({ args: {}, handler() {} });
      export const route = httpAction(() => new Response());
    `,
    );
    await writeFile(
      resolve(directory, "alias.ts"),
      'export { read as renamed } from "./nested/one";',
    );
    const first = await generateSnapshot(tree);
    assert.deepEqual(Object.keys(first.functions), [
      "alias:renamed",
      "nested/one:act",
      "nested/one:read",
      "nested/one:write",
    ]);
    assert.equal(first.functions["nested/one:write"].kind, "mutation");
    assert.equal(first.functions["nested/one:act"].kind, "action");
    assert.equal(first.functions["nested/one:read"].returns.type, "object");
    assert.equal(first.functions["nested/one:act"].returns, null);
    assert.equal(serialize(first), serialize(await generateSnapshot(tree)));
  } finally {
    await rm(tree, { recursive: true, force: true });
  }
});
test("canonical union and object ordering is deterministic", () => {
  assert.deepEqual(
    serialize({ z: 1, a: { type: "union", value: [{ type: "string" }, { type: "null" }] } }),
    serialize({ a: { value: [{ type: "null" }, { type: "string" }], type: "union" }, z: 1 }),
  );
});
