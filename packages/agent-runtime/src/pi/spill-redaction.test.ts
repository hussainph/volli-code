import { closeSync, openSync, readSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExactValueByteRedactor } from "@volli/shared";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { piExecutionEnv } from "./execution-env";
import { BACKGROUND_CONTEXT, type ExecutionEnv } from "./harness-env";
import { privateSecretExecution, type SecretPort } from "./secrets";
import { ShellSpillBudget, ShellSpillRedactor } from "./shell-spill";
import { createSessionTools } from "./tools";
import { applyShellOutputUpdate } from "./vendor/pi-harness/execution/output-capture";
import type {
  ForegroundShellExecutor,
  ShellExecOptions,
  ShellOutputView,
} from "./vendor/pi-harness/types";

/**
 * VC-865: a shell spill is written through the same exact-value redaction as
 * tool results, on both of `NodeExecutionEnv`'s paths: the host's foreground
 * executor (`onOutput` chunks) and its own spawned child (pipe chunks).
 */

const SECRET = "secret-example-value-123";
const MARKER = "‹secret:API_TOKEN›";
const INLINE = { maxBytes: 50 * 1024, maxLines: 2_000, retain: "tail" as const };
const FILLER = "x".repeat(60_000);

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "volli-spill-redaction-"));
  roots.push(root);
  return root;
}

/** A port answering with the shared byte redactor over a value set tests can grow. */
function livePort(initial: Record<string, string> = { [SECRET]: "API_TOKEN" }) {
  const values = new Map(Object.entries(initial));
  let redactor = build();
  function build() {
    return new ExactValueByteRedactor(
      [...values].map(([value, name]) => [value, `‹secret:${name}›`] as const),
    );
  }
  let failing: "never" | "always" | "final" = "never";
  const port: SecretPort = {
    request: async () => "signed in",
    hasValues: () => values.size > 0,
    redact: (text) =>
      [...values].reduce((out, [value, name]) => out.replaceAll(value, `‹secret:${name}›`), text),
    redactStreamStep: (window, from, final) => {
      if (failing === "always" || (failing === "final" && final)) {
        throw new Error(`redactor broke near ${SECRET}`);
      }
      return redactor.step(window, from, final);
    },
  };
  return {
    port,
    add(value: string, name: string) {
      values.set(value, name);
      redactor = build();
    },
    fail(when: "always" | "final") {
      failing = when;
    },
  };
}

type Script = ReadonlyArray<string | Uint8Array | (() => void)>;

/** The host boundary with exact chunks; it honours pause like the real host. */
function scripted(script: Script): ForegroundShellExecutor {
  return async (input) => {
    let resumed: PromiseWithResolvers<void> | undefined;
    input.onReady({
      pauseOutput: () => {
        resumed ??= Promise.withResolvers<void>();
      },
      resumeOutput: () => {
        resumed?.resolve();
        resumed = undefined;
      },
    });
    for (const step of script) {
      for (let wait = resumed; wait !== undefined; wait = resumed) await wait.promise;
      if (input.signal.aborted)
        throw Object.assign(new Error("Command aborted"), { code: "aborted" });
      if (typeof step === "function") step();
      else input.onOutput(Buffer.from(step));
      await new Promise((resolve) => setImmediate(resolve));
    }
    if (input.signal.aborted)
      throw Object.assign(new Error("Command aborted"), { code: "aborted" });
    return { code: 0, signal: null };
  };
}

async function run(
  env: ExecutionEnv,
  command: string,
  foreground: boolean,
): Promise<{
  result: Awaited<ReturnType<ExecutionEnv["exec"]>>;
  view: ShellOutputView | undefined;
}> {
  let view: ShellOutputView | undefined;
  const options: ShellExecOptions = {
    capture: { limits: INLINE, spill: true },
    onUpdate: (update) => {
      view = applyShellOutputUpdate(view, update);
    },
    ...(foreground ? { foregroundCallId: "call" } : {}),
  };
  const result = await env.exec(command, options, BACKGROUND_CONTEXT);
  return { result, view };
}

function spillOf(result: Awaited<ReturnType<ExecutionEnv["exec"]>>): string {
  if (!result.ok || result.value.spillPath === undefined) throw new Error("expected a spill");
  return result.value.spillPath;
}

function tail(path: string, length: number, size: number): Buffer {
  const descriptor = openSync(path, "r");
  try {
    const bytes = Buffer.alloc(length);
    readSync(descriptor, bytes, 0, length, size - length);
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

const half = SECRET.length / 2;
const SPLIT_COMMAND = `printf '%s\\n' '${FILLER}'; printf 'token: ${SECRET.slice(0, half)}'; sleep 0.05; printf '${SECRET.slice(half)}\\nafter ${SECRET}\\n'`;
const SPLIT_SCRIPT: Script = [
  `${FILLER}\n`,
  `token: ${SECRET.slice(0, half)}`,
  // Through the middle of a UTF-8 character, and through the value again.
  Buffer.from(`${SECRET.slice(half)}\nwide é`).subarray(0, -1),
  Buffer.from("é").subarray(1),
  `\nafter ${SECRET.slice(0, 3)}`,
  `${SECRET.slice(3)}\n`,
];

describe("shell spill redaction", () => {
  it.each(["foreground", "standalone"] as const)(
    "writes a value split across chunks as one marker and leaves the inline tail unchanged (%s)",
    async (path) => {
      const cwd = await workspace();
      const foreground = path === "foreground";
      const executor = foreground ? scripted(SPLIT_SCRIPT) : undefined;
      const plain = await piExecutionEnv(cwd, { foregroundExecutor: executor });
      const redacting = privateSecretExecution(
        await piExecutionEnv(cwd, {
          foregroundExecutor: foreground ? scripted(SPLIT_SCRIPT) : undefined,
        }),
        livePort().port,
      );
      try {
        const before = await run(plain, SPLIT_COMMAND, foreground);
        const after = await run(redacting, SPLIT_COMMAND, foreground);
        const raw = await readFile(spillOf(before.result), "utf8");
        const saved = await readFile(spillOf(after.result), "utf8");
        expect(raw).toContain(SECRET);
        expect(saved).toBe(raw.replaceAll(SECRET, MARKER));
        expect(saved).not.toContain(SECRET.slice(0, half));
        expect(saved).not.toContain(SECRET.slice(half));
        // The model-visible tail is the capture's, untouched by the spill.
        expect({ ...after.view, spillPath: undefined }).toEqual({
          ...before.view,
          spillPath: undefined,
        });
        expect(after.view?.text).toContain(SECRET);
      } finally {
        await plain.cleanup(BACKGROUND_CONTEXT);
        await redacting.cleanup(BACKGROUND_CONTEXT);
      }
    },
  );

  it.each(["foreground", "standalone"] as const)(
    "redacts before the spill cap, so a value straddling it leaves only a cut marker (%s)",
    async (path) => {
      const cwd = await workspace();
      const lead = ShellSpillBudget.maxBytes - 7;
      const block = "x".repeat(1024 * 1024);
      const script: Script = [
        ...Array.from({ length: Math.floor(lead / block.length) }, () => block),
        "x".repeat(lead % block.length),
        SECRET.slice(0, 4),
        `${SECRET.slice(4)}\nend\n`,
      ];
      const env = privateSecretExecution(
        await piExecutionEnv(cwd, {
          foregroundExecutor: path === "foreground" ? scripted(script) : undefined,
        }),
        livePort().port,
      );
      try {
        const { result, view } = await run(
          env,
          `head -c ${lead} /dev/zero | tr '\\0' x; printf '${SECRET.slice(0, 4)}'; printf '${SECRET.slice(4)}\\nend\\n'`,
          path === "foreground",
        );
        expect(result).toMatchObject({
          ok: true,
          value: { spillTruncatedAt: ShellSpillBudget.maxBytes },
        });
        const spill = spillOf(result);
        const { size } = await stat(spill);
        expect(size).toBe(ShellSpillBudget.maxBytes);
        expect(tail(spill, 16, size)).toEqual(
          Buffer.concat([Buffer.from("x".repeat(9)), Buffer.from(MARKER).subarray(0, 7)]),
        );
        // The inline tail still ends with the command's own last line.
        expect(view?.text).toMatch(/end\n?$/);
      } finally {
        await env.cleanup(BACKGROUND_CONTEXT);
      }
    },
    120_000,
  );

  it("redacts a credential saved while the command runs, even with none held at its start", async () => {
    const cwd = await workspace();
    const live = livePort({});
    const late = "late-credential-456";
    const env = privateSecretExecution(
      await piExecutionEnv(cwd, {
        foregroundExecutor: scripted([
          `${FILLER}\n`,
          // Undecided only once the value exists; before it, nothing is held.
          `before ${late.slice(0, 5)}`,
          () => live.add(late, "LATE"),
          `${late.slice(5)} and ${late.slice(0, 5)}`,
          `${late.slice(5)}\n`,
        ]),
      }),
      live.port,
    );
    try {
      const { result } = await run(env, "unused", true);
      const saved = await readFile(spillOf(result), "utf8");
      // The first occurrence was written before the value was known: its
      // prefix had already been decided; the rest, and every later byte, use it.
      expect(saved).toBe(
        `${FILLER}\nbefore ${late.slice(0, 5)}${late.slice(5)} and ‹secret:LATE›\n`,
      );
    } finally {
      await env.cleanup(BACKGROUND_CONTEXT);
    }
  });

  it.each(["foreground", "standalone"] as const)(
    "fails the command closed, writing no undecided byte, when redaction fails (%s)",
    async (path) => {
      for (const when of ["always", "final"] as const) {
        const cwd = await workspace();
        const live = livePort();
        live.fail(when);
        const env = privateSecretExecution(
          await piExecutionEnv(cwd, {
            foregroundExecutor:
              path === "foreground"
                ? scripted([`${FILLER}\n`, `tail ${SECRET.slice(0, 6)}`])
                : undefined,
          }),
          live.port,
        );
        let spill: string | undefined;
        env.createTempFile = new Proxy(env.createTempFile, {
          apply: async (target, self, args) => {
            const created = await Reflect.apply(target, self, args);
            if (created.ok) spill = created.value;
            return created;
          },
        });
        try {
          const { result } = await run(
            env,
            `printf '%s\\n' '${FILLER}'; printf 'tail ${SECRET.slice(0, 6)}'`,
            path === "foreground",
          );
          expect(result).toMatchObject({
            ok: false,
            error: {
              code: "unknown",
              message: `Failed to preserve complete shell output: ${ShellSpillRedactor.failure}`,
            },
          });
          expect(JSON.stringify(result)).not.toContain("redactor broke");
          if (when === "always") expect(spill).toBeUndefined();
          else {
            // Everything decided before the failure was redacted; the held
            // prefix never reached the file.
            expect(await readFile(spill!, "utf8")).toBe(`${FILLER}\ntail `);
          }
        } finally {
          await env.cleanup(BACKGROUND_CONTEXT);
        }
      }
    },
  );

  it("saves the bash tool's full output redacted through the production chain", async () => {
    const env = privateSecretExecution(await piExecutionEnv(await workspace()), livePort().port);
    const [bash] = createSessionTools({ tools: { tools: ["execute"] } }, env);
    try {
      const result = await bash!.execute("full", {
        command: `for i in $(seq 1 2100); do printf '%s\\n' '${SECRET}'; done`,
      });
      const fullOutputPath = (result.details as { fullOutputPath: string }).fullOutputPath;
      const text = result.content.map((part) => ("text" in part ? part.text : "")).join("");
      expect(text).toContain(`Full output: ${fullOutputPath}`);
      expect(await readFile(fullOutputPath, "utf8")).toBe(`${MARKER}\n`.repeat(2100));
    } finally {
      await env.cleanup(BACKGROUND_CONTEXT);
    }
  });
});
