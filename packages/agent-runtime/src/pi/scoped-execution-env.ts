import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  err,
  ExecutionError,
  FileError,
  NodeExecutionEnv,
  type ExecutionEnv,
  type Result,
  type ShellExecOptions,
} from "@earendil-works/pi-agent-core/node";

/**
 * The filesystem capability supplied to Pi's Session 1 read/edit/write tools.
 * Paths cannot leave the Ticket worktree, and symlinks are not followed.
 */
export class ScopedExecutionEnv implements ExecutionEnv {
  readonly cwd: string;
  readonly #delegate: NodeExecutionEnv;

  private constructor(root: string) {
    this.cwd = root;
    this.#delegate = new NodeExecutionEnv({ cwd: root });
  }

  static async create(root: string): Promise<ScopedExecutionEnv> {
    return new ScopedExecutionEnv(await realpath(root));
  }

  async #guard(path: string, signal?: AbortSignal): Promise<Result<string, FileError>> {
    if (signal?.aborted) {
      return err(new FileError("aborted", "Operation aborted.", path));
    }
    const target = resolve(this.cwd, path);
    const rel = relative(this.cwd, target);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      return err(
        new FileError("permission_denied", "Path is outside the Ticket worktree.", target),
      );
    }

    let current = this.cwd;
    for (const part of rel.split(sep).filter(Boolean)) {
      current = join(current, part);
      try {
        if ((await lstat(current)).isSymbolicLink()) {
          return err(
            new FileError(
              "permission_denied",
              "Symlinks are not available inside the contained Ticket tool boundary.",
              current,
            ),
          );
        }
      } catch (error) {
        /* v8 ignore next 3 -- Node filesystem promises reject with Error instances */
        if (!(error instanceof Error)) {
          return err(new FileError("unknown", String(error), current));
        }
        if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
        const cause = error;
        return err(new FileError("unknown", cause.message, current, cause));
      }
    }
    return { ok: true, value: target };
  }

  async absolutePath(path: string, abortSignal?: AbortSignal) {
    return this.#guard(path, abortSignal);
  }

  async exists(path: string, abortSignal?: AbortSignal) {
    const guarded = await this.#guard(path, abortSignal);
    return guarded.ok ? this.#delegate.exists(guarded.value) : guarded;
  }

  async readBinaryFile(path: string, abortSignal?: AbortSignal) {
    const guarded = await this.#guard(path, abortSignal);
    return guarded.ok ? this.#delegate.readBinaryFile(guarded.value, abortSignal) : guarded;
  }

  async fileInfo(path: string, abortSignal?: AbortSignal) {
    const guarded = await this.#guard(path, abortSignal);
    return guarded.ok ? this.#delegate.fileInfo(guarded.value) : guarded;
  }

  async readTextFile(path: string, abortSignal?: AbortSignal) {
    const guarded = await this.#guard(path, abortSignal);
    return guarded.ok ? this.#delegate.readTextFile(guarded.value, abortSignal) : guarded;
  }

  async writeFile(path: string, content: string | Uint8Array, abortSignal?: AbortSignal) {
    const guarded = await this.#guard(path, abortSignal);
    return guarded.ok ? this.#delegate.writeFile(guarded.value, content, abortSignal) : guarded;
  }

  #unsupported(path = this.cwd): Result<never, FileError> {
    return err(new FileError("not_supported", "This filesystem operation is not available.", path));
  }

  async joinPath(_parts: string[], _abortSignal?: AbortSignal) {
    return this.#unsupported();
  }

  async readTextLines(_path: string, _options?: { maxLines?: number; abortSignal?: AbortSignal }) {
    return this.#unsupported();
  }

  async appendFile(_path: string, _content: string | Uint8Array, _abortSignal?: AbortSignal) {
    return this.#unsupported();
  }

  async renameFile(_sourcePath: string, _destinationPath: string, _abortSignal?: AbortSignal) {
    return this.#unsupported();
  }

  async listDir(_path: string, _abortSignal?: AbortSignal) {
    return this.#unsupported();
  }

  async canonicalPath(_path: string, _abortSignal?: AbortSignal) {
    return this.#unsupported();
  }

  async createDir(_path: string, _options?: { recursive?: boolean; abortSignal?: AbortSignal }) {
    return this.#unsupported();
  }

  async remove(
    _path: string,
    _options?: { recursive?: boolean; force?: boolean; abortSignal?: AbortSignal },
  ) {
    return this.#unsupported();
  }

  async createTempDir(_prefix?: string, _abortSignal?: AbortSignal) {
    return this.#unsupported();
  }

  async createTempFile(_options?: { prefix?: string; suffix?: string; abortSignal?: AbortSignal }) {
    return this.#unsupported();
  }

  async exec(
    _command: string,
    _options?: ShellExecOptions,
  ): Promise<Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>> {
    return err(
      new ExecutionError(
        "shell_unavailable",
        "Process execution is not available in migration Session 1.",
      ),
    );
  }

  async cleanup(): Promise<void> {
    await this.#delegate.cleanup();
  }
}
