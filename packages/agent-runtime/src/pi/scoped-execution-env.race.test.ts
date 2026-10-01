import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { ScopedExecutionEnv } from "./scoped-execution-env";

/**
 * A hook run just before the contained writer's next `mkdir` or `open`: the
 * shell's concurrent command, scheduled deterministically into the window
 * between two of the writer's syscalls (VC-45 review, B1 and S4).
 */
const hooks: { mkdir?: () => void; open?: () => void; lstat?: () => void } = {};

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const once = (name: keyof typeof hooks) => {
    const hook = hooks[name];
    delete hooks[name];
    hook?.();
  };
  return {
    ...actual,
    mkdir: async (...args: Parameters<typeof actual.mkdir>) => {
      const made = await actual.mkdir(...args);
      once("mkdir");
      return made;
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      once("open");
      return actual.open(...args);
    },
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      once("lstat");
      return actual.lstat(...args);
    },
  };
});

function tree(): { worktree: string; outside: string } {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "volli-scoped-race-")));
  const worktree = join(parent, "worktree");
  const outside = join(parent, "outside");
  mkdirSync(worktree);
  mkdirSync(outside);
  return { worktree, outside };
}

afterEach(() => {
  for (const name of Object.keys(hooks) as (keyof typeof hooks)[]) delete hooks[name];
});

describe("the contained writer under a concurrent swap (VC-45 review)", () => {
  it("refuses when a directory it just created is swapped for a link before the open", async () => {
    const { worktree, outside } = tree();
    const env = await ScopedExecutionEnv.create(worktree, { git: null });
    hooks.mkdir = () => {
      rmSync(join(worktree, "made"), { recursive: true });
      symlinkSync(outside, join(worktree, "made"));
    };
    expect(await env.writeFile("made/x.txt", "pwned")).toMatchObject({
      ok: false,
      error: { code: "permission_denied", message: expect.stringContaining("changed while") },
    });
    expect(() => readFileSync(join(outside, "x.txt"))).toThrow();
    await env.cleanup();
  });

  it("never opens through a file swapped for a link after it was judged", async () => {
    const { worktree, outside } = tree();
    writeFileSync(join(worktree, "victim.txt"), "inside");
    writeFileSync(join(outside, "target.txt"), "outside");
    const env = await ScopedExecutionEnv.create(worktree, { git: null });
    hooks.open = () => {
      rmSync(join(worktree, "victim.txt"));
      symlinkSync(join(outside, "target.txt"), join(worktree, "victim.txt"));
    };
    expect(await env.writeFile("victim.txt", "pwned")).toMatchObject({
      ok: false,
      error: { code: "permission_denied", message: expect.stringContaining("symbolic link") },
    });
    expect(readFileSync(join(outside, "target.txt"), "utf8")).toBe("outside");
    await env.cleanup();
  });

  it("writes nothing into a file that gained a second name after it was judged", async () => {
    const { worktree, outside } = tree();
    writeFileSync(join(worktree, "victim.txt"), "inside");
    const env = await ScopedExecutionEnv.create(worktree, { git: null });
    hooks.open = () => {
      // The swap a shell would make: the judged name now shares an inode with a file outside.
      writeFileSync(join(outside, "target.txt"), "outside");
      rmSync(join(worktree, "victim.txt"));
      linkSync(join(outside, "target.txt"), join(worktree, "victim.txt"));
    };
    expect(await env.appendFile("victim.txt", "pwned")).toMatchObject({
      ok: false,
      error: { code: "permission_denied", message: expect.stringContaining("single-named") },
    });
    expect(readFileSync(join(outside, "target.txt"), "utf8")).toBe("outside");
    await env.cleanup();
  });

  it("stops before the open once the write is cancelled", async () => {
    const { worktree } = tree();
    const env = await ScopedExecutionEnv.create(worktree, { git: null });
    const controller = new AbortController();
    hooks.lstat = () => controller.abort();
    expect(
      await env.writeFile("new.txt", "x", withAbortSignal(controller.signal, BACKGROUND_CONTEXT)),
    ).toMatchObject({ ok: false, error: { code: "aborted" } });
    expect(() => readFileSync(join(worktree, "new.txt"))).toThrow();
    await env.cleanup();
  });

  it("reports a parent that is a file rather than writing beside it", async () => {
    const { worktree } = tree();
    writeFileSync(join(worktree, "plain.txt"), "x");
    const env = await ScopedExecutionEnv.create(worktree, { git: null });
    // The parent exists and is not a directory; one deeper, its child cannot even be asked about.
    for (const path of ["plain.txt/x", "plain.txt/a/b.txt"]) {
      expect(await env.writeFile(path, "x"), path).toMatchObject({
        ok: false,
        error: { code: "unknown", message: expect.stringMatching(/not a directory|ENOTDIR/) },
      });
    }
    await env.cleanup();
  });
});
