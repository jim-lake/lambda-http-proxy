import { Buffer } from 'node:buffer';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import type { AwsCredentialIdentity, Provider } from '@smithy/types';
import { ProxyRequestHandler } from './proxy-request-handler.js';

declare const __BUILD_VERSION__: string;
export const BUILD_VERSION: string = __BUILD_VERSION__;

export interface FetchProxyOptions {
  proxyUrl: string;
  region?: string;
  credentials?: AwsCredentialIdentity | Provider<AwsCredentialIdentity>;
}

export type Fetch = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

// @types/node exposes the WHATWG globals but not the HeadersInit alias.
type HeadersInitLike =
  | Headers
  | readonly (readonly [string, string])[]
  | Record<string, string | undefined>;

interface HandlerResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: IncomingMessage;
}

const NULL_BODY_STATUS = new Set<number>([101, 204, 205, 304]);

export class FetchProxy {
  private readonly handler: ProxyRequestHandler;

  constructor(opts: FetchProxyOptions) {
    if (!opts.proxyUrl) {
      throw new Error('FetchProxy requires a proxyUrl');
    }
    this.handler = new ProxyRequestHandler({
      proxyUrl: opts.proxyUrl,
      region: opts.region,
      credentials: opts.credentials,
    });
    // SDKs assign and call `fetch` unbound, like the global.
    this.fetch = this.fetch.bind(this);
  }

  async fetch(
    input: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> {
    const req = await normalizeRequest(input, init);

    if (req.signal?.aborted) {
      throw abortError(req.signal);
    }

    const url = new URL(req.url);
    /*
     * Pass the full signed path+query as `path`; leave `query` unset so the
     * handler does not re-encode the already-encoded search string.
     */
    const path = `${url.pathname}${url.search}`;

    const handlePromise = this.handler.handle({
      method: req.method,
      path,
      headers: req.headers,
      body: req.body,
    }) as Promise<{ response: HandlerResponse }>;

    const { response } = await withAbort(handlePromise, req.signal);

    const nodeBody = response.body;
    const bodyless =
      req.method.toUpperCase() === 'HEAD' ||
      NULL_BODY_STATUS.has(response.statusCode) ||
      response.headers['content-length'] === '0';

    if (bodyless) {
      nodeBody.resume();
      return buildResponse(null, response);
    }

    if (req.signal) {
      forwardAbortToStream(req.signal, nodeBody);
    }

    const webStream = Readable.toWeb(nodeBody) as ReadableStream<Uint8Array>;
    return buildResponse(webStream, response);
  }
}

interface NormalizedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: Buffer;
  signal?: AbortSignal;
}

async function normalizeRequest(
  input: string | URL | Request,
  init?: RequestInit
): Promise<NormalizedRequest> {
  const src: Request | undefined =
    typeof input === 'object' &&
    !(input instanceof URL) &&
    typeof input.url === 'string'
      ? input
      : undefined;

  let url: string;
  if (src) {
    url = src.url;
  } else if (input instanceof URL) {
    url = input.href;
  } else {
    url = input as string;
  }

  const method = init?.method ?? src?.method ?? 'GET';

  let headers: Record<string, string> = {};
  if (src) {
    headers = mergeHeaders(headers, src.headers);
  }
  if (init?.headers !== undefined) {
    headers = mergeHeaders(headers, init.headers);
  }

  const body = await readBody(init, src);

  const signal = init?.signal ?? src?.signal ?? undefined;

  /*
   * The proxy keys the upstream target off the inner request's Host header;
   * fill it from the URL when the caller did not already sign one in.
   */
  if (!hasHeader(headers, 'host')) {
    headers = { ...headers, host: new URL(url).host };
  }

  return { method, url, headers, body, signal: signal ?? undefined };
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const lower = name.toLowerCase();
  return Object.keys(headers).some((k) => k.toLowerCase() === lower);
}

function mergeHeaders(
  base: Record<string, string>,
  headers: HeadersInitLike
): Record<string, string> {
  const out: Record<string, string> = { ...base };

  if (typeof (headers as Headers).forEach === 'function') {
    (headers as Headers).forEach((value, key) => {
      assignHeader(out, key, value);
    });
    return out;
  }
  if (Array.isArray(headers)) {
    const pairs = headers as readonly (readonly [string, string])[];
    for (const [key, value] of pairs) {
      assignHeader(out, key, value);
    }
    return out;
  }
  const record = headers as Record<string, string | undefined>;
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) {
      assignHeader(out, key, value);
    }
  }
  return out;
}

function assignHeader(
  out: Record<string, string>,
  key: string,
  value: string
): void {
  const existing = Object.keys(out).find(
    (k) => k.toLowerCase() === key.toLowerCase()
  );
  if (existing !== undefined && existing !== key) {
    Reflect.deleteProperty(out, existing);
  }
  // eslint-disable-next-line no-param-reassign
  out[key] = value;
}

async function readBody(
  init: RequestInit | undefined,
  src: Request | undefined
): Promise<Buffer | undefined> {
  if (init && 'body' in init && init.body !== null && init.body !== undefined) {
    return bodyToBuffer(init.body);
  }
  if (src?.body !== null && src?.body !== undefined) {
    const buf = Buffer.from(await src.arrayBuffer());
    return buf.length > 0 ? buf : undefined;
  }
  return undefined;
}

function bodyToBuffer(body: unknown): Buffer {
  if (typeof body === 'string') {
    return Buffer.from(body, 'utf8');
  }
  if (body instanceof Uint8Array) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  }
  if (body instanceof ArrayBuffer) {
    return Buffer.from(body);
  }
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  }
  throw new TypeError(
    'FetchProxy: unsupported request body type; expected string, ArrayBuffer, or a typed-array view'
  );
}

function buildResponse(
  body: ReadableStream<Uint8Array> | null,
  response: HandlerResponse
): Response {
  const headers = new Headers();
  for (const [key, value] of Object.entries(response.headers)) {
    headers.set(key, value);
  }
  return new Response(body, { status: response.statusCode, headers });
}

async function withAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined
): Promise<T> {
  if (!signal) {
    return promise;
  }
  const activeSignal = signal;
  return new Promise<T>((resolve, reject) => {
    function onAbort(): void {
      reject(abortError(activeSignal));
    }
    activeSignal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        activeSignal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        activeSignal.removeEventListener('abort', onAbort);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    );
  });
}

function forwardAbortToStream(
  signal: AbortSignal,
  stream: IncomingMessage
): void {
  if (signal.aborted) {
    stream.destroy(abortError(signal));
    return;
  }
  signal.addEventListener(
    'abort',
    () => {
      stream.destroy(abortError(signal));
    },
    { once: true }
  );
}

function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) {
    return reason;
  }
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  return err;
}
