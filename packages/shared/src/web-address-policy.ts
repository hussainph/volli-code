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

/**
 * Classify a dotted-quad IPv4 address against the IANA IPv4 Special-Purpose
 * Address Registry (and the multicast and reserved blocks of the IPv4 address
 * space registry beside it).
 *
 * Every registry entry whose "Globally Reachable" column is `False` is refused
 * here, in registry order. The entries marked `True` — AS112 (192.31.196.0/24,
 * 192.175.48.0/24) and AMT (192.52.193.0/24) — are ordinary public unicast and
 * fall through to `public`. Two deliberate departures, both in the refusing
 * direction: 192.0.0.0/24 is refused whole although two anycast /32s inside it
 * (192.0.0.9, 192.0.0.10) are globally reachable, because no web document is
 * served from a protocol anycast address; and the deprecated 6to4 relay
 * anycast 192.88.99.0/24 is refused, because RFC 7526 retired it and what
 * answers there now is whichever relay is nearest.
 */
function classifyIpv4(octets: Ipv4Octets): WebAddressVerdict {
  const [a, b, c] = octets;
  if (a === 0) return refuse("unspecified", "0.0.0.0/8 is not a routable destination.");
  if (a === 10) return refuse("private-use", "10.0.0.0/8 is a private network.");
  if (a === 100 && b >= 64 && b <= 127)
    return refuse("carrier-grade-nat", "100.64.0.0/10 is carrier-grade NAT space.");
  if (a === 127) return refuse("loopback", "127.0.0.0/8 is this machine.");
  if (a === 169 && b === 254)
    return refuse("link-local", "169.254.0.0/16 is link-local, and hosts cloud metadata.");
  if (a === 172 && b >= 16 && b <= 31)
    return refuse("private-use", "172.16.0.0/12 is a private network.");
  // Three octets, not two. 192.0.0.0/24 is the protocol-assignment slice and
  // 192.0.2.0/24 is documentation, but the rest of 192.0.0.0/16 is ordinary
  // public space: Automattic serves WordPress VIP from 192.0.64.0/18, so
  // matching on `192.0` alone refused github.blog, slack.engineering and
  // every other site hosted there as "not public".
  if (a === 192 && b === 0 && c === 0)
    return refuse("protocol-assignment", "192.0.0.0/24 is not public.");
  if (a === 192 && b === 0 && c === 2)
    return refuse("documentation", "192.0.2.0/24 is reserved for documentation.");
  if (a === 192 && b === 88 && c === 99)
    return refuse("reserved", "192.88.99.0/24 is the retired 6to4 relay anycast block.");
  if (a === 192 && b === 168) return refuse("private-use", "192.168.0.0/16 is a private network.");
  if (a === 198 && (b === 18 || b === 19))
    return refuse("benchmarking", "198.18.0.0/15 is benchmarking space.");
  if (a === 198 && b === 51 && c === 100)
    return refuse("documentation", "198.51.100.0/24 is reserved for documentation.");
  if (a === 203 && b === 0 && c === 113)
    return refuse("documentation", "203.0.113.0/24 is reserved for documentation.");
  if (a >= 224 && a <= 239)
    return refuse("multicast", "224.0.0.0/4 is multicast, not a unicast destination.");
  // 240.0.0.0/4, with the limited broadcast address 255.255.255.255 at its top.
  if (a >= 240)
    return refuse("reserved", "240.0.0.0/4 is reserved, and holds the broadcast address.");
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

/**
 * The IPv4 address a Teredo address (2001::/32) tunnels to.
 *
 * RFC 4380 lays the address out as prefix, server IPv4, flags, port, and the
 * client's IPv4 — the last two stored bit-inverted. A Teredo packet reaches
 * that client through a relay, so the client is the destination that has to
 * pass the IPv4 policy; the server is checked too, because it is the other
 * IPv4 host the exchange involves.
 */
function teredoEndpoints(groups: Ipv6Groups): readonly [Ipv4Octets, Ipv4Octets] {
  return [embeddedIpv4(groups[2], groups[3]), embeddedIpv4(groups[6] ^ 0xffff, groups[7] ^ 0xffff)];
}

/** The first refusal among IPv4 endpoints, or `public` when every one is. */
function classifyEmbedded(endpoints: readonly Ipv4Octets[]): WebAddressVerdict {
  for (const endpoint of endpoints) {
    const verdict = classifyIpv4(endpoint);
    if (verdict.outcome === "refuse") return verdict;
  }
  return { outcome: "public" };
}

/**
 * Classify the IETF protocol-assignment block, 2001::/23.
 *
 * The registry marks the /23 as a whole not globally reachable, and lists the
 * few pieces inside it that are: three anycast /128s (PCP, TURN, DNS-SD SRP),
 * AMT 2001:3::/32, AS112 2001:4:112::/48, ORCHIDv2 2001:20::/28 and Drone
 * Remote ID 2001:30::/28. Those are admitted; Teredo is unpacked; benchmarking
 * 2001:2::/48 is named; everything else in the /23 — deprecated ORCHID
 * 2001:10::/28 and the unassigned remainder — is refused.
 */
function classifyProtocolAssignment(groups: Ipv6Groups): WebAddressVerdict {
  const [, g1, g2, g3, g4, g5, g6, g7] = groups;
  if (g1 === 0) return classifyEmbedded(teredoEndpoints(groups));
  if (g1 === 1 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 >= 1 && g7 <= 3)
    return { outcome: "public" };
  if (g1 === 2 && g2 === 0) return refuse("benchmarking", "2001:2::/48 is benchmarking space.");
  if (g1 === 3) return { outcome: "public" };
  if (g1 === 4 && g2 === 0x112) return { outcome: "public" };
  if (g1 >= 0x20 && g1 <= 0x3f) return { outcome: "public" };
  return refuse("protocol-assignment", "2001::/23 is reserved for IETF protocol assignments.");
}

/**
 * Classify eight expanded IPv6 groups against the IANA IPv6 Special-Purpose
 * Address Registry and the IPv6 address space registry.
 *
 * The space registry is the backstop: only 2000::/3 is allocated for global
 * unicast, and everything outside it that the special-purpose registry does
 * not name as reachable — 100::/64 discard-only, 5f00::/16 SRv6 SIDs, the
 * rest of 64:ff9b::/32 and every unassigned prefix — is refused rather than
 * listed one by one. Inside 2000::/3 the registry's non-reachable entries are
 * refused by name, and the formats that carry an IPv4 destination (Teredo,
 * 6to4, NAT64, mapped and compatible) are unpacked, so the address a socket
 * would really reach is the one the IPv4 policy judges.
 */
function classifyIpv6(groups: Ipv6Groups): WebAddressVerdict {
  const [g0, g1, g2] = groups;
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

  // The two translation prefixes. 64:ff9b::/96 is the well-known NAT64 prefix,
  // whose last 32 bits are the IPv4 address a gateway translates it to — so
  // that address is what gets judged. 64:ff9b:1::/48 is reserved for a
  // network's *own* translator, whose embedded address means something only
  // inside that network, so it is refused outright rather than unpacked.
  if (g0 === 0x0064 && g1 === 0xff9b) {
    if (g2 === 1) return refuse("reserved", "64:ff9b:1::/48 is local-use translation space.");
    if (g2 === 0 && groups[3] === 0 && groups[4] === 0 && groups[5] === 0) {
      return classifyIpv4(embeddedIpv4(groups[6], groups[7]));
    }
  }

  if (g0 === 0x0100 && g1 === 0 && g2 === 0 && groups[3] === 0)
    return refuse("reserved", "100::/64 is discard-only space.");
  if (g0 === 0x5f00)
    return refuse("reserved", "5f00::/16 is reserved for SRv6 segment identifiers.");
  if ((g0 & 0xe000) !== 0x2000)
    return refuse("reserved", "Only 2000::/3 is allocated for global unicast; this is outside it.");

  if (g0 === 0x2001 && g1 < 0x0200) return classifyProtocolAssignment(groups);
  if (g0 === 0x2001 && g1 === 0x0db8)
    return refuse("documentation", "2001:db8::/32 is reserved for documentation.");
  if (g0 === 0x3fff && g1 < 0x1000)
    return refuse("documentation", "3fff::/20 is reserved for documentation.");
  // 2002::/16 — 6to4, which carries its IPv4 address in the two groups after
  // the prefix and is reached through a relay to that address.
  if (g0 === 0x2002) return classifyIpv4(embeddedIpv4(g1, g2));

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
