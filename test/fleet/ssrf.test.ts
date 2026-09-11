import { describe, expect, it } from "vitest";
import {
  assertSafeUrlShape,
  isPrivateAddress,
  resolvePublicAddresses,
  safeFetch,
  SsrfBlockedError,
} from "../../src/fleet/site/ssrf.js";

describe("isPrivateAddress", () => {
  it("blocks the IPv4 ranges an SSRF would aim at", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254", // cloud metadata
      "100.64.0.1", // CGNAT
      "0.0.0.0",
      "198.18.0.1",
      "224.0.0.1",
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it("allows ordinary public IPv4", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "192.167.1.1"]) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });

  it("blocks the IPv6 equivalents", () => {
    for (const ip of [
      "::1",
      "::",
      "fc00::1",
      "fd12:3456::1",
      "fe80::1",
      "ff02::1",
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it("sees through IPv6 encodings of a private IPv4 address", () => {
    // Each of these is 169.254.169.254 wearing a different hat; judging the
    // outer form alone would let all three through.
    expect(isPrivateAddress("::ffff:169.254.169.254")).toBe(true);
    expect(isPrivateAddress("64:ff9b::169.254.169.254")).toBe(true);
    expect(isPrivateAddress("2002:a9fe:a9fe::1")).toBe(true);
  });

  it("allows public IPv6", () => {
    expect(isPrivateAddress("2606:4700:4700::1111")).toBe(false);
    expect(isPrivateAddress("::ffff:8.8.8.8")).toBe(false);
  });

  it("refuses anything it cannot parse", () => {
    expect(isPrivateAddress("not-an-ip")).toBe(true);
    expect(isPrivateAddress("999.1.1.1")).toBe(true);
  });
});

describe("assertSafeUrlShape", () => {
  it("requires https", () => {
    expect(() => assertSafeUrlShape("http://agent.example/")).toThrow(SsrfBlockedError);
    expect(assertSafeUrlShape("https://agent.example/").hostname).toBe("agent.example");
  });

  it("rejects credentials embedded in the URL", () => {
    // They would be replayed on every redirect hop.
    expect(() => assertSafeUrlShape("https://user:pw@agent.example/")).toThrow(
      /credentials/,
    );
  });

  it("rejects a literal private address", () => {
    expect(() => assertSafeUrlShape("https://169.254.169.254/latest/meta-data/")).toThrow(
      /private address/,
    );
  });

  it("rejects non-http schemes even when insecure is allowed", () => {
    expect(() =>
      assertSafeUrlShape("file:///etc/passwd", { allowInsecure: true }),
    ).toThrow(/unsupported scheme/);
  });
});

describe("resolvePublicAddresses", () => {
  it("refuses when any answer is private, not just when all are", async () => {
    // The round-robin dodge: one public answer to pass a naive check, one
    // internal answer to actually connect to.
    await expect(
      resolvePublicAddresses("mixed.example", {
        lookup: async () => [
          { address: "93.184.216.34", family: 4 },
          { address: "127.0.0.1", family: 4 },
        ],
      }),
    ).rejects.toThrow(/private address/);
  });

  it("accepts a wholly public answer set", async () => {
    const out = await resolvePublicAddresses("ok.example", {
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    });
    expect(out.addresses).toEqual(["93.184.216.34"]);
  });

  it("treats an empty answer as a failure", async () => {
    await expect(
      resolvePublicAddresses("void.example", { lookup: async () => [] }),
    ).rejects.toThrow(/cannot resolve/);
  });
});

describe("safeFetch", () => {
  const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

  it("re-validates every redirect hop", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: URL) => {
      seen.push(url.toString());
      // A public first hop that bounces to the metadata service — the exact
      // shape a follow-redirects-automatically client would fall for.
      return {
        status: 302,
        headers: new Headers({ location: "http://169.254.169.254/latest/" }),
      } as Response;
    }) as unknown as typeof fetch;

    await expect(
      safeFetch("https://agent.example/.well-known/agent-card.json", {}, {
        fetchImpl,
        lookup: publicLookup,
      }),
    ).rejects.toThrow(SsrfBlockedError);
    expect(seen).toHaveLength(1);
  });

  it("follows a safe redirect and returns the final response", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: URL) => {
      seen.push(url.toString());
      if (seen.length === 1) {
        return {
          status: 301,
          headers: new Headers({ location: "https://agent.example/card" }),
        } as Response;
      }
      return { status: 200, ok: true, headers: new Headers() } as Response;
    }) as unknown as typeof fetch;

    const res = await safeFetch("https://agent.example/", {}, {
      fetchImpl,
      lookup: publicLookup,
    });
    expect(res.status).toBe(200);
    expect(seen).toEqual(["https://agent.example/", "https://agent.example/card"]);
  });

  it("gives up after the redirect budget", async () => {
    let n = 0;
    const fetchImpl = (async () => {
      n += 1;
      return {
        status: 302,
        headers: new Headers({ location: `https://agent.example/${n}` }),
      } as Response;
    }) as unknown as typeof fetch;

    await expect(
      safeFetch("https://agent.example/", {}, {
        fetchImpl,
        lookup: publicLookup,
        maxRedirects: 2,
      }),
    ).rejects.toThrow(/too many redirects/);
  });

  it("passes redirect:manual so the runtime cannot follow on its own", async () => {
    let observed: RequestInit | undefined;
    const fetchImpl = (async (_url: URL, init: RequestInit) => {
      observed = init;
      return { status: 200, ok: true, headers: new Headers() } as Response;
    }) as unknown as typeof fetch;

    await safeFetch("https://agent.example/", {}, {
      fetchImpl,
      lookup: publicLookup,
    });
    expect(observed?.redirect).toBe("manual");
  });
});
