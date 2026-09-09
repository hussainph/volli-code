import { describe, expect, it } from "vite-plus/test";
import { refuseDaemonizingExecute } from "./refusal";

describe("refuseDaemonizingExecute", () => {
  it.each([
    ["nohup", "nohup sleep 300"],
    ["trailing background operator", "printf ready | sleep 300 &"],
    ["setsid", "/usr/bin/setsid sleep 300"],
    ["disown", "sleep 300 & disown %1"],
    ["screen -d", "screen -d -m sleep 300"],
    ["screen -dm", "screen -dm sleep 300"],
    ["screen detached option cluster", "screen -dmS worker sleep 300"],
    ["tmux new -d", "tmux new -d sleep 300"],
    ["tmux new-session detached option cluster", "tmux new-session -ds worker sleep 300"],
    ["start-stop-daemon", "start-stop-daemon --start --background --exec /usr/bin/sleep"],
    ["launchctl submit", "launchctl submit -l worker -- /usr/bin/sleep 300"],
    ["a nested observed form", 'bash -c "nohup vp dev > /tmp/worker.log &"'],
    ["combined shell options", "bash -lc -- 'setsid sleep 300'"],
  ])("refuses %s and points long-running work to shell_start", (_form, command) => {
    const refusal = refuseDaemonizingExecute(command);

    expect(refusal).toMatchObject({ rule: "shell.execute-background" });
    expect(refusal?.message).toContain("shell_start");
  });

  it.each([
    "echo nohup setsid disown start-stop-daemon",
    "printf '&'",
    "printf \\&",
    "printf ready &>/dev/null",
    "printf ready 2>&1",
    "first & second",
    "screen -ls",
    "screen -dr worker",
    "tmux new worker",
    "tmux attach -d",
    "launchctl list",
    "bash script.sh",
    "bash -c",
    "bash -c 'echo ready'",
    "DAEMON=setsid",
    "echo ready &&",
    "&",
    "",
  ])("allows a command that does not request background lifetime: %j", (command) => {
    expect(refuseDaemonizingExecute(command)).toBeUndefined();
  });

  it("bounds how deeply it follows nested shell scripts", () => {
    let command = "nohup sleep 300";
    for (let depth = 0; depth < 3; depth += 1) command = `bash -c ${JSON.stringify(command)}`;
    expect(refuseDaemonizingExecute(command)).toBeDefined();

    command = `bash -c ${JSON.stringify(command)}`;
    expect(refuseDaemonizingExecute(command)).toBeUndefined();
  });

  it("leaves malformed redirects for the shell to diagnose", () => {
    expect(refuseDaemonizingExecute("echo ready >")).toBeUndefined();
  });
});
