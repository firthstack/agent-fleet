import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Bridges node:http to the fetch-style handler Better Auth exposes.
 *
 * The subtle part is `set-cookie`. A sign-in response carries more than one,
 * and `Headers.get("set-cookie")` folds them into a single comma-joined
 * string — which browsers then parse as one malformed cookie, so the session
 * silently never lands. `getSetCookie()` is the only correct reader.
 */

export interface BridgeOptions {
  /** Hard ceiling on the request body. */
  maxBodyBytes?: number;
  /** Origin used to build the absolute URL a Request requires. */
  origin: string;
}

const DEFAULT_MAX_BODY = 1024 * 1024;

export class BodyTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`request body exceeds ${maxBytes} bytes`);
    this.name = "BodyTooLargeError";
  }
}

export async function readBodyBuffer(
  req: IncomingMessage,
  maxBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) throw new BodyTooLargeError(maxBytes);
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

export async function toFetchRequest(
  req: IncomingMessage,
  opts: BridgeOptions,
): Promise<Request> {
  const url = new URL(req.url ?? "/", opts.origin);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else {
      headers.set(key, value);
    }
  }

  const method = req.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  const body = hasBody
    ? await readBodyBuffer(req, opts.maxBodyBytes ?? DEFAULT_MAX_BODY)
    : undefined;

  return new Request(url, {
    method,
    headers,
    ...(body && body.length > 0 ? { body: new Uint8Array(body) } : {}),
  });
}

export async function writeFetchResponse(
  res: ServerResponse,
  response: Response,
): Promise<void> {
  res.statusCode = response.status;

  for (const [key, value] of response.headers) {
    // Handled separately below — folding these together breaks sign-in.
    if (key.toLowerCase() === "set-cookie") continue;
    res.setHeader(key, value);
  }
  const cookies = response.headers.getSetCookie?.() ?? [];
  if (cookies.length > 0) res.setHeader("set-cookie", cookies);

  const buffer = Buffer.from(await response.arrayBuffer());
  res.end(buffer);
}
