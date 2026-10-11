/*
 * A plain-Node emulation of a Lambda Function URL running in RESPONSE_STREAM
 * (`InvokeMode: RESPONSE_STREAM`) mode. No SAM, RIE, LocalStack, or Docker.
 *
 * The point of this helper is to exercise the proxy's OUTPUT contract exactly
 * as a deployed Function URL would, and prove the result is INDISTINGUISHABLE
 * from the raw upstream response: same status, same headers, same body bytes,
 * delivered incrementally.
 *
 * How the real runtime works (and what we reproduce here):
 *
 *   1. The runtime wraps the handler with `awslambda.streamifyResponse`.
 *   2. The handler calls `awslambda.HttpResponseStream.from(stream, meta)` to
 *      attach status + headers. Under the hood that writes, on first write:
 *        <JSON metadata prelude> + <8 NUL bytes> + <body…>
 *      (confirmed against the aws-lambda-nodejs-runtime-interface-client).
 *   3. On a real Function URL the AWS edge CONSUMES that prelude and turns it
 *      into the real HTTP status line + response headers, streaming only the
 *      body to the HTTP caller. So the caller sees a clean HTTP response whose
 *      body is byte-for-byte the upstream body.
 *
 * `invokeFunctionUrl(event)` below plays the role of that edge: it runs the
 * handler against a shimmed `awslambda`, parses the prelude back out, and hands
 * you `{ statusCode, headers, body }` where `body` is a Readable you can pipe
 * straight downstream — identical to calling the upstream service directly.
 */
import { PassThrough, Readable } from 'node:stream';
import { Buffer } from 'node:buffer';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type {
  AwsLambdaGlobal,
  FunctionUrlEvent,
  LambdaContext,
  ResponseMetadata,
  ResponseStream,
} from '../dist/lambda-outbound-proxy.mjs';

type ProxyHandler = (
  event: FunctionUrlEvent,
  responseStream: ResponseStream,
  context: LambdaContext
) => Promise<void>;

type HeaderValue = string | string[] | number | undefined;

export interface InvokeResult {
  statusCode: number;
  headers: Record<string, string>;
  body: PassThrough;
}

interface EnvelopeInput {
  path: string;
  method: string;
  headers: Record<string, string>;
  body?: string | Buffer;
}

const PRELUDE_DELIMITER = Buffer.alloc(8);

/*
 * Install a faithful `globalThis.awslambda` shim. This mirrors the real
 * runtime: `streamifyResponse` returns the handler unchanged (the runtime just
 * tracks it), and `HttpResponseStream.from` writes the prelude + 8 NUL bytes
 * before the first body byte. Importing the proxy AFTER this is installed makes
 * it take the real-runtime output path, not the fallback.
 */
export function installAwslambdaShim(): AwsLambdaGlobal {
  const shim: AwsLambdaGlobal = {
    streamifyResponse(handler) {
      return handler;
    },
    HttpResponseStream: {
      from(underlyingStream: ResponseStream, metadata: ResponseMetadata) {
        let wrotePrelude = false;
        const originalWrite = underlyingStream.write.bind(underlyingStream);
        const writePrelude = (): void => {
          if (wrotePrelude) {
            return;
          }
          wrotePrelude = true;
          originalWrite(Buffer.from(JSON.stringify(metadata), 'utf8'));
          originalWrite(PRELUDE_DELIMITER);
        };
        // Patch write so the prelude is emitted lazily on the first body write,
        // exactly like the runtime's _onBeforeFirstWrite hook.
        underlyingStream.write = ((
          chunk: unknown,
          encoding?: unknown,
          callback?: unknown
        ) => {
          writePrelude();
          return (originalWrite as (...args: unknown[]) => boolean)(
            chunk,
            encoding,
            callback
          );
        }) as ResponseStream['write'];
        const originalEnd = underlyingStream.end.bind(underlyingStream);
        underlyingStream.end = ((
          chunk?: unknown,
          encoding?: unknown,
          callback?: unknown
        ) => {
          writePrelude();
          return (originalEnd as (...args: unknown[]) => ResponseStream)(
            chunk,
            encoding,
            callback
          );
        }) as ResponseStream['end'];
        return underlyingStream;
      },
    },
  };
  globalThis.awslambda = shim;
  return shim;
}

/*
 * Load the built proxy handler against the installed shim. Importing the proxy
 * sets no globals of its own; it simply reads `globalThis.awslambda`.
 */
export async function loadHandler(): Promise<ProxyHandler> {
  installAwslambdaShim();
  const mod = await import('../dist/lambda-outbound-proxy.mjs');
  return mod.handler;
}

/*
 * Invoke the handler with a Function URL (v2) event and return a parsed,
 * raw-equivalent response. This is the edge: it strips the metadata prelude and
 * surfaces the status + headers and a body stream that is byte-for-byte the
 * upstream body — exactly what a consumer of a deployed RESPONSE_STREAM
 * Function URL receives.
 *
 * Returns: { statusCode, headers, body } where `body` is a Readable.
 */
export async function invokeFunctionUrl(
  event: FunctionUrlEvent,
  { handler }: { handler?: ProxyHandler } = {}
): Promise<InvokeResult> {
  const fn = handler ?? (await loadHandler());

  // The raw stream the runtime hands the handler. We collect its bytes and
  // then de-prelude them, surfacing the body incrementally as it arrives.
  const rawStream = new PassThrough() as PassThrough & ResponseStream;
  const out = new PassThrough();

  let headerParsed = false;
  let buffered = Buffer.alloc(0);
  let resolveMeta: () => void = () => undefined;
  const metaReady = new Promise<void>((r) => {
    resolveMeta = r;
  });
  let statusCode = 200;
  let headers: Record<string, string> = {};

  rawStream.on('data', (chunk: Buffer) => {
    if (headerParsed) {
      out.write(chunk);
      return;
    }
    buffered = Buffer.concat([buffered, chunk]);
    const idx = buffered.indexOf(PRELUDE_DELIMITER);
    if (idx === -1) {
      return; // prelude not complete yet
    }
    try {
      const meta = JSON.parse(
        buffered.subarray(0, idx).toString('utf8')
      ) as Partial<ResponseMetadata>;
      statusCode = meta.statusCode ?? 200;
      headers = flattenHeaders(meta.headers ?? {});
    } catch {
      statusCode = 200;
      headers = {};
    }
    headerParsed = true;
    resolveMeta();
    const rest = buffered.subarray(idx + PRELUDE_DELIMITER.length);
    buffered = Buffer.alloc(0);
    if (rest.length > 0) {
      out.write(rest);
    }
  });

  rawStream.on('end', () => {
    if (!headerParsed) {
      // No prelude was ever written (e.g. empty response). Treat whatever was
      // buffered as the body with a default 200.
      resolveMeta();
      if (buffered.length > 0) {
        out.write(buffered);
      }
    }
    out.end();
  });
  rawStream.on('error', (e: Error) => out.destroy(e));

  const context: LambdaContext = {
    awsRequestId: `local-${Math.random().toString(16).slice(2)}`,
    getRemainingTimeInMillis: () => 900_000,
  };

  // Kick off the handler; it writes into rawStream.
  const run = Promise.resolve(fn(event, rawStream, context)).then(() => {
    if (!rawStream.writableEnded) {
      rawStream.end();
    }
  });

  await metaReady;
  // Surface the run's rejection on the body stream if the handler throws.
  run.catch((e: unknown) =>
    out.destroy(e instanceof Error ? e : new Error(String(e)))
  );

  return { statusCode, headers, body: out };
}

function flattenHeaders(
  headers: Record<string, HeaderValue>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) {
      continue;
    }
    out[k] = Array.isArray(v) ? v.join(', ') : String(v);
  }
  return out;
}

/* Convenience: collect a Readable to a Buffer. */
export async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) {
    chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as string));
  }
  return Buffer.concat(chunks);
}

/* Convenience: build a Function URL event that carries a proxy envelope. */
export function makeEnvelopeEvent({
  path,
  method,
  headers,
  body,
}: EnvelopeInput): FunctionUrlEvent {
  const envelope = {
    __proxyEnvelope: true,
    path,
    method,
    headers,
    body: body ? Buffer.from(body).toString('base64') : undefined,
    bodyIsBase64: true,
  };
  return {
    version: '2.0',
    rawPath: '/',
    rawQueryString: '',
    headers: { 'content-type': 'application/json' },
    requestContext: { http: { method: 'POST', path: '/' } },
    body: JSON.stringify(envelope),
    isBase64Encoded: false,
  };
}

export interface LocalProxyServer {
  server: http.Server;
  url: string;
  close: () => Promise<void>;
}

/*
 * Stand up a REAL local HTTP server that behaves like a deployed Function URL
 * in RESPONSE_STREAM mode — but over plain http. It receives the outer POST
 * (SigV4-signed by ProxyRequestHandler; the signature is accepted as-is since
 * there is no IAM in front of a local socket), reads the JSON envelope, runs
 * the proxy handler through `invokeFunctionUrl`, and — exactly as the AWS edge
 * does — strips the metadata prelude and writes the raw upstream status,
 * headers, and body back to the caller.
 *
 * The published `ProxyRequestHandler` then talks to this server over http the
 * same way it talks to a deployed Function URL over https. One code path, both
 * targets.
 */
export async function startLocalProxyServer(): Promise<LocalProxyServer> {
  const handler = await loadHandler();

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      void (async () => {
        try {
          const raw = Buffer.concat(chunks).toString('utf8');
          const event: FunctionUrlEvent = {
            version: '2.0',
            rawPath: '/',
            rawQueryString: '',
            headers: { 'content-type': 'application/json' },
            requestContext: { http: { method: 'POST', path: '/' } },
            body: raw,
            isBase64Encoded: false,
          };

          const { statusCode, headers, body } = await invokeFunctionUrl(event, {
            handler,
          });
          /*
           * Emulate the real RESPONSE_STREAM edge: it does NOT echo a
           * `content-length` for a streamed body (that is exactly why the proxy
           * smuggles the true value under `x-lambda-proxy-remap-content-length`).
           * Let Node frame the response itself; forwarding a stale
           * content-length here would make the HTTP client wait for bytes that
           * never come and reset the socket. Hop-by-hop headers are dropped too.
           */
          const edgeHeaders: Record<string, string> = {};
          for (const [k, v] of Object.entries(headers)) {
            const lower = k.toLowerCase();
            if (
              lower === 'content-length' ||
              lower === 'connection' ||
              lower === 'transfer-encoding' ||
              lower === 'keep-alive'
            ) {
              continue;
            }
            edgeHeaders[k] = v;
          }
          res.writeHead(statusCode, edgeHeaders);
          body.pipe(res);
          body.on('error', () => res.destroy());
        } catch (e) {
          res.statusCode = 502;
          res.end(e instanceof Error ? e.message : String(e));
        }
      })();
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  // Don't keep the test process alive for an idle local proxy socket.
  server.unref();
  const { port } = server.address() as AddressInfo;

  return {
    server,
    url: `http://127.0.0.1:${port}/`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        // Keep-alive sockets from the handler's http agent would otherwise keep
        // server.close()'s callback pending forever. Force them shut.
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

export { Readable };
