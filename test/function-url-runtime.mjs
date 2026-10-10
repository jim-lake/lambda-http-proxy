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

const PRELUDE_DELIMITER = Buffer.alloc(8);

/*
 * Install a faithful `globalThis.awslambda` shim. This mirrors the real
 * runtime: `streamifyResponse` returns the handler unchanged (the runtime just
 * tracks it), and `HttpResponseStream.from` writes the prelude + 8 NUL bytes
 * before the first body byte. Importing the proxy AFTER this is installed makes
 * it take the real-runtime output path, not the fallback.
 */
export function installAwslambdaShim() {
  globalThis.awslambda = {
    streamifyResponse(handler) {
      return handler;
    },
    HttpResponseStream: {
      from(underlyingStream, metadata) {
        let wrotePrelude = false;
        const originalWrite = underlyingStream.write.bind(underlyingStream);
        // Patch write so the prelude is emitted lazily on the first body write,
        // exactly like the runtime's _onBeforeFirstWrite hook.
        underlyingStream.write = (chunk, encoding, callback) => {
          if (!wrotePrelude) {
            wrotePrelude = true;
            originalWrite(Buffer.from(JSON.stringify(metadata), 'utf8'));
            originalWrite(PRELUDE_DELIMITER);
          }
          return originalWrite(chunk, encoding, callback);
        };
        const originalEnd = underlyingStream.end.bind(underlyingStream);
        underlyingStream.end = (chunk, encoding, callback) => {
          if (!wrotePrelude) {
            wrotePrelude = true;
            originalWrite(Buffer.from(JSON.stringify(metadata), 'utf8'));
            originalWrite(PRELUDE_DELIMITER);
          }
          return originalEnd(chunk, encoding, callback);
        };
        return underlyingStream;
      },
    },
  };
  return globalThis.awslambda;
}

/*
 * Load the built proxy handler against the installed shim. Importing the proxy
 * sets no globals of its own; it simply reads `globalThis.awslambda`.
 */
export async function loadHandler() {
  installAwslambdaShim();
  const mod = await import('../dist/lambda-http-proxy.mjs');
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
export async function invokeFunctionUrl(event, { handler } = {}) {
  const fn = handler ?? (await loadHandler());

  // The raw stream the runtime hands the handler. We collect its bytes and
  // then de-prelude them, surfacing the body incrementally as it arrives.
  const rawStream = new PassThrough();
  const out = new PassThrough();

  let headerParsed = false;
  let buffered = Buffer.alloc(0);
  let resolveMeta;
  const metaReady = new Promise((r) => (resolveMeta = r));
  let statusCode = 200;
  let headers = {};

  rawStream.on('data', (chunk) => {
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
      const meta = JSON.parse(buffered.subarray(0, idx).toString('utf8'));
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
  rawStream.on('error', (e) => out.destroy(e));

  const context = {
    awsRequestId: 'local-' + Math.random().toString(16).slice(2),
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
  run.catch((e) => out.destroy(e));

  return { statusCode, headers, body: out };
}

function flattenHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) {
      continue;
    }
    out[k] = Array.isArray(v) ? v.join(', ') : String(v);
  }
  return out;
}

/* Convenience: collect a Readable to a Buffer. */
export async function collect(stream) {
  const chunks = [];
  for await (const c of stream) {
    chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  }
  return Buffer.concat(chunks);
}

/* Convenience: build a Function URL event that carries a proxy envelope. */
export function makeEnvelopeEvent({ path, method, headers, body }) {
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
    routeKey: '$default',
    rawPath: '/',
    rawQueryString: '',
    headers: { 'content-type': 'application/json' },
    requestContext: { http: { method: 'POST', path: '/' } },
    body: JSON.stringify(envelope),
    isBase64Encoded: false,
  };
}

/*
 * An AWS SDK v3 `requestHandler` that routes an already-signed request through
 * the proxy running in this plain-node Function URL emulation, then on to real
 * AWS. The SDK signs the request; this handler wraps it in the proxy envelope,
 * invokes the proxy handler via `invokeFunctionUrl` (which forwards the signed
 * request verbatim to the real host over HTTPS and streams the raw response
 * back), and returns the response to the SDK.
 *
 * This is the end-to-end proof that SigV4 survives the proxy hop: a
 * SignatureDoesNotMatch means the proxy mangled the request; a valid response
 * (or a post-verification error like AccessDenied/NoSuchKey) means it survived.
 * Because the body is streamed back raw, binary event-stream responses
 * (Bedrock) arrive intact — there is no buffering emulator in the path.
 */
export class ProxyFunctionUrlRequestHandler {
  constructor({ handler } = {}) {
    this.handler = handler;
  }

  async handle(request) {
    const { HttpResponse } = await import('@smithy/protocol-http');
    if (!this.handler) {
      this.handler = await loadHandler();
    }

    const signedPath =
      request.path + (request.query ? toQuery(request.query) : '');
    const signedBody = await collectBody(request.body);

    const event = makeEnvelopeEvent({
      path: signedPath,
      method: request.method,
      headers: { ...request.headers },
      body: signedBody,
    });

    const { statusCode, headers, body } = await invokeFunctionUrl(event, {
      handler: this.handler,
    });

    return { response: new HttpResponse({ statusCode, headers, body }) };
  }
}

function toQuery(query) {
  const parts = [];
  for (const [k, v] of Object.entries(query)) {
    if (v == null) {
      parts.push(encodeURIComponent(k));
    } else if (Array.isArray(v)) {
      for (const item of v) {
        parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(item)}`);
      }
    } else {
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
    }
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

async function collectBody(body) {
  if (!body) {
    return undefined;
  }
  if (typeof body === 'string' || Buffer.isBuffer(body)) {
    return body;
  }
  const chunks = [];
  for await (const c of body) {
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

export { Readable };
