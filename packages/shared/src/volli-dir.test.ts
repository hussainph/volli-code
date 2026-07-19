import { describe, it, expect } from "vite-plus/test";
import {
  VOLLI_ARTIFACTS_DIR_ENV,
  VOLLI_DIR_NAME,
  VOLLI_GITIGNORE_CONTENT,
  VOLLI_TICKET_ENV,
  agentSessionEnv,
  projectArtifactsDir,
  projectSessionEnv,
  ticketSessionEnv,
  volliDir,
} from "./volli-dir";

describe("VOLLI_DIR_NAME", () => {
  it("is '.volli'", () => {
    expect(VOLLI_DIR_NAME).toBe(".volli");
  });
});

describe("volliDir", () => {
  it("appends .volli to the project path", () => {
    expect(volliDir("/Users/dev/project")).toBe("/Users/dev/project/.volli");
  });

  it("strips a trailing slash on the project path first", () => {
    expect(volliDir("/Users/dev/project/")).toBe("/Users/dev/project/.volli");
  });
});

describe("projectArtifactsDir", () => {
  it("nests artifacts under the project's .volli dir", () => {
    expect(projectArtifactsDir("/Users/dev/project")).toBe("/Users/dev/project/.volli/artifacts");
  });
});

describe("VOLLI_GITIGNORE_CONTENT", () => {
  it("ignores everything under .volli", () => {
    expect(VOLLI_GITIGNORE_CONTENT).toBe("*\n");
  });
});

describe("env var names", () => {
  it("names VOLLI_TICKET_ENV and VOLLI_ARTIFACTS_DIR_ENV", () => {
    expect(VOLLI_TICKET_ENV).toBe("VOLLI_TICKET");
    expect(VOLLI_ARTIFACTS_DIR_ENV).toBe("VOLLI_ARTIFACTS_DIR");
  });
});

describe("ticketSessionEnv", () => {
  it("builds the env map for a ticket-linked session (display id + main-repo artifacts dir + main-repo path)", () => {
    expect(ticketSessionEnv("/Users/dev/project", "VC-12")).toEqual({
      VOLLI_TICKET: "VC-12",
      VOLLI_ARTIFACTS_DIR: "/Users/dev/project/.volli/artifacts",
      VOLLI_PROJECT_DIR: "/Users/dev/project",
    });
  });

  it("always derives VOLLI_ARTIFACTS_DIR from the given projectPath, not a worktree cwd", () => {
    // The caller is responsible for always passing the main repo's path here
    // — this function has no way to distinguish a worktree path from the main
    // checkout, which is exactly why the main process must inject it rather
    // than deriving it from `cwd` at PTY-spawn time.
    const env = ticketSessionEnv("/Users/dev/project/.worktrees/VC-12", "VC-12");
    expect(env.VOLLI_ARTIFACTS_DIR).toBe("/Users/dev/project/.worktrees/VC-12/.volli/artifacts");
  });
});

describe("projectSessionEnv", () => {
  it("builds the env map for a project-scoped scratch session (just the artifacts dir)", () => {
    expect(projectSessionEnv("/Users/dev/project")).toEqual({
      VOLLI_ARTIFACTS_DIR: "/Users/dev/project/.volli/artifacts",
    });
  });
});

describe("agentSessionEnv", () => {
  it("adds the runtime socket/session contract and prepends the generated shim directory", () => {
    expect(
      agentSessionEnv(
        { VOLLI_TICKET: "VC-12", VOLLI_ARTIFACTS_DIR: "/repo/.volli/artifacts" },
        {
          sessionId: "session-full-id",
          socketPath: "/profile/volli.sock",
          binDir: "/profile/bin",
          inheritedPath: "/usr/bin:/bin",
        },
      ),
    ).toEqual({
      VOLLI_TICKET: "VC-12",
      VOLLI_ARTIFACTS_DIR: "/repo/.volli/artifacts",
      VOLLI_SESSION: "session-full-id",
      VOLLI_SOCKET: "/profile/volli.sock",
      PATH: "/profile/bin:/usr/bin:/bin",
    });
  });

  it("does not leave a trailing PATH separator when the inherited PATH is empty", () => {
    expect(
      agentSessionEnv(
        {},
        {
          sessionId: "session-full-id",
          socketPath: "/profile/volli.sock",
          binDir: "/profile/bin",
          inheritedPath: "",
        },
      ).PATH,
    ).toBe("/profile/bin");
  });
});
