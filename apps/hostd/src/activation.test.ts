import { describe, expect, it } from "vite-plus/test";

import { HostdBootError } from "./boot-error";
import { socketActivationFd } from "./activation";

describe("socketActivationFd", () => {
  it("serves fd 3 when systemd passed one socket to this process", () => {
    expect(socketActivationFd({ LISTEN_FDS: "1", LISTEN_PID: "42" }, 42)).toBe(3);
  });

  it("binds its own when nothing was passed, or it was passed to someone else", () => {
    expect(socketActivationFd({}, 42)).toBeUndefined();
    expect(socketActivationFd({ LISTEN_FDS: "1", LISTEN_PID: "41" }, 42)).toBeUndefined();
  });

  it("refuses more than one", () => {
    expect(() => socketActivationFd({ LISTEN_FDS: "2", LISTEN_PID: "42" }, 42)).toThrow(
      HostdBootError,
    );
  });
});
