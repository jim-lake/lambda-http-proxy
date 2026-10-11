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
import https from 'node:https';
import type { IncomingMessage } from 'node:http';
import type {
  AwsLambdaGlobal,
  FunctionUrlEvent,
  LambdaContext,
  ResponseMetadata,
  ResponseStream,
} from '../dist/lambda-outbound-proxy.mjs';
import { reassembleHeaders } from '../dist/proxy-request-handler.mjs';

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

/*
 * The subset of a signed SDK request we read. We keep this loose on purpose:
 * the SDK's HttpRequest shape is what flows in, and we only touch these fields.
 */
interface SignedRequest {
  method: string;
  path: string;
  query?: Record<string, string | string[] | null | undefined>;
  headers: Record<string, string>;
  body?: unknown;
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
  private handler?: ProxyHandler;

  constructor({ handler }: { handler?: ProxyHandler } = {}) {
    this.handler = handler;
  }

  async handle(request: SignedRequest): Promise<{ response: unknown }> {
    const { HttpResponse } = await import('@smithy/protocol-http');
    this.handler ??= await loadHandler();

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

    // Reassemble the true upstream headers from the proxy's side channel —
    // exactly as the published ProxyRequestHandler does. The body is already
    // genuinely empty for body-less responses (the proxy flushes the prelude
    // with a zero-length write, not a sentinel byte).
    return {
      response: new HttpResponse({
        statusCode,
        headers: reassembleHeaders(headers),
        body,
      }),
    };
  }
}

interface AwsCredentialsLike {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

interface HttpsHandlerOptions {
  functionUrl?: string;
  region?: string;
  service?: string;
  credentials?: AwsCredentialsLike | (() => Promise<AwsCredentialsLike>);
}

/*
 * An AWS SDK v3 `requestHandler` that routes an already-signed request through
 * a LIVE deployed Function URL (RESPONSE_STREAM, AuthType: AWS_IAM) over real
 * HTTPS — the same code path as the published ProxyRequestHandler, but with the
 * outer POST SigV4-signed so it authenticates against the IAM-protected URL.
 *
 * Two independent SigV4 signatures are in play, and they must not be confused:
 *   - INNER: the SDK already signed the request for its target service (S3,
 *     Bedrock, …). That signature rides inside the envelope untouched.
 *   - OUTER: this handler signs the POST to the Function URL for service
 *     `lambda` in the URL's region, so the Function URL's IAM auth accepts it.
 *
 * The deployed Function URL in RESPONSE_STREAM mode has the AWS edge strip the
 * metadata prelude, so the HTTPS response body we receive is already the raw
 * upstream body (byte-for-byte) — we hand it straight to the SDK as a stream.
 */
export class ProxyFunctionUrlHttpsRequestHandler {
  private readonly host: string;
  private readonly port: number;
  private readonly basePath: string;
  private readonly region?: string;
  private readonly service: string;
  private readonly credentials?: HttpsHandlerOptions['credentials'];
  private signer: unknown = null;

  constructor({
    functionUrl,
    region,
    service = 'lambda',
    credentials,
  }: HttpsHandlerOptions = {}) {
    if (!functionUrl) {
      throw new Error('ProxyFunctionUrlHttpsRequestHandler needs functionUrl');
    }
    const u = new URL(functionUrl);
    this.host = u.hostname;
    this.port = u.port ? Number(u.port) : 443;
    this.basePath = u.pathname.replace(/\/$/, '');
    this.region = region;
    this.service = service;
    this.credentials = credentials;
  }

  async #getSigner(): Promise<{
    sign: (req: unknown) => Promise<{ headers: Record<string, string> }>;
  }> {
    if (this.signer) {
      return this.signer as {
        sign: (req: unknown) => Promise<{ headers: Record<string, string> }>;
      };
    }
    const { SignatureV4 } = await import('@smithy/signature-v4');
    const { createHash, createHmac } = await import('node:crypto');
    // Minimal HashConstructor backed by Node crypto (no @aws-crypto dep).
    class Sha256 {
      private readonly hash: ReturnType<typeof createHmac | typeof createHash>;

      constructor(secret?: string | Uint8Array) {
        this.hash = secret
          ? createHmac('sha256', secret)
          : createHash('sha256');
      }

      update(data: string | Uint8Array): void {
        this.hash.update(data);
      }

      digest(): Promise<Uint8Array> {
        return Promise.resolve(new Uint8Array(this.hash.digest()));
      }
    }
    let credentials = this.credentials;
    if (!credentials) {
      const { defaultProvider } =
        await import('@aws-sdk/credential-provider-node');
      credentials = defaultProvider();
    }
    this.signer = new SignatureV4({
      service: this.service,
      region: this.region!,
      credentials: credentials,
      sha256: Sha256 as never,
    });
    return this.signer as {
      sign: (req: unknown) => Promise<{ headers: Record<string, string> }>;
    };
  }

  async handle(request: SignedRequest): Promise<{ response: unknown }> {
    const { HttpRequest, HttpResponse } = await import('@smithy/protocol-http');

    const signedPath =
      request.path + (request.query ? toQuery(request.query) : '');
    const signedBody = await collectBody(request.body);

    const envelope = {
      __proxyEnvelope: true,
      path: signedPath,
      method: request.method,
      headers: { ...request.headers },
      body: signedBody ? Buffer.from(signedBody).toString('base64') : undefined,
      bodyIsBase64: true,
    };
    const envelopeBytes = Buffer.from(JSON.stringify(envelope), 'utf8');

    // Build the OUTER POST and SigV4-sign it for the Function URL's IAM auth.
    // basePath has any trailing slash stripped in the constructor, so this is
    // always a valid absolute path ("/" when basePath is empty).
    const outerPath = `${this.basePath}/`;
    const toSign = new HttpRequest({
      method: 'POST',
      protocol: 'https:',
      hostname: this.host,
      port: this.port,
      path: outerPath,
      headers: {
        host: this.host,
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(envelopeBytes)),
      },
      body: envelopeBytes,
    });

    const signer = await this.#getSigner();
    const signed = await signer.sign(toSign);

    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          host: this.host,
          port: this.port,
          method: 'POST',
          path: outerPath,
          headers: signed.headers,
        },
        (res: IncomingMessage) => {
          resolve({
            response: new HttpResponse({
              statusCode: res.statusCode ?? 200,
              headers: reassembleHeaders(flattenHeaders(res.headers)),
              body: res,
            }),
          });
        }
      );
      req.on('error', reject);
      req.write(envelopeBytes);
      req.end();
    });
  }
}

function toQuery(
  query: Record<string, string | string[] | null | undefined>
): string {
  const parts: string[] = [];
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

async function collectBody(
  body: unknown
): Promise<string | Buffer | undefined> {
  if (!body) {
    return undefined;
  }
  if (typeof body === 'string' || Buffer.isBuffer(body)) {
    return body;
  }
  const chunks: Buffer[] = [];
  for await (const c of body as AsyncIterable<Buffer>) {
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

export { Readable };
