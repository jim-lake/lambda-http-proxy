import http from 'node:http';
import https from 'node:https';
import { Buffer } from 'node:buffer';
import type { IncomingHttpHeaders } from 'node:http';
import type { Writable } from 'node:stream';

export interface FunctionUrlEvent {
  version: '2.0';
  rawPath?: string;
  rawQueryString?: string;
  cookies?: string[];
  headers?: Record<string, string>;
  body?: string;
  isBase64Encoded?: boolean;
  requestContext?: {
    http?: {
      method?: string;
      path?: string;
      protocol?: string;
      sourceIp?: string;
      userAgent?: string;
    };
  };
}

export interface LambdaContext {
  awsRequestId: string;
  getRemainingTimeInMillis(): number;
}

export interface ResponseMetadata {
  statusCode: number;
  headers: Record<string, string | string[] | number | undefined>;
}

export interface ResponseStream extends Writable {
  /*
   * Optional annotation used only by the non-runtime fallback so a plain-node
   * harness can read the status/headers without re-parsing the prelude. The
   * real runtime never sets this — it maps the prelude to real HTTP metadata.
   */
  __meta?: ResponseMetadata;
  __preludeWritten?: boolean;
  setResponseMeta?(meta: ResponseMetadata): void;
}

/*
 * Eight NUL bytes separate the JSON metadata prelude from the response body on
 * the response-streaming wire. This matches the AWS runtime exactly:
 * HttpResponseStream.from writes the prelude, then 8 NUL bytes, then the body.
 * A real Function URL in RESPONSE_STREAM mode consumes this prelude at the edge
 * and turns it into the real HTTP status line + headers, so the caller sees a
 * clean response whose BODY is byte-for-byte the upstream body.
 */
const PRELUDE_DELIMITER = Buffer.alloc(8);

/* A zero-length chunk used to trigger the runtime's lazy prelude emission. */
const EMPTY_CHUNK = Buffer.alloc(0);

export interface AwsLambdaGlobal {
  streamifyResponse(
    handler: (
      event: FunctionUrlEvent,
      responseStream: ResponseStream,
      context: LambdaContext
    ) => Promise<void>
  ): (
    event: FunctionUrlEvent,
    responseStream: ResponseStream,
    context: LambdaContext
  ) => Promise<void>;
  HttpResponseStream: {
    from(stream: ResponseStream, metadata: ResponseMetadata): ResponseStream;
  };
}

declare global {
  var awslambda: AwsLambdaGlobal | undefined;
}

const HOP_BY_HOP = new Set<string>([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const LAMBDA_INJECTED_PREFIXES = ['x-forwarded-', 'cloudfront-'];
const LAMBDA_INJECTED_EXACT = new Set<string>([
  'x-amzn-trace-id',
  'x-amz-cf-id',
  'via',
]);

interface Target {
  targetHost: string;
  signedHost: string;
  scheme: string;
}

interface ParsedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: Buffer;
}

interface RequestEnvelope {
  __proxyEnvelope: true;
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  bodyIsBase64?: boolean;
}

function resolveTarget(headers: Record<string, string>): Target {
  const signedHost = headers.host;
  if (!signedHost) {
    throw new Error(
      'No Host header on the signed request; cannot determine upstream target'
    );
  }
  const scheme = (process.env.PROXY_TARGET_SCHEME ?? 'https').toLowerCase();
  return { targetHost: signedHost, signedHost, scheme };
}

function parseEvent(event: FunctionUrlEvent): ParsedRequest {
  const method = event.requestContext?.http?.method ?? 'GET';

  const eventHeaders: Record<string, string> = { ...(event.headers ?? {}) };
  if (Array.isArray(event.cookies) && event.cookies.length > 0) {
    eventHeaders.cookie = event.cookies.join('; ');
  }

  let rawBody: Buffer | undefined;
  if (event.body !== undefined) {
    rawBody = event.isBase64Encoded
      ? Buffer.from(event.body, 'base64')
      : Buffer.from(event.body, 'utf8');
  }

  const envelope = tryParseEnvelope(rawBody);
  if (envelope) {
    /*
     * Envelope carries the real signed request end-to-end: path, method,
     * headers, and body. The Function URL event's own headers describe only
     * the outer JSON POST hop and are ignored here.
     */
    const body =
      envelope.body === undefined
        ? undefined
        : envelope.bodyIsBase64
          ? Buffer.from(envelope.body, 'base64')
          : Buffer.from(envelope.body, 'utf8');
    return {
      method: envelope.method ?? method,
      path: envelope.path,
      headers: { ...(envelope.headers ?? {}) },
      body,
    };
  }

  const rawPath = event.rawPath ?? '/';
  const rawQuery = event.rawQueryString ? `?${event.rawQueryString}` : '';
  return {
    method,
    path: `${rawPath}${rawQuery}`,
    headers: eventHeaders,
    body: rawBody,
  };
}

function tryParseEnvelope(
  rawBody: Buffer | undefined
): RequestEnvelope | undefined {
  if (!rawBody || rawBody.length === 0) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return undefined;
  }
  if (
    parsed &&
    typeof parsed === 'object' &&
    (parsed as Record<string, unknown>).__proxyEnvelope === true &&
    typeof (parsed as Record<string, unknown>).path === 'string'
  ) {
    return parsed as RequestEnvelope;
  }
  return undefined;
}

function isStrippableRequestHeader(lower: string): boolean {
  return (
    HOP_BY_HOP.has(lower) ||
    LAMBDA_INJECTED_EXACT.has(lower) ||
    LAMBDA_INJECTED_PREFIXES.some((p) => lower.startsWith(p))
  );
}

function buildUpstreamHeaders(
  headers: Record<string, string>,
  { signedHost }: Target
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!isStrippableRequestHeader(name.toLowerCase())) {
      out[name] = value;
    }
  }
  out.host = signedHost;
  return out;
}

function filterResponseHeaders(
  headers: IncomingHttpHeaders
): Record<string, string | string[] | number | undefined> {
  const out: Record<string, string | string[] | number | undefined> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP.has(name.toLowerCase())) {
      out[name] = value;
    }
  }
  return out;
}

function applyResponseMetadata(
  responseStream: ResponseStream,
  meta: ResponseMetadata
): ResponseStream {
  if (globalThis.awslambda?.HttpResponseStream.from) {
    return globalThis.awslambda.HttpResponseStream.from(responseStream, meta);
  }
  /*
   * Non-runtime fallback. Reproduce the real response-streaming wire format so
   * a plain-node harness receives exactly what a deployed Function URL emits:
   * the JSON metadata prelude, eight NUL bytes, then the raw upstream body. The
   * harness parses the prelude back into status + headers and exposes the body
   * untouched — making the proxy output indistinguishable from the upstream.
   *
   * We also annotate __meta/setResponseMeta so simpler consumers can read the
   * metadata without parsing the prelude.
   */
  /* eslint-disable no-param-reassign */
  responseStream.__meta = meta;
  if (typeof responseStream.setResponseMeta === 'function') {
    responseStream.setResponseMeta(meta);
  }
  if (responseStream.__preludeWritten !== true) {
    responseStream.__preludeWritten = true;
    responseStream.write(Buffer.from(JSON.stringify(meta), 'utf8'));
    responseStream.write(PRELUDE_DELIMITER);
  }
  /* eslint-enable no-param-reassign */
  return responseStream;
}

/*
 * Ensure the metadata prelude is emitted even when no body bytes follow.
 *
 * On the real runtime, HttpResponseStream.from writes the prelude lazily on the
 * first write/end. An empty-body upstream response (notably HEAD, e.g.
 * HeadObject) produces zero body writes, which risks the response ending with
 * the prelude never flushed — the edge would then build an HTTP response
 * missing the upstream headers (e.g. Content-Length). Writing a zero-length
 * chunk triggers the runtime's first-write hook so the prelude (status +
 * headers) is sent, while contributing zero body bytes — the output stays
 * byte-for-byte identical to the upstream.
 *
 * In the non-runtime fallback the prelude is already written eagerly by
 * applyResponseMetadata, so this is a harmless no-op there.
 */
function flushResponsePrelude(responseStream: ResponseStream): void {
  if (responseStream.__preludeWritten === true) {
    return;
  }
  responseStream.write(EMPTY_CHUNK);
}

interface ForwardArgs {
  method: string;
  path: string;
  upstreamHeaders: Record<string, string>;
  body?: Buffer;
  targetHost: string;
  scheme: string;
}

async function forwardAndStream(
  args: ForwardArgs,
  responseStream: ResponseStream
): Promise<void> {
  const { method, path, upstreamHeaders, body, targetHost, scheme } = args;
  return new Promise<void>((resolve, reject) => {
    const client = scheme === 'http' ? http : https;

    const [hostname, portStr] = targetHost.split(':');
    const port = portStr ? Number(portStr) : scheme === 'http' ? 80 : 443;

    const req = client.request(
      {
        hostname,
        port,
        method,
        path,
        headers: upstreamHeaders,
        servername: hostname,
      },
      (upstream) => {
        const meta: ResponseMetadata = {
          statusCode: upstream.statusCode ?? 502,
          headers: filterResponseHeaders(upstream.headers),
        };
        const stream = applyResponseMetadata(responseStream, meta);

        /*
         * Force the metadata prelude (status + headers) to be emitted now,
         * before any body byte. The real runtime's HttpResponseStream.from
         * writes the prelude lazily on the first write/end; a HEAD (or any
         * empty-body) response produces zero body writes, so without this an
         * empty-body response could end before the prelude — and the edge would
         * build a response with no headers (e.g. a missing Content-Length on
         * HeadObject). Writing an empty chunk triggers the prelude immediately
         * and streams zero body bytes, matching the upstream exactly.
         */
        flushResponsePrelude(stream);

        upstream.on('error', reject);
        stream.on('error', reject);
        upstream.on('end', resolve);
        upstream.pipe(stream);
      }
    );

    req.on('error', reject);
    if (body && body.length > 0) {
      req.write(body);
    }
    req.end();
  });
}

export async function proxy(
  event: FunctionUrlEvent,
  responseStream: ResponseStream
): Promise<void> {
  const { method, path, headers, body } = parseEvent(event);
  const target = resolveTarget(headers);
  const upstreamHeaders = buildUpstreamHeaders(headers, target);

  await forwardAndStream(
    {
      method,
      path,
      upstreamHeaders,
      body,
      targetHost: target.targetHost,
      scheme: target.scheme,
    },
    responseStream
  );
}

type ProxyFn = (
  event: FunctionUrlEvent,
  responseStream: ResponseStream,
  context: LambdaContext
) => Promise<void>;

function streamify(fn: ProxyFn): ProxyFn {
  const runtime = globalThis.awslambda;
  if (typeof runtime?.streamifyResponse === 'function') {
    return runtime.streamifyResponse(fn);
  }
  return fn;
}

export const handler = streamify(
  async (
    event: FunctionUrlEvent,
    responseStream: ResponseStream,
    _context: LambdaContext
  ) => {
    try {
      await proxy(event, responseStream);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      try {
        const stream = applyResponseMetadata(responseStream, {
          statusCode: 502,
          headers: { 'content-type': 'text/plain' },
        });
        if (!stream.writableEnded) {
          stream.write(`proxy error: ${message}`);
        }
      } catch {
        /* noop */
      } finally {
        if (!responseStream.writableEnded) {
          responseStream.end();
        }
      }
      return;
    }
    if (!responseStream.writableEnded) {
      responseStream.end();
    }
  }
);
