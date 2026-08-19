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
    // 198.18.0.0/15 spans both 198.18 and 198.19; only testing the first half
    // would leave the upper one admitted.
    ["198.19.255.254", "benchmarking"],
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
    // 64:ff9b:1::/48 is local-use IPv4/IPv6 translation space, refused whole
    // because its embedded address only means anything inside one network. Its
    // sibling 64:ff9b::/96 is globally *routable* but not therefore safe — see
    // the translation cases below, where the address that matters is the IPv4
    // one inside it.
    ["64:ff9b:1::1", "reserved"],
    ["64:ff9b:1:abcd::1", "reserved"],
    // `::/96` below the IPv4-compatible range: not loopback, not unspecified,
    // and not an address anything should be dialling either.
    ["::2", "reserved"],
    ["::ffff", "reserved"],
  ])("refuses IPv6 %s as %s", (address, cls) => {
    expect(classifyWebAddress(address)).toMatchObject({ outcome: "refuse", class: cls });
  });

  it.each([
    "2606:4700:4700::1111",
    "2001:4860:4860::8888",
    // Spelled out in full, with no `::` at all. Every other IPv6 case here uses
    // compression, so without this one the uncompressed path is never walked.
    "2606:4700:4700:0000:0000:0000:0000:1111",
    "2a00:1450:4009:0815:0000:0000:0000:200e",
  ])("admits public IPv6 %s", (address) => {
    expect(classifyWebAddress(address)).toEqual({ outcome: "public" });
  });

  it("reads loopback and link-local spelled out in full, without compression", () => {
    expect(classifyWebAddress("0000:0000:0000:0000:0000:0000:0000:0001")).toMatchObject({
      class: "loopback",
    });
    expect(classifyWebAddress("fe80:0000:0000:0000:0000:0000:0000:0001")).toMatchObject({
      class: "link-local",
    });
  });

  it("reads a scoped link-local address as link-local, not as unparsable", () => {
    // `%en0` is how a link-local address is actually written on a Mac. Refusing
    // it as unreadable would file a clear link-local refusal under the wrong name.
    expect(classifyWebAddress("fe80::1%en0")).toMatchObject({ class: "link-local" });
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
   * The two transition formats that carry an IPv4 destination inside an IPv6
   * address, and the reason a prefix being globally routable is not the same
   * claim as the address being safe to dial.
   *
   * On a network with a NAT64 gateway, `64:ff9b::` plus four octets is
   * *translated* to those octets and delivered over IPv4; 6to4 does the same
   * through a relay. So a name resolving to `64:ff9b::a9fe:a9fe` reaches
   * 169.254.169.254 — the cloud metadata service — having passed a check that
   * only read the prefix. Both are in the same IANA registry as every other
   * case in this file, and both have to be unpacked rather than admitted.
   */
  it.each([
    ["64:ff9b::7f00:1", "loopback", "NAT64 carrying 127.0.0.1"],
    ["64:ff9b::a9fe:a9fe", "link-local", "NAT64 carrying the metadata address"],
    ["64:ff9b::c0a8:1", "private-use", "NAT64 carrying 192.168.0.1"],
    ["64:ff9b::a00:1", "private-use", "NAT64 carrying 10.0.0.1"],
    ["2002:7f00:0001::", "loopback", "6to4 carrying 127.0.0.1"],
    ["2002:a9fe:a9fe::", "link-local", "6to4 carrying the metadata address"],
    ["2002:c0a8:0001::", "private-use", "6to4 carrying 192.168.0.1"],
  ])("refuses %s as %s: %s", (address, cls) => {
    expect(classifyWebAddress(address)).toMatchObject({ outcome: "refuse", class: cls });
  });

  /**
   * The other half of that rule: unpacking the embedded address must not turn
   * into refusing the prefix. A NAT64 or 6to4 address carrying a genuinely
   * public IPv4 destination is a public destination.
   */
  it.each([
    ["64:ff9b::5db8:d822", "NAT64 carrying 93.184.216.34"],
    ["2002:5db8:d822::", "6to4 carrying 93.184.216.34"],
    // The rest of 64:ff9b::/32 is neither the well-known /96 nor the local-use
    // /48, so none of it carries an embedded address to unpack. One case per
    // group that separates them, because the check reads all four and a test
    // that only varies the first would leave the other three unexercised.
    ["64:ff9b:2::1", "a 64:ff9b: address that is neither prefix"],
    ["64:ff9b:0:1::1", "the same, differing in the fourth group"],
    ["64:ff9b:0:0:1::1", "the same, differing in the fifth"],
    ["64:ff9b::1:0:1", "the same, differing in the sixth"],
  ])("admits %s: %s", (address) => {
    expect(classifyWebAddress(address)).toEqual({ outcome: "public" });
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

  /**
   * Malformed IPv6 is refused rather than padded into something classifiable.
   * An address that is short of eight groups without a `::` to say where the
   * zeros went is ambiguous, and guessing would mean classifying an address
   * nobody wrote.
   */
  it.each([
    ["1:2:3:4:5:6:7", "seven groups and no ::"],
    ["1:2:3:4:5:6:7:8:9", "nine groups"],
    ["1:2:3:4::5:6:7:8", ":: that stands for nothing"],
    ["1::2::3", "two ::"],
    ["12345::1", "a group wider than 16 bits"],
    ["::fffg", "a non-hex digit"],
    // A trailing dotted quad is how IPv4 rides inside IPv6, so a malformed one
    // has to fail the whole address rather than the four octets quietly.
    ["::ffff:999.1.1.1", "an out-of-range embedded octet"],
    ["::ffff:1.2.3", "a short embedded quad"],
  ])("refuses malformed IPv6 %s (%s)", (address) => {
    expect(classifyWebAddress(address)).toMatchObject({
      outcome: "refuse",
      class: "unparsable",
    });
  });
});
