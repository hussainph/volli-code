import { describe, expect, it } from "vite-plus/test";

import { isSensitiveKey, redactPayloadSecrets } from "./secret-redaction";

// Every credential in this file is an inert, deliberately fake fixture.
const AWS_KEY = "AKIA0123456789ABCDEF";
const AWS_SESSION_KEY = "ASIA0123456789ABCDEF";
const JWT = "eyJhbGciOiJub25lIn0.eyJmaXh0dXJlIjp0cnVlfQ.ZHVtbXk";

describe("sensitive object keys", () => {
  it.each([
    "token",
    "apiKey",
    "api_key",
    "API-KEY",
    "password",
    "Secret",
    "AUTHORIZATION",
    "credential",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "GITHUB_TOKEN",
    "DATABASE_PASSWORD",
    "VENDOR_KEY",
    "signingKey",
    "pwd",
    "DB_PWD",
    "DB_PASSWD",
    "private-key-id",
  ])("recognizes %s", (key) => expect(isSensitiveKey(key)).toBe(true));

  it.each(["command", "path", "key", "monkey", "keyboard", "keyCount", "title", "userMessages"])(
    "keeps %s",
    (key) => expect(isSensitiveKey(key)).toBe(false),
  );
});

describe("credential text", () => {
  it.each([
    AWS_KEY,
    AWS_SESSION_KEY,
    "ghp_fixture_dummy",
    "gho_fixture_dummy",
    "ghu_fixture_dummy",
    "ghs_fixture_dummy",
    "ghr_fixture_dummy",
    "github_pat_fixture_dummy",
    "sk-fixture_dummy",
    "pk_test_fixture_dummy",
    "xoxb-1234-dummy",
    "xoxp-1234-dummy",
    "xox-1234-dummy",
    JWT,
    "-----BEGIN RSA PRIVATE KEY-----\nZHVtbXk=\n-----END RSA PRIVATE KEY-----",
    "-----BEGIN OPENSSH PRIVATE KEY-----\r\nZHVtbXk=\r\n-----END OPENSSH PRIVATE KEY-----",
    "-----BEGIN PRIVATE KEY-----\nZHVtbXk=\n-----END PRIVATE KEY-----",
    "-----BEGIN CERTIFICATE-----\nZHVtbXk=\n-----END CERTIFICATE-----",
  ])("scrubs a standalone fixture without its surrounding text: %s", (secret) => {
    expect(redactPayloadSecrets(`before ${secret} after`)).toBe("before [redacted] after");
  });

  it("scrubs URL userinfo only, retaining hosts, paths, queries and command tails", () => {
    expect(
      redactPayloadSecrets(
        "fetch 'https://dummy-user:dummy-pass@example.com/path?x=1#frag'; ftp://dummy@files.example.net/x && rm -rf /important",
      ),
    ).toBe(
      "fetch 'https://[redacted]@example.com/path?x=1#frag'; ftp://[redacted]@files.example.net/x && rm -rf /important",
    );
  });

  it("retains authorization schemes and shell separators", () => {
    expect(
      redactPayloadSecrets(
        "Authorization: Basic ZHVtbXk=; Authorization: Bearer dummy|rm -rf /important",
      ),
    ).toBe("Authorization: Basic [redacted]; Authorization: Bearer [redacted]|rm -rf /important");
    expect(redactPayloadSecrets("Bearer dummy.foo.bar; done")).toBe("Bearer [redacted]; done");
    expect(redactPayloadSecrets("Authorization=dummy; Authorization: dummy; done")).toBe(
      "Authorization= [redacted]; Authorization: [redacted]; done",
    );
  });
});

describe("complete sensitive assignments", () => {
  it.each([
    "VENDOR_KEY",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_ACCESS_KEY_ID",
    "GITHUB_TOKEN",
    "DB_PASSWORD",
    "CLIENT_SECRET",
    "DB_PASSWD",
    "DB_PWD",
    "api key",
    "api-key",
    "credential",
  ])("scrubs the whole %s value, not just a prefix", (name) => {
    expect(redactPayloadSecrets(`${name}=dummy-value;rm -rf /important`)).toBe(
      `${name}= [redacted];rm -rf /important`,
    );
  });

  it.each([
    ["dummy-value&&rm", "&&rm"],
    ["dummy-value|rm", "|rm"],
    ["dummy-value&rm", "&rm"],
    ["dummy-value>out", ">out"],
    ["dummy-value<in", "<in"],
    ["dummy-value)next", ")next"],
    ["dummy-value(next", "(next"],
    ["dummy-value,next", ",next"],
    ["dummy-value\nrm", "\nrm"],
    ["dummy-value echo", " echo"],
    ['"dummy;value with spaces";rm', ";rm"],
    ["'dummy;value with spaces';rm", ";rm"],
    [String.raw`"dummy\";value";rm`, ";rm"],
    [String.raw`dummy\ with\ spaces\;more;rm`, ";rm"],
    [String.raw`'dummy\value';rm`, ";rm"],
    ["dummy\";quoted\"'with spaces'suffix;rm", ";rm"],
    ["dummy\\", ""],
    ["", ""],
  ])("handles quoted/escaped assignment %s", (assigned, tail) => {
    expect(redactPayloadSecrets(`CLIENT_SECRET=${assigned}`)).toBe(
      `CLIENT_SECRET= [redacted]${tail}`,
    );
  });

  it("retains enclosing shell quotes and the command after a quoted script", () => {
    expect(redactPayloadSecrets("bash -c 'TOKEN=dummy;echo done' && rm -rf /important")).toBe(
      "bash -c 'TOKEN= [redacted];echo done' && rm -rf /important",
    );
    expect(
      redactPayloadSecrets("bash -c \"export TOKEN='dummy;value';echo done\" && rm -rf /important"),
    ).toBe('bash -c "export TOKEN= [redacted];echo done" && rm -rf /important');
    expect(redactPayloadSecrets("printf 'TOKEN=dummy' && printf 'tail'")).toBe(
      "printf 'TOKEN= [redacted]' && printf 'tail'",
    );
    expect(redactPayloadSecrets(String.raw`printf \'start\';TOKEN="dummy" && echo tail`)).toBe(
      String.raw`printf \'start\';TOKEN= [redacted] && echo tail`,
    );
  });

  it("handles repeated assignments, safe intervening names, and separators without spaces", () => {
    expect(
      redactPayloadSecrets(
        "PORT=3000 TOKEN=dummy-a;PATH=bin DB_PASSWORD='dummy b'|rm -rf /important",
      ),
    ).toBe("PORT=3000 TOKEN= [redacted];PATH=bin DB_PASSWORD= [redacted]|rm -rf /important");
    expect(redactPayloadSecrets("password: 'dummy password', safe=hello")).toBe(
      "password: [redacted], safe=hello",
    );
  });
});

describe("curl basic and proxy credentials", () => {
  it.each([
    ["-u alice:dummy-pw", "-u alice:[redacted]"],
    ["-ualice:dummy-pw", "-ualice:[redacted]"],
    ["--user alice:dummy-pw", "--user alice:[redacted]"],
    ["--user=alice:dummy-pw", "--user=alice:[redacted]"],
    ["--proxy-user alice:dummy-pw", "--proxy-user alice:[redacted]"],
    ["--proxy-user=alice:dummy-pw", "--proxy-user=alice:[redacted]"],
    ["-Ualice:dummy-pw", "-Ualice:[redacted]"],
    ["-u 'alice:dummy password'", "-u 'alice:[redacted]'"],
    ['-u "alice:dummy password;more"', '-u "alice:[redacted]"'],
    [String.raw`-u "alice:dummy\"password"`, '-u "alice:[redacted]"'],
    [String.raw`-ualice:dummy\ with\ spaces\;more`, "-ualice:[redacted]"],
    ["-u alice:'dummy password'", "-u alice:[redacted]"],
    ['-u alice:dummy"password"suffix', "-u alice:[redacted]"],
    ["-u alice:dummy,password", "-u alice:[redacted]"],
    ["-u :dummy-pw", "-u :[redacted]"],
    ["-u alice:", "-u alice:[redacted]"],
  ])("scrubs %s", (auth, safeAuth) => {
    expect(redactPayloadSecrets(`curl ${auth};rm -rf /important`)).toBe(
      `curl ${safeAuth};rm -rf /important`,
    );
  });

  it("keeps quoted script wrappers separate from quoted credential values", () => {
    expect(redactPayloadSecrets("bash -c 'curl -u alice:dummy' && rm -rf /important")).toBe(
      "bash -c 'curl -u alice:[redacted]' && rm -rf /important",
    );
    expect(redactPayloadSecrets("bash -c \"curl -u 'alice:dummy;pw'\" && rm -rf /important")).toBe(
      "bash -c \"curl -u 'alice:[redacted]'\" && rm -rf /important",
    );
  });

  it("handles start-of-string and multiple chained credentials", () => {
    expect(redactPayloadSecrets("-u alice:dummy-a|curl --user=bob:dummy-b&echo done")).toBe(
      "-u alice:[redacted]|curl --user=bob:[redacted]&echo done",
    );
  });
});

describe("preservation and repeatability", () => {
  it.each([
    "ordinary output",
    "the token budget is exceeded",
    "password rotation is documented",
    "skip pkg-config; xoxo from the build bot",
    "authorization is per Session",
    "api key management lives in Settings",
    "https://example.com/path/alice@example.com?contact=bob@example.com",
    "curl --username alice --proxy-user alice https://example.com",
    "curl -u alice https://example.com",
    "curl -u 'alice' --user=\"bob\" https://example.com",
    "PORT=3000;echo done",
    "AKIA0123456789ABCDE",
    "eyJnot.a",
    "-----BEGIN PRIVATE KEY----- without an end",
  ])("returns a near miss unchanged: %s", (clean) => {
    expect(redactPayloadSecrets(clean)).toBe(clean);
  });

  it("never truncates command tails or changes long credential-free arguments", () => {
    const tail = ` && echo ${"x".repeat(40_000)} && rm -rf /important`;
    expect(redactPayloadSecrets(`TOKEN=dummy${tail}`)).toBe(`TOKEN= [redacted]${tail}`);
    const clean = `https://${"a".repeat(40_000)} /path/private@example.com curl -u ${"b".repeat(40_000)} && echo end`;
    expect(redactPayloadSecrets(clean)).toBe(clean);
    const hyphenatedNearMiss = `key-${"word-".repeat(10_000)}word`;
    expect(redactPayloadSecrets(hyphenatedNearMiss)).toBe(hyphenatedNearMiss);
  });

  it("is idempotent across repeated callers", () => {
    const raw = `TOKEN=dummy; curl -u 'alice:dummy' https://dummy@example.com ${AWS_KEY} ${JWT}; Authorization: Basic ZHVtbXk=`;
    const safe = redactPayloadSecrets(raw);
    expect(redactPayloadSecrets(safe)).toBe(safe);
    expect(redactPayloadSecrets("unchanged")).toBe("unchanged");
    expect(redactPayloadSecrets(raw)).toBe(safe);
  });
});
