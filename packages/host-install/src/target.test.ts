import { describe, expect, it } from "vite-plus/test";

import { parseSshTarget, sshConfigHosts, targetArgs } from "./target";

describe("an SSH target", () => {
  it("takes you@box, a port, an alias and a bracketed address", () => {
    expect(parseSshTarget(" alice@box.example ")).toEqual({
      destination: "alice@box.example",
      port: null,
      label: "box.example",
    });
    expect(parseSshTarget("alice@box:2222")).toEqual({
      destination: "alice@box",
      port: 2222,
      label: "box",
    });
    expect(parseSshTarget("hetzner-1")).toEqual({
      destination: "hetzner-1",
      port: null,
      label: "hetzner-1",
    });
    expect(parseSshTarget("me@[2001:db8::1]:22")).toMatchObject({
      destination: "me@[2001:db8::1]",
      label: "2001:db8::1",
    });
  });

  it("refuses anything ssh would read as an option or that is not a host", () => {
    expect(parseSshTarget("")).toBe("Enter a host as you@box, or a name from ~/.ssh/config.");
    expect(parseSshTarget("a@b@c")).toBe("Enter a host as you@box, or a name from ~/.ssh/config.");
    expect(parseSshTarget("-oProxyCommand=x")).toBe("-oProxyCommand=x is not a host name.");
    expect(parseSshTarget("-x@box")).toBe("-x is not a user name.");
    expect(parseSshTarget("box:0")).toBe("0 is not a port.");
    expect(parseSshTarget("box:70000")).toBe("70000 is not a port.");
  });

  it("names the destination after --, with -p only when given", () => {
    expect(targetArgs({ destination: "a@b", port: null, label: "b" })).toEqual(["--", "a@b"]);
    expect(targetArgs({ destination: "a@b", port: 2222, label: "b" })).toEqual([
      "-p",
      "2222",
      "--",
      "a@b",
    ]);
  });

  it("lists the concrete hosts in an ssh config, each once", () => {
    const config = [
      "Host *",
      "  ForwardAgent no",
      "host studio build",
      "  HostName 10.0.0.2",
      "Host pi !bastion staging?",
      "Host studio -bad",
      "Match host x",
    ].join("\n");
    expect(sshConfigHosts(config)).toEqual(["studio", "build", "pi"]);
  });
});

// CodeQL js/polynomial-redos: a person's ssh config is read without backtracking.
describe("reading a hostile ssh config", () => {
  it("answers at once on a line of endless whitespace, and still reads tabs", () => {
    const started = performance.now();
    expect(sshConfigHosts(`host\t${"\t".repeat(100_000)}a`)).toEqual(["a"]);
    expect(sshConfigHosts(`host\ta${"\t".repeat(100_000)}`)).toEqual(["a"]);
    expect(sshConfigHosts("Hostname box\nHost\n  HOST\tlab  pi\n")).toEqual(["lab", "pi"]);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
