/**
 * Whether one resolved IP address is on the public Internet.
 *
 * The load-bearing half of Volli's web boundary, and the reason it is a pure
 * function: `./web-target-policy.ts` can refuse a name that *looks* local, but a
 * hostname its operator controls resolves to whatever they choose. Only an
 * address check sees that, and it must run against the addresses the runtime is
 * about to connect to rather than against the name it started from.
 *
 * Classification follows the IANA special-purpose registries rather than the
 * three RFC 1918 ranges most SSRF bugs check. Carrier-grade NAT, link-local,
 * benchmarking and the `192.0.0.0/24` protocol-assignment slice are all
 * non-public and none of them are RFC 1918.
 */

/**
 * Why an address is not the public Internet.
 *
 * Named per class rather than as one `not-public` flag so a refusal can be
 * counted and read: "link-local" and "carrier-grade NAT" are different
 * operational stories, and the metadata-service case is the one worth being
 * able to find in a ledger.
 */
export type WebAddressClass =
  | "unparsable"
  | "unspecified"
  | "loopback"
  | "private-use"
  | "link-local"
  | "carrier-grade-nat"
  | "protocol-assignment"
  | "documentation"
  | "benchmarking"
  | "multicast"
  | "reserved"
  | "unique-local";

/** One address's verdict: connectable, or refused under a named class. */
export type WebAddressVerdict =
  | { outcome: "public" }
  | { outcome: "refuse"; class: WebAddressClass; reason: string };

function refuse(cls: WebAddressClass, reason: string): WebAddressVerdict {
  return { outcome: "refuse", class: cls, reason };
}

/** A dotted-quad IPv4 address, expanded. Four octets, never a different count. */
type Ipv4Octets = readonly [number, number, number, number];

/** Parse dotted-quad IPv4 into its four octets, or nothing if it is not one. */
function ipv4Octets(address: string): Ipv4Octets | undefined {
  const parts = address.split(".");
  if (parts.length !== 4) return undefined;
  const octets: number[] = [];
  for (const part of parts) {
    // Rejecting anything but plain decimal is deliberate: `0177.0.0.1` and
    // `0x7f.0.0.1` are read as loopback by some resolvers and as nonsense by
    // others, and a policy that guesses which is a policy that can be wrong.
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const value = Number(part);
    if (value > 255) return undefined;
    octets.push(value);
  }
  // Four in, four out: the length was checked above and every part either
  // pushed one octet or returned. The assertion carries that fact into the
  // type so no reader below needs a fallback that cannot happen.
  return octets as unknown as Ipv4Octets;
}

/** Classify a dotted-quad IPv4 address against the IANA special-purpose registry. */
function classifyIpv4(octets: Ipv4Octets): WebAddressVerdict {
  const [a, b] = octets;
  if (a === 0) return refuse("unspecified", "0.0.0.0/8 is not a routable destination.");
  if (a === 127) return refuse("loopback", "127.0.0.0/8 is this machine.");
  if (a === 10) return refuse("private-use", "10.0.0.0/8 is a private network.");
  if (a === 172 && b >= 16 && b <= 31)
    return refuse("private-use", "172.16.0.0/12 is a private network.");
  if (a === 192 && b === 168) return refuse("private-use", "192.168.0.0/16 is a private network.");
  if (a === 169 && b === 254)
    return refuse("link-local", "169.254.0.0/16 is link-local, and hosts cloud metadata.");
  if (a === 100 && b >= 64 && b <= 127)
    return refuse("carrier-grade-nat", "100.64.0.0/10 is carrier-grade NAT space.");
  if (a === 192 && b === 0) return refuse("protocol-assignment", "192.0.0.0/24 is not public.");
  if (a === 198 && (b === 18 || b === 19))
    return refuse("benchmarking", "198.18.0.0/15 is benchmarking space.");
  if (a >= 224) return refuse("multicast", "224.0.0.0/4 and above are not unicast destinations.");
  return { outcome: "public" };
}

/**
 * An expanded IPv6 address: exactly eight 16-bit groups, never fewer.
 *
 * A tuple rather than an array because the length is an invariant this module
 * establishes and then depends on. Spelled as `number[]`, every read below needs
 * a `?? 0` that can never fire, which is a fallback the tests cannot reach and a
 * reader cannot tell from a real one.
 */
type Ipv6Groups = readonly [number, number, number, number, number, number, number, number];

/**
 * Expand an IPv6 address into its eight 16-bit groups.
 *
 * Handles the two spellings that matter for policy: `::` zero-compression, and
 * a trailing dotted-quad (`::ffff:127.0.0.1`), which occupies the last two
 * groups. A scope/zone suffix is dropped before parsing rather than refused —
 * `fe80::1%en0` is still link-local, and reading it as unparsable would file a
 * clear link-local refusal under the wrong name.
 */
function ipv6Groups(address: string): Ipv6Groups | undefined {
  // `slice` rather than `split`, so every piece below is a string by
  // construction and none of them needs a fallback that cannot fire.
  const zone = address.indexOf("%");
  const zoned = zone === -1 ? address : address.slice(0, zone);
  if (!zoned.includes(":")) return undefined;
  const compressedAt = zoned.indexOf("::");
  // A second `::` makes the address ambiguous about where the zeros went.
  if (compressedAt !== -1 && zoned.indexOf("::", compressedAt + 1) !== -1) return undefined;

  const parseSide = (side: string): number[] | undefined => {
    if (side === "") return [];
    const groups: number[] = [];
    const parts = side.split(":");
    for (const [index, part] of parts.entries()) {
      if (index === parts.length - 1 && part.includes(".")) {
        const octets = ipv4Octets(part);
        if (octets === undefined) return undefined;
        groups.push((octets[0] << 8) | octets[1]);
        groups.push((octets[2] << 8) | octets[3]);
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return undefined;
      groups.push(Number.parseInt(part, 16));
    }
    return groups;
  };

  const head = parseSide(compressedAt === -1 ? zoned : zoned.slice(0, compressedAt));
  const tail = compressedAt === -1 ? [] : parseSide(zoned.slice(compressedAt + 2));
  if (head === undefined || tail === undefined) return undefined;

  // One `::` stands for at least one zero group, so the two sides together must
  // leave a gap; without it, the address had to spell all eight itself.
  if (compressedAt === -1) {
    if (head.length !== 8) return undefined;
  } else if (head.length + tail.length > 7) return undefined;

  // Filled from both ends into a tuple that is eight wide from the start, so the
  // length is true by construction rather than by a check nothing can fail.
  const groups: [number, number, number, number, number, number, number, number] = [
    0, 0, 0, 0, 0, 0, 0, 0,
  ];
  for (const [index, group] of head.entries()) groups[index] = group;
  for (const [index, group] of tail.entries()) groups[8 - tail.length + index] = group;
  return groups;
}

/**
 * The IPv4 address two 16-bit groups spell.
 *
 * Shared by every format that embeds one — v4-mapped, v4-compatible, NAT64 and
 * 6to4 — so there is one way to read those four octets and no chance of two
 * call sites disagreeing about which half is which.
 */
function embeddedIpv4(high: number, low: number): Ipv4Octets {
  return [(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff];
}

/** Classify eight expanded IPv6 groups against the IANA special-purpose registry. */
function classifyIpv6(groups: Ipv6Groups): WebAddressVerdict {
  const [g0, g1] = groups;
  const leadingZero = groups.slice(0, 5).every((group) => group === 0);

  // An IPv4 destination in IPv6 clothing. Both the mapped (`::ffff:a.b.c.d`)
  // and the deprecated compatible (`::a.b.c.d`) forms reach an IPv4 host, so
  // the IPv4 policy has to be the one that answers for them.
  if (leadingZero && (groups[5] === 0xffff || groups[5] === 0)) {
    const embedded = embeddedIpv4(groups[6], groups[7]);
    const allZero = groups.every((group) => group === 0);
    if (allZero) return refuse("unspecified", ":: is not a routable destination.");
    if (groups[5] === 0 && groups[6] === 0 && groups[7] === 1)
      return refuse("loopback", "::1 is this machine.");
    if (groups[5] === 0 && groups[6] === 0) return refuse("reserved", "::/96 is not public.");
    return classifyIpv4(embedded);
  }

  if ((g0 & 0xff00) === 0xff00)
    return refuse("multicast", "ff00::/8 is not a unicast destination.");
  if ((g0 & 0xffc0) === 0xfe80) return refuse("link-local", "fe80::/10 is link-local.");
  if ((g0 & 0xfe00) === 0xfc00)
    return refuse("unique-local", "fc00::/7 is a private network, and hosts cloud metadata.");
  if (g0 === 0x2001 && g1 === 0x0db8)
    return refuse("documentation", "2001:db8::/32 is reserved for documentation.");

  // The two transition formats that carry an IPv4 destination inside an IPv6
  // address. Both are in the same IANA registry as everything above, and both
  // are reached by ordinary routing where they are deployed, so the address a
  // socket ends up talking to is the embedded one — which means the IPv4 policy
  // has to be what answers for them, exactly as it does for `::ffff:a.b.c.d`.
  //
  // The local-use translation prefix is refused outright rather than unpacked:
  // 64:ff9b:1::/48 is reserved for a network's *own* translator, so its
  // embedded address is meaningful only inside that network.
  if (g0 === 0x0064 && g1 === 0xff9b) {
    if (groups[2] === 1)
      return refuse("reserved", "64:ff9b:1::/48 is local-use translation space.");
    // 64:ff9b::/96 — the well-known prefix, whose last 32 bits are the IPv4
    // address a NAT64 gateway will translate this to.
    if (groups[2] === 0 && groups[3] === 0 && groups[4] === 0 && groups[5] === 0) {
      return classifyIpv4(embeddedIpv4(groups[6], groups[7]));
    }
  }
  // 2002::/16 — 6to4, which carries its IPv4 address in the two groups after
  // the prefix.
  if (g0 === 0x2002) return classifyIpv4(embeddedIpv4(g1, groups[2]));

  return { outcome: "public" };
}

/**
 * Judge one already-resolved IP address.
 *
 * Fails closed: an address this function cannot parse is refused rather than
 * assumed public, because "I could not tell" and "it is fine" must not be the
 * same answer in a security boundary.
 */
export function classifyWebAddress(address: string): WebAddressVerdict {
  const octets = ipv4Octets(address);
  if (octets !== undefined) return classifyIpv4(octets);
  const groups = ipv6Groups(address);
  if (groups !== undefined) return classifyIpv6(groups);
  return refuse("unparsable", `${address} is not an IP address this policy can classify.`);
}
