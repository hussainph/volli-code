/**
 * Where Code Mode's sandbox is found (VC-471), against real directories laid
 * out the way each build lays them out: pnpm's symlinked store for an
 * unpackaged build, electron-builder's flat `app.asar.unpacked/node_modules`
 * for the packaged app. The last suite copies the real sandbox into that flat
 * layout and runs a program from it.
 */
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { CodemodeSandbox, loadQuickJSWasm } from "@earendil-works/pi-codemode";
import { afterAll, describe, expect, it } from "vite-plus/test";

import { codeModeSandboxAssets, type CodeModeSandboxLocation } from "./sandbox-assets";

const DESKTOP_DIRECTORY = join(import.meta.dirname, "..", "..", "..", "..", "apps", "desktop");

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** A temp directory by its real path: macOS's tmpdir sits behind a symlink. */
function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "volli-codemode-assets-")));
  tempDirs.push(dir);
  return dir;
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** A stand-in pi-codemode at `<nodeModules>/@earendil-works/pi-codemode`. */
function fakeSandboxPackage(nodeModules: string, options: { worker?: boolean } = {}): string {
  const dir = join(nodeModules, "@earendil-works", "pi-codemode");
  write(join(dir, "package.json"), JSON.stringify({ name: "@earendil-works/pi-codemode" }));
  if (options.worker !== false) write(join(dir, "dist", "runtime", "worker.js"), "");
  return dir;
}

/** A stand-in quickjs-wasi at `<nodeModules>/quickjs-wasi`, exporting its wasm as the real one does. */
function fakeQuickJs(nodeModules: string, options: { wasm?: boolean } = {}): string {
  const dir = join(nodeModules, "quickjs-wasi");
  write(
    join(dir, "package.json"),
    JSON.stringify({ name: "quickjs-wasi", exports: { "./quickjs.wasm": "./quickjs.wasm" } }),
  );
  if (options.wasm !== false) write(join(dir, "quickjs.wasm"), "\0asm");
  return dir;
}

function location(
  overrides: Partial<CodeModeSandboxLocation>,
  logged: string[] = [],
): CodeModeSandboxLocation {
  return {
    packaged: false,
    appPath: () => {
      throw new Error("appPath was read");
    },
    resourcesPath: () => {
      throw new Error("resourcesPath was read");
    },
    log: (message) => logged.push(message),
    ...overrides,
  };
}

describe("codeModeSandboxAssets, unpackaged", () => {
  it("finds the workspace's sandbox through agent-runtime, across pnpm's links", () => {
    // pnpm's layout: the app links agent-runtime, agent-runtime links the
    // sandbox into the store, and quickjs-wasi is reachable only as the
    // sandbox's sibling INSIDE the store — so the lookup has to follow the
    // links to the real directory before it walks up.
    const root = tempDir();
    const store = join(root, "store", "node_modules");
    const sandbox = fakeSandboxPackage(store);
    const quickjs = fakeQuickJs(store);
    const agentRuntime = join(root, "workspace", "agent-runtime");
    mkdirSync(join(agentRuntime, "node_modules", "@earendil-works"), { recursive: true });
    symlinkSync(sandbox, join(agentRuntime, "node_modules", "@earendil-works", "pi-codemode"));
    const app = join(root, "app");
    mkdirSync(join(app, "node_modules", "@volli"), { recursive: true });
    symlinkSync(agentRuntime, join(app, "node_modules", "@volli", "agent-runtime"));

    const logged: string[] = [];
    expect(codeModeSandboxAssets(location({ appPath: () => app }, logged))).toEqual({
      codeModeSandbox: {
        workerUrl: pathToFileURL(join(sandbox, "dist", "runtime", "worker.js")),
        wasmPath: join(quickjs, "quickjs.wasm"),
      },
    });
    expect(logged).toEqual([]);
  });

  it("finds this workspace's own sandbox from the app directory", () => {
    const found = codeModeSandboxAssets(location({ appPath: () => DESKTOP_DIRECTORY }));
    expect(found.codeModeSandbox?.wasmPath).toMatch(/quickjs\.wasm$/u);
    expect(String(found.codeModeSandbox?.workerUrl)).toMatch(/dist\/runtime\/worker\.js$/u);
  });
});

describe("codeModeSandboxAssets, packaged", () => {
  it("finds the sandbox unpacked beside the archive, in electron-builder's flat layout", () => {
    const resources = tempDir();
    const nodeModules = join(resources, "app.asar.unpacked", "node_modules");
    const sandbox = fakeSandboxPackage(nodeModules);
    const quickjs = fakeQuickJs(nodeModules);

    const logged: string[] = [];
    expect(
      codeModeSandboxAssets(location({ packaged: true, resourcesPath: () => resources }, logged)),
    ).toEqual({
      codeModeSandbox: {
        workerUrl: pathToFileURL(join(sandbox, "dist", "runtime", "worker.js")),
        wasmPath: join(quickjs, "quickjs.wasm"),
      },
    });
    expect(logged).toEqual([]);
  });

  it("never looks inside the archive itself", () => {
    // A complete copy inside `app.asar` (as a directory, which is what
    // Electron's fs makes an archive look like) and none beside it: the
    // packaged app must answer nothing rather than a path a worker thread
    // cannot load from.
    const resources = tempDir();
    const archived = join(resources, "app.asar", "node_modules");
    fakeSandboxPackage(archived);
    fakeQuickJs(archived);

    const logged: string[] = [];
    expect(
      codeModeSandboxAssets(location({ packaged: true, resourcesPath: () => resources }, logged)),
    ).toEqual({});
    expect(logged).toEqual([
      expect.stringContaining("Code Mode's sandbox could not be located in this packaged build"),
    ]);
    expect(logged[0]).toContain("app.asar.unpacked");
  });
});

describe("codeModeSandboxAssets, files missing", () => {
  const cases: Array<{
    name: string;
    lay: (nodeModules: string) => void;
    says: RegExp;
  }> = [
    {
      name: "no sandbox package",
      lay: (nodeModules) => fakeQuickJs(nodeModules),
      says: /ENOENT/u,
    },
    {
      name: "no worker file",
      lay: (nodeModules) => {
        fakeSandboxPackage(nodeModules, { worker: false });
        fakeQuickJs(nodeModules);
      },
      says: /worker\.js does not exist/u,
    },
    {
      // Refused one of two ways, depending on the environment the test runs
      // in: not found at all, or — where NODE_PATH reaches some other copy,
      // as pnpm's bin shims arrange — found OUTSIDE the unpacked app, which
      // the worker's own ES module import would never reach.
      name: "no quickjs-wasi package",
      lay: (nodeModules) => fakeSandboxPackage(nodeModules),
      says: /quickjs-wasi/u,
    },
    {
      name: "no WebAssembly file",
      lay: (nodeModules) => {
        fakeSandboxPackage(nodeModules);
        fakeQuickJs(nodeModules, { wasm: false });
      },
      says: /quickjs\.wasm/u,
    },
  ];

  for (const { name, lay, says } of cases) {
    it(`answers nothing and says why: ${name}`, () => {
      const resources = tempDir();
      lay(join(resources, "app.asar.unpacked", "node_modules"));
      const logged: string[] = [];
      expect(
        codeModeSandboxAssets(location({ packaged: true, resourcesPath: () => resources }, logged)),
      ).toEqual({});
      expect(logged).toHaveLength(1);
      expect(logged[0]).toMatch(
        /^Code Mode's sandbox could not be located in this packaged build \(looked under \S+app\.asar\.unpacked\): /u,
      );
      expect(logged[0]).toMatch(says);
    });
  }

  it("names the unpackaged build when that is the one that cannot find it", () => {
    const logged: string[] = [];
    expect(codeModeSandboxAssets(location({ appPath: () => tempDir() }, logged))).toEqual({});
    expect(logged[0]).toMatch(
      /^Code Mode's sandbox could not be located in this unpackaged build \(looked under \S+agent-runtime\): /u,
    );
  });
});

describe("the sandbox the packaged app ships", () => {
  const shipped = realpathSync(
    join(DESKTOP_DIRECTORY, "node_modules", "@earendil-works", "pi-codemode"),
  );

  it("is the same patched copy agent-runtime's bundled host was built against", () => {
    // apps/desktop declares the package only so electron-builder ships its
    // files; the host half main runs is inlined from agent-runtime's copy. One
    // store directory — same version, same patch hash — means the worker the
    // packaged app starts is the one that host speaks to.
    const bundled = realpathSync(
      join(
        DESKTOP_DIRECTORY,
        "node_modules",
        "@volli",
        "agent-runtime",
        "node_modules",
        "@earendil-works",
        "pi-codemode",
      ),
    );
    expect(shipped).toBe(bundled);
    // The `maxOutputChars` / `maxCallChars` patch (patches/), on both sides of
    // the worker boundary.
    expect(readFileSync(join(shipped, "dist", "runtime", "host.js"), "utf8")).toContain(
      "maxOutputChars",
    );
    expect(readFileSync(join(shipped, "dist", "runtime", "worker.js"), "utf8")).toContain(
      "maxCallChars",
    );
  });

  it("runs a program from electron-builder's flat unpacked layout", async () => {
    // The real packages, copied the way electron-builder lays them out: flat,
    // with no pnpm store around them. The worker's bare `import "quickjs-wasi"`
    // can only resolve to the copy beside it.
    const resources = tempDir();
    const nodeModules = join(resources, "app.asar.unpacked", "node_modules");
    const quickjs = dirname(
      createRequire(join(shipped, "dist", "runtime", "worker.js")).resolve(
        "quickjs-wasi/package.json",
      ),
    );
    cpSync(shipped, join(nodeModules, "@earendil-works", "pi-codemode"), { recursive: true });
    cpSync(quickjs, join(nodeModules, "quickjs-wasi"), { recursive: true });

    const { codeModeSandbox } = codeModeSandboxAssets(
      location({ packaged: true, resourcesPath: () => resources }),
    );
    expect(codeModeSandbox?.wasmPath).toBe(join(nodeModules, "quickjs-wasi", "quickjs.wasm"));
    const sandbox = new CodemodeSandbox({
      timeoutMs: 10_000,
      maxOutputChars: 1_000,
      wasm: loadQuickJSWasm(codeModeSandbox?.wasmPath),
      ...(codeModeSandbox?.workerUrl === undefined ? {} : { workerUrl: codeModeSandbox.workerUrl }),
    });
    try {
      expect(await sandbox.execute("console.log('from the copy'); return 1 + 1;")).toMatchObject({
        ok: true,
        value: 2,
        output: [expect.objectContaining({ text: expect.stringContaining("from the copy") })],
      });
    } finally {
      await sandbox.close();
    }
  });
});
