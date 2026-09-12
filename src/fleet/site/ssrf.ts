import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Registration hands us a URL chosen by a tenant and asks us to fetch it
 * (docs §5 step 2) — a textbook SSRF entry point. Everything here exists so
 * that "fetch this agent's card" cannot be turned into "read the cloud
 * metadata endpoint for me".
 */

export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfBlockedError";
  }
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = value * 256 + n;
  }
  return value >>> 0;
}

/** [network, prefix length] pairs that must never be dialled. */
const BLOCKED_V4: Array<[string, number]> = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // RFC1918
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local — includes 169.254.169.254
  ["172.16.0.0", 12], // RFC1918
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.168.0.0", 16], // RFC1918
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved / broadcast
];

function isPrivateIPv4(ip: string): boolean {
  const value = ipv4ToInt(ip);
  if (value === null) return true; // unparseable — refuse rather than guess
  for (const [network, bits] of BLOCKED_V4) {
    const base = ipv4ToInt(network);
    if (base === null) continue;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if ((value & mask) === (base & mask)) return true;
  }
  return false;
}

function expandIPv6(ip: string): number[] | null {
  const zone = ip.indexOf("%");
  const bare = zone === -1 ? ip : ip.slice(0, zone);
  const [head, tail] = bare.split("::") as [string, string | undefined];
  const parse = (segment: string): string[] =>
    segment.length === 0 ? [] : segment.split(":");
  // A trailing dotted quad (`::ffff:8.8.8.8`) spans two 16-bit groups, so it
  // counts as two when working out how many zero groups `::` stands in for.
  const groupCount = (segments: string[]): number =>
    segments.reduce((n, s) => n + (s.includes(".") ? 2 : 1), 0);

  let groups: string[];
  if (tail === undefined) {
    groups = parse(head);
    if (groupCount(groups) !== 8) return null;
  } else {
    const left = parse(head);
    const right = parse(tail);
    const fill = 8 - groupCount(left) - groupCount(right);
    if (fill < 0) return null;
    groups = [...left, ...Array<string>(fill).fill("0"), ...right];
  }

  const out: number[] = [];
  for (const group of groups) {
    // A trailing dotted-quad (::ffff:127.0.0.1) occupies two groups.
    if (group.includes(".")) {
      const v4 = ipv4ToInt(group);
      if (v4 === null) return null;
      out.push((v4 >>> 16) & 0xffff, v4 & 0xffff);
      continue;
    }
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    out.push(Number.parseInt(group, 16));
  }
  return out.length === 8 ? out : null;
}

function groupsToIPv4(groups: number[], offset: number): string {
  const hi = groups[offset];
  const lo = groups[offset + 1];
  return [hi >>> 8, hi & 0xff, lo >>> 8, lo & 0xff].join(".");
}

function isPrivateIPv6(ip: string): boolean {
  const g = expandIPv6(ip);
  if (!g) return true;

  const allZero = g.every((x) => x === 0);
  if (allZero) return true; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1

  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible: judge the embedded v4,
  // otherwise ::ffff:169.254.169.254 walks straight past the v4 rules.
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return isPrivateIPv4(groupsToIPv4(g, 6));
  }
  // NAT64 well-known prefix 64:ff9b::/96
  if (g[0] === 0x0064 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
    return isPrivateIPv4(groupsToIPv4(g, 6));
  }
  // 6to4 2002::/16 embeds the v4 address in the next two groups.
  if (g[0] === 0x2002) return isPrivateIPv4(groupsToIPv4(g, 1));

  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast

  return false;
}

export function isPrivateAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isPrivateIPv4(ip);
  if (version === 6) return isPrivateIPv6(ip);
  return true;
}

export interface UrlPolicy {
  /** Allow `http:` and private addresses. Tests and local dev only. */
  allowInsecure?: boolean;
}

/** Shape checks that need no network: scheme, credentials, port. */
export function assertSafeUrlShape(raw: string, policy: UrlPolicy = {}): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SsrfBlockedError(`not a valid URL: ${raw}`);
  }

  if (!policy.allowInsecure && url.protocol !== "https:") {
    throw new SsrfBlockedError(`only https is allowed, got ${url.protocol}`);
  }
  if (policy.allowInsecure && url.protocol !== "https:" && url.protocol !== "http:") {
    throw new SsrfBlockedError(`unsupported scheme: ${url.protocol}`);
  }
  // Credentials in the URL would be forwarded on every redirect hop.
  if (url.username || url.password) {
    throw new SsrfBlockedError("credentials in the URL are not allowed");
  }
  if (!policy.allowInsecure && isIP(url.hostname) && isPrivateAddress(url.hostname)) {
    throw new SsrfBlockedError(`private address is not allowed: ${url.hostname}`);
  }
  return url;
}

export interface ResolvedHost {
  hostname: string;
  addresses: string[];
}

export type LookupFn = (
  hostname: string,
) => Promise<Array<{ address: string; family: number }>>;

const defaultLookup: LookupFn = async (hostname) =>
  dnsLookup(hostname, { all: true });

/**
 * Resolve and refuse if *any* answer is private. Rejecting on any, rather
 * than picking the public ones, closes the round-robin variant where an
 * attacker mixes one public and one internal address.
 */
export async function resolvePublicAddresses(
  hostname: string,
  opts: { lookup?: LookupFn; policy?: UrlPolicy } = {},
): Promise<ResolvedHost> {
  if (opts.policy?.allowInsecure) return { hostname, addresses: [] };

  if (isIP(hostname)) {
    if (isPrivateAddress(hostname)) {
      throw new SsrfBlockedError(`private address is not allowed: ${hostname}`);
    }
    return { hostname, addresses: [hostname] };
  }

  let answers: Array<{ address: string; family: number }>;
  try {
    answers = await (opts.lookup ?? defaultLookup)(hostname);
  } catch (err) {
    throw new SsrfBlockedError(
      `cannot resolve ${hostname}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (answers.length === 0) {
    throw new SsrfBlockedError(`cannot resolve ${hostname}`);
  }
  for (const answer of answers) {
    if (isPrivateAddress(answer.address)) {
      throw new SsrfBlockedError(
        `${hostname} resolves to a private address: ${answer.address}`,
      );
    }
  }
  return { hostname, addresses: answers.map((a) => a.address) };
}

export interface SafeFetchOptions {
  policy?: UrlPolicy;
  lookup?: LookupFn;
  fetchImpl?: typeof fetch;
  maxRedirects?: number;
  timeoutMs?: number;
  /**
   * Caller-owned controller for the whole request, not just the header wait.
   * When supplied, the header-wait timer aborts this controller instead of
   * one scoped to this call, so a caller that keeps it can also abort the
   * body read after headers arrive — freeing the connection even once its
   * own reader (e.g. `res.json()`) has locked the stream.
   */
  controller?: AbortController;
}

/**
 * Fetch with every redirect hop re-validated. `redirect: "manual"` is the
 * point: letting the runtime follow redirects would check only the first URL
 * and happily chase a `302` into the metadata service.
 */
export async function safeFetch(
  rawUrl: string,
  init: RequestInit = {},
  opts: SafeFetchOptions = {},
): Promise<Response> {
  const doFetch = opts.fetchImpl ?? fetch;
  const maxRedirects = opts.maxRedirects ?? 3;
  const timeoutMs = opts.timeoutMs ?? 10_000;

  let current = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const url = assertSafeUrlShape(current, opts.policy);
    await resolvePublicAddresses(url.hostname, {
      lookup: opts.lookup,
      policy: opts.policy,
    });

    const controller = opts.controller ?? new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await doFetch(url, {
        ...init,
        redirect: "manual",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (res.status < 300 || res.status >= 400) return res;

    const location = res.headers.get("location");
    if (!location) return res;
    current = new URL(location, url).toString();
  }

  throw new SsrfBlockedError(`too many redirects (max ${maxRedirects})`);
}
