// A GET-only HTTPS client for fetching things the model (or a DID document, or
// a profile) points at. Those addresses are attacker-controlled, so before any
// byte is sent the client checks that the URL is public HTTPS, resolves the
// name itself, refuses private/reserved answers, and then connects to the very
// address it validated — a second DNS lookup can't swap in an internal one.
// Redirects are re-validated hop by hop. Requests carry no credentials: the
// headers are fixed, callers cannot add any.
//
// DNS and the socket are seams (`resolve`, `transport`) so the policy is
// testable without a network.

import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP, isIPv4 } from "node:net";

export const DEFAULT_MAX_BYTES = 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_REDIRECTS = 4;

const MAX_URL_LENGTH = 2048;
const MAX_ADDRESS_ATTEMPTS = 4;
const USER_AGENT = "streamplace-bot-example/0.1 (scheduling research; public GET only)";

/** The destination is not public HTTPS, so nothing was sent. */
export class UnsafeUrlError extends Error {
  override name = "UnsafeUrlError";
}

/** A resolved address for a host. */
export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

export interface TransportRequest {
  /** The validated URL; its hostname is for SNI/Host/certificate checks only. */
  url: URL;
  /** The validated address to connect to. Never re-resolve the hostname. */
  address: ResolvedAddress;
  headers: Record<string, string>;
  /** Cap on body bytes to read; anything beyond it is dropped. */
  maxBytes: number;
  timeoutMs: number;
}

export interface TransportResponse {
  status: number;
  /** Lower-cased header names. */
  headers: Record<string, string>;
  body: Uint8Array;
  /** The body was cut at `maxBytes`. */
  truncated: boolean;
}

export type Transport = (request: TransportRequest) => Promise<TransportResponse>;

export interface SafeFetchOptions {
  /** `Accept` header value. */
  accept?: string;
  maxBytes?: number;
  /** Wall-clock budget for DNS, connecting and every redirect hop together. */
  timeoutMs?: number;
  maxRedirects?: number;
  resolve?: Resolver;
  transport?: Transport;
}

export interface SafeResponse {
  /** The URL the body came from, after redirects. */
  url: string;
  status: number;
  contentType: string | null;
  body: Uint8Array;
  truncated: boolean;
  /** Each URL redirected to, in order. */
  redirects: string[];
}

export type SafeFetcher = (url: string, options?: SafeFetchOptions) => Promise<SafeResponse>;

// ---------------------------------------------------------------------------
// Address policy

function isPublicIPv4(bytes: readonly number[]): boolean {
  const [a, b, c] = bytes as [number, number, number, number];
  if (a === 0) return false; // "this" network
  if (a === 10) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
  if (a === 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 0 && c === 0) return false; // IETF protocol assignments
  if (a === 192 && b === 0 && c === 2) return false; // documentation
  if (a === 192 && b === 88 && c === 99) return false; // 6to4 relay anycast
  if (a === 192 && b === 168) return false;
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51 && c === 100) return false; // documentation
  if (a === 203 && b === 0 && c === 113) return false; // documentation
  if (a >= 224) return false; // multicast, reserved, broadcast
  return true;
}

/** Eight 16-bit groups, or null when `address` is not an IPv6 literal. */
function parseIPv6(address: string): number[] | null {
  if (address.includes("%")) return null;
  let text = address;
  if (text.includes(".")) {
    const lastColon = text.lastIndexOf(":");
    const tail = text.slice(lastColon + 1);
    if (!isIPv4(tail)) return null;
    const [a, b, c, d] = tail.split(".").map(Number) as [number, number, number, number];
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] === "" ? [] : halves[0]!.split(":");
  let groups: string[];
  if (halves.length === 1) {
    groups = head;
  } else {
    const rest = halves[1] === "" ? [] : halves[1]!.split(":");
    const fill = 8 - head.length - rest.length;
    if (fill < 1) return null;
    groups = [...head, ...new Array<string>(fill).fill("0"), ...rest];
  }
  if (groups.length !== 8) return null;
  const parsed: number[] = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
    parsed.push(parseInt(group, 16));
  }
  return parsed;
}

function embeddedIPv4(high: number, low: number): number[] {
  return [high >> 8, high & 0xff, low >> 8, low & 0xff];
}

function isPublicIPv6(g: readonly number[]): boolean {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [number, number, number, number, number, number, number, number];
  // ::ffff:a.b.c.d — an IPv4 address in IPv6 clothing is judged as IPv4.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return isPublicIPv4(embeddedIPv4(g6, g7));
  }
  // 64:ff9b::/96 NAT64 carries an IPv4 destination.
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return isPublicIPv4(embeddedIPv4(g6, g7));
  }
  // Everything outside global unicast 2000::/3 is unspecified, loopback,
  // unique-local, link-local, multicast, or otherwise not routable.
  if ((g0 & 0xe000) !== 0x2000) return false;
  if (g0 === 0x2001 && g1 < 0x0200) return false; // IETF protocol assignments, Teredo, ORCHID
  if (g0 === 0x2001 && g1 === 0x0db8) return false; // documentation
  if (g0 === 0x2002) return isPublicIPv4(embeddedIPv4(g1, g2)); // 6to4
  if (g0 === 0x3fff && (g1 & 0xf000) === 0) return false; // documentation
  if (g0 === 0x5f00) return false; // SRv6 SIDs
  return true;
}

/** True only for an address a public web server could have. */
export function isPublicAddress(address: string): boolean {
  if (isIPv4(address)) return isPublicIPv4(address.split(".").map(Number));
  const groups = parseIPv6(address);
  return groups !== null && isPublicIPv6(groups);
}

const INTERNAL_SUFFIXES = [
  ".localhost",
  ".local",
  ".localdomain",
  ".internal",
  ".intranet",
  ".private",
  ".lan",
  ".home",
  ".corp",
  ".home.arpa",
  ".test",
  ".invalid",
  ".example",
  ".onion",
];

/** Names that are internal by convention, whatever DNS says about them. */
function isInternalHostname(hostname: string): boolean {
  if (!hostname.includes(".")) return true; // single label: search-domain bait
  return INTERNAL_SUFFIXES.some((suffix) => hostname.endsWith(suffix));
}

// ---------------------------------------------------------------------------
// URL policy

/** Parses `input` and enforces everything that can be checked without DNS. */
export function parsePublicHttpsUrl(input: string): URL {
  if (input.length > MAX_URL_LENGTH) throw new UnsafeUrlError("URL is too long");
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new UnsafeUrlError(`not a valid URL: ${JSON.stringify(input.slice(0, 200))}`);
  }
  if (url.protocol !== "https:") throw new UnsafeUrlError(`only https URLs are allowed, got ${url.protocol}`);
  if (url.username !== "" || url.password !== "") throw new UnsafeUrlError("URLs with credentials are not allowed");
  if (url.port !== "") throw new UnsafeUrlError("only the default HTTPS port is allowed");

  // The WHATWG parser has already normalised numeric forms (2130706433, 0x7f.1)
  // to dotted IPv4.
  const hostname = hostOf(url);
  if (hostname === "") throw new UnsafeUrlError("URL has no host");

  if (isIP(hostname) !== 0) {
    if (!isPublicAddress(hostname)) throw new UnsafeUrlError(`address ${hostname} is not a public address`);
  } else if (isInternalHostname(hostname)) {
    throw new UnsafeUrlError(`host ${hostname} is an internal name`);
  }
  return url;
}

function hostOf(url: URL): string {
  const hostname = url.hostname.toLowerCase();
  const bare = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;
  return bare.endsWith(".") ? bare.slice(0, -1) : bare;
}

// ---------------------------------------------------------------------------
// DNS and sockets

async function dnsResolve(hostname: string): Promise<ResolvedAddress[]> {
  const answers = await lookup(hostname, { all: true, verbatim: true });
  return answers.map(({ address, family }) => ({ address, family: family === 6 ? 6 : 4 }));
}

function httpsTransport(request: TransportRequest): Promise<TransportResponse> {
  const { url, address, headers, maxBytes, timeoutMs } = request;
  const hostname = hostOf(url);
  return new Promise((resolve, reject) => {
    const req = httpsRequest({
      host: address.address,
      family: address.family,
      port: 443,
      method: "GET",
      path: `${url.pathname}${url.search}`,
      headers: { ...headers, host: url.host },
      // Certificate and SNI are checked against the name, not the pinned IP.
      servername: isIP(hostname) === 0 ? hostname : undefined,
      agent: false,
    });
    const timer = setTimeout(() => req.destroy(new Error(`request timed out after ${timeoutMs}ms`)), timeoutMs);
    const done = <T>(fn: (value: T) => void) => (value: T) => {
      clearTimeout(timer);
      fn(value);
    };
    const fail = done<Error>(reject);

    req.on("error", fail);
    req.on("response", (res) => {
      const encoding = res.headers["content-encoding"];
      if (encoding !== undefined && encoding !== "identity") {
        res.destroy();
        fail(new Error(`unsupported content-encoding ${encoding}`));
        return;
      }
      const responseHeaders: Record<string, string> = {};
      for (const [name, value] of Object.entries(res.headers)) {
        if (typeof value === "string") responseHeaders[name] = value;
        else if (Array.isArray(value) && value[0] !== undefined) responseHeaders[name] = value[0];
      }
      const chunks: Buffer[] = [];
      let size = 0;
      let finished = false;
      const finish = (truncated: boolean) => {
        if (finished) return;
        finished = true;
        done(resolve)({
          status: res.statusCode ?? 0,
          headers: responseHeaders,
          body: new Uint8Array(Buffer.concat(chunks)),
          truncated,
        });
      };
      res.on("data", (chunk: Buffer) => {
        if (finished) return;
        const room = maxBytes - size;
        if (chunk.length > room) {
          chunks.push(chunk.subarray(0, room));
          size = maxBytes;
          finish(true);
          res.destroy();
          return;
        }
        chunks.push(chunk);
        size += chunk.length;
      });
      res.on("end", () => finish(false));
      res.on("error", (error) => {
        if (!finished) fail(error);
      });
      res.on("close", () => {
        if (!finished) fail(new Error("connection closed before the response finished"));
      });
    });
    req.end();
  });
}

function withDeadline<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function remaining(deadline: number): number {
  const ms = deadline - Date.now();
  if (ms <= 0) throw new Error("request timed out");
  return ms;
}

/** Resolves `url`'s host and requires every answer to be public. */
async function validatedAddresses(url: URL, resolve: Resolver, deadline: number): Promise<ResolvedAddress[]> {
  const hostname = hostOf(url);
  const family = isIP(hostname);
  if (family !== 0) return [{ address: hostname, family: family === 6 ? 6 : 4 }];

  const answers = await withDeadline(resolve(hostname), remaining(deadline), `DNS lookup for ${hostname}`);
  if (answers.length === 0) throw new Error(`DNS lookup for ${hostname} returned no addresses`);
  // Any private answer poisons the name: a mixed answer set is how rebinding
  // and split-horizon tricks are served, and picking "the good one" isn't ours to do.
  const blocked = answers.find(({ address }) => !isPublicAddress(address));
  if (blocked !== undefined) {
    throw new UnsafeUrlError(`${hostname} resolves to non-public address ${blocked.address}`);
  }
  return answers;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * GETs a public HTTPS URL. Non-2xx statuses are returned, not thrown; policy
 * violations throw `UnsafeUrlError`, and network failures throw plain errors.
 */
export async function safeFetch(input: string, options: SafeFetchOptions = {}): Promise<SafeResponse> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const resolve = options.resolve ?? dnsResolve;
  const transport = options.transport ?? httpsTransport;
  const headers: Record<string, string> = {
    accept: options.accept ?? "*/*",
    "accept-encoding": "identity",
    "user-agent": USER_AGENT,
  };

  const redirects: string[] = [];
  let url = parsePublicHttpsUrl(input);
  for (;;) {
    const addresses = await validatedAddresses(url, resolve, deadline);

    let response: TransportResponse | undefined;
    let lastError: unknown;
    for (const address of addresses.slice(0, MAX_ADDRESS_ATTEMPTS)) {
      try {
        response = await transport({ url, address, headers, maxBytes, timeoutMs: remaining(deadline) });
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (response === undefined) {
      throw lastError instanceof Error ? lastError : new Error(`could not connect to ${hostOf(url)}`);
    }

    const location = response.headers["location"];
    if (REDIRECT_STATUSES.has(response.status) && location !== undefined) {
      if (redirects.length >= maxRedirects) throw new Error(`more than ${maxRedirects} redirects`);
      let next: string;
      try {
        next = new URL(location, url).href;
      } catch {
        throw new UnsafeUrlError("redirect to an invalid URL");
      }
      url = parsePublicHttpsUrl(next);
      redirects.push(url.href);
      continue;
    }

    const truncated = response.truncated || response.body.length > maxBytes;
    return {
      url: url.href,
      status: response.status,
      contentType: response.headers["content-type"] ?? null,
      body: response.body.length > maxBytes ? response.body.subarray(0, maxBytes) : response.body,
      truncated,
      redirects,
    };
  }
}
