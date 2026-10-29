import {
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test } from "vite-plus/test";
import {
  createMoveState,
  patchMoveState,
  readMoveState,
  type MoveRecoveryState,
} from "./move-state";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "move-state-"));
  roots.push(root);
  const file = join(root, "state.json");
  const state: MoveRecoveryState = {
    source: "/source",
    profile: "/scratch",
    target: "http://127.0.0.1",
    allowProduction: false,
    userId: "person",
    runnerId: "runner",
    workspaceId: "workspace",
    includeRemoved: false,
    operation: "run",
  };
  createMoveState(file, state);
  return { root, file, state };
}

test("state creation is exclusive and patches preserve the private inode and unrelated fields", () => {
  const { file, state } = fixture();
  const before = statSync(file);
  expect(before.mode & 0o777).toBe(0o600);
  expect(() => createMoveState(file, state)).toThrow();
  patchMoveState(file, { uiReady: true, queueId: "queue" });
  expect(readMoveState(file)).toEqual({ ...state, uiReady: true, queueId: "queue" });
  expect(statSync(file).ino).toBe(before.ino);
  patchMoveState(file, { uiReady: false, queueId: undefined });
  expect(readMoveState(file).queueId).toBeUndefined();
});

test("replacing the state path with a symlink cannot overwrite its target", () => {
  const { root, file, state } = fixture();
  const original = join(root, "original.json");
  createMoveState(original, state);
  const before = readFileSync(original);
  unlinkSync(file);
  symlinkSync(original, file);
  expect(() => patchMoveState(file, { uiReady: true })).toThrow();
  expect(() => readMoveState(file)).toThrow();
  expect(readFileSync(original)).toEqual(before);
});

test("a hard-linked state is refused before truncation", () => {
  const { root, file } = fixture();
  const before = readFileSync(file);
  linkSync(file, join(root, "alias"));
  expect(() => patchMoveState(file, { uiReady: true })).toThrow("invalid_rehearsal_state_file");
  expect(readFileSync(file)).toEqual(before);
});
