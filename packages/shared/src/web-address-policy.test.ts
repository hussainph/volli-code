import { describe, expect, it } from "vite-plus/test";

import { classifyWebAddress } from "./web-address-policy";

describe("web address classification", () => {
  /**
   * The distinction the whole boundary rests on. Every address the runtime
   * resolves is put through here, and only a `public` verdict may be connected
   * to — so this is the one function that decides whether a hostname can be
   * pointed at the machine Volli is running on.
   */
  it("separates an ordinary public address from loopback", () => {
    expect(classifyWebAddress("93.184.216.34")).toEqual({ outcome: "public" });
    expect(classifyWebAddress("127.0.0.1")).toMatchObject({
      outcome: "refuse",
      class: "loopback",
    });
  });

  /**
   * The ranges an SSRF guard that only knows RFC 1918 would let straight
   * through. Each expected class here comes from the IANA special-purpose
   * registry, not from re-running the implementation's own arithmetic.
   */
  it.each([
    ["0.0.0.0", "unspecified"],
    ["127.0.0.1", "loopback"],
    ["127.1.2.3", "loopback"],
    ["10.0.0.1", "private-use"],
    ["172.16.0.1", "private-use"],
    ["172.31.255.254", "private-use"],
    ["192.168.1.1", "private-use"],
    ["169.254.169.254", "link-local"],
    ["100.64.0.1", "carrier-grade-nat"],
    ["192.0.0.1", "protocol-assignment"],
    ["198.18.0.1", "benchmarking"],
    ["224.0.0.1", "multicast"],
    ["255.255.255.255", "multicast"],
  ])("refuses %s as %s", (address, cls) => {
    expect(classifyWebAddress(address)).toMatchObject({ outcome: "refuse", class: cls });
  });

  it.each(["8.8.8.8", "1.1.1.1", "172.32.0.1", "192.169.0.1", "100.128.0.1", "199.18.0.1"])(
    "admits %s, which neighbours a blocked range without being in it",
    (address) => {
      // Off-by-one guards. `172.32.0.1` and `100.128.0.1` sit one step outside
      // 172.16/12 and 100.64/10; refusing them would be a policy that quietly
      // breaks ordinary sites.
      expect(classifyWebAddress(address)).toEqual({ outcome: "public" });
    },
  );

  /**
   * IPv6 is not an afterthought here. A hostname with only an AAAA record is
   * routine, and an IPv4-only guard admits `::1` by failing to recognise it.
   */
  it.each([
    ["::", "unspecified"],
    ["::1", "loopback"],
    ["fe80::1", "link-local"],
    ["fe80::a00:27ff:fe4e:66a1", "link-local"],
    ["fc00::1", "unique-local"],
    ["fd00:ec2::254", "unique-local"],
    ["ff02::1", "multicast"],
    ["2001:db8::1", "documentation"],
  ])("refuses IPv6 %s as %s", (address, cls) => {
    expect(classifyWebAddress(address)).toMatchObject({ outcome: "refuse", class: cls });
  });

  it.each(["2606:4700:4700::1111", "2001:4860:4860::8888"])("admits public IPv6 %s", (address) => {
    expect(classifyWebAddress(address)).toEqual({ outcome: "public" });
  });

  /**
   * An IPv4-mapped IPv6 address is an IPv4 destination wearing a different
   * spelling, so the IPv4 policy has to be applied to the address inside it.
   * `::ffff:127.0.0.1` is loopback however it is written.
   */
  it.each([
    ["::ffff:127.0.0.1", "loopback"],
    ["::ffff:169.254.169.254", "link-local"],
    ["::ffff:10.0.0.1", "private-use"],
  ])("applies the IPv4 policy through mapped form %s", (address, cls) => {
    expect(classifyWebAddress(address)).toMatchObject({ outcome: "refuse", class: cls });
  });

  /**
   * Fail closed. `2130706433` and `0x7f.0.0.1` are spellings of 127.0.0.1 that
   * some resolvers accept; rather than guess which, the policy refuses anything
   * it cannot classify. "I could not tell" must never mean "it is fine".
   */
  it.each(["2130706433", "0x7f.0.0.1", "0177.0.0.1", "1.1.1", "999.1.1.1", "", "not-an-ip"])(
    "refuses %s rather than assuming it is public",
    (address) => {
      expect(classifyWebAddress(address)).toMatchObject({ outcome: "refuse" });
    },
  );
});
