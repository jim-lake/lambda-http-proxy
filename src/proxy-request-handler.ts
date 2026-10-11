import http from 'node:http';
import https from 'node:https';
import { Buffer } from 'node:buffer';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { HttpRequest, HttpResponse } from '@smithy/protocol-http';
import { SignatureV4 } from '@smithy/signature-v4';
import { Sha256 } from '@smithy/core/checksum';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import type { AwsCredentialIdentity, Provider } from '@smithy/types';

/*
 * Compile-time constant injected by esbuild (`define` in rollup.config.mjs)
 * from package.json's version. Exported so a version bump always changes the
 * output bytes and the symbol survives tree-shaking.
 */
declare const __BUILD_VERSION__: string;
export const BUILD_VERSION: string = __BUILD_VERSION__;

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

export interface ProxyRequestHandlerOptions {
  /**
   * The Function URL of the deployed proxy. Required. For local testing this
   * can be a plain-http URL (e.g. `http://127.0.0.1:3000/`); the outer POST is
   * SigV4-signed either way.
   */
  proxyUrl: string;
  /**
   * Region used to SigV4-sign the OUTER POST for the `lambda` service.
   * Defaults to the region parsed from the Function URL host. When the host is
   * not a Function URL (e.g. localhost) it falls back to `us-east-1` — the
   * value is irrelevant for a local proxy that does not verify the signature.
   */
  region?: string;
  /**
   * Credentials used to sign the OUTER POST. Defaults to the AWS default
   * credential provider chain.
   */
  credentials?: AwsCredentialIdentity | Provider<AwsCredentialIdentity>;
}

/*
 * Parse "<id>.lambda-url.<region>.on.aws" -> region. Returns '' when the host
 * is not a Function URL (e.g. a local http proxy), in which case the caller
 * falls back to an arbitrary region — it is irrelevant for a local proxy.
 */
function regionFromHost(host: string): string {
  const m = /\.lambda-url\.([^.]+)\.on\.aws$/.exec(host);
  return m ? m[1] : '';
}

/**
 * A service-agnostic AWS SDK requestHandler that routes an already-signed
 * request through the Lambda HTTP proxy instead of directly to the signed host.
 *
 * It wraps the entire signed request (path, method, headers, body) in a JSON
 * envelope and POSTs it to the proxy. The OUTER POST is ALWAYS SigV4-signed for
 * the `lambda` service so it authenticates against the Function URL's
 * `AuthType: AWS_IAM`. The proxy unwraps the envelope and forwards the signed
 * request verbatim to the real host, so SigV4 verification at the upstream
 * passes unchanged. Works for any SigV4 service — S3, Bedrock, DynamoDB, etc. —
 * because it never interprets the payload.
 *
 * Two independent SigV4 signatures are in play, and they must not be confused:
 *   - INNER: the SDK already signed the request for its target service. That
 *     signature rides inside the envelope untouched.
 *   - OUTER: this handler signs the POST to the Function URL for service
 *     `lambda` in the URL's region, so the Function URL's IAM auth accepts it.
 *
 * Construct with just the URL:
 *   new ProxyRequestHandler({ proxyUrl: 'https://<id>.lambda-url.<region>.on.aws/' })
 */
export class ProxyRequestHandler {
  private readonly client: typeof http | typeof https;
  private readonly host: string;
  private readonly port: number;
  private readonly basePath: string;
  private readonly region: string;
  private readonly signer: SignatureV4;

  constructor(opts: ProxyRequestHandlerOptions) {
    if (!opts.proxyUrl) {
      throw new Error('ProxyRequestHandler requires a proxyUrl');
    }
    const u = new URL(opts.proxyUrl);
    this.client = u.protocol === 'http:' ? http : https;
    this.host = u.hostname;
    this.port = u.port ? Number(u.port) : u.protocol === 'http:' ? 80 : 443;
    this.basePath = u.pathname.replace(/\/$/, '');
    /*
     * Region to sign the outer POST. Prefer an explicit option, then the
     * Function URL host, then an arbitrary default — the value is irrelevant
     * for a local proxy that does not verify the signature.
     */
    const parsedRegion = regionFromHost(this.host);
    this.region =
      opts.region ?? (parsedRegion === '' ? 'us-east-1' : parsedRegion);
    this.signer = new SignatureV4({
      service: 'lambda',
      region: this.region,
      credentials: opts.credentials ?? defaultProvider(),
      sha256: Sha256,
    });
  }

  async handle(request: SignedRequest): Promise<{ response: HttpResponse }> {
    const signedPath =
      request.path + (request.query ? toQuery(request.query) : '');
    const signedBody = await collectBody(request.body);

    /*
     * Wrap the ENTIRE signed request (path, method, headers, body) in a JSON
     * envelope. The outer hop to the proxy is a plain application/json POST;
     * the signed request rides inside untouched. This keeps the two layers
     * separate so the outer content-length (envelope size) never collides with
     * the signed content-length (real payload), and the exact signed path
     * survives the Function URL hop (e.g. Bedrock's %253A).
     */
    const envelope = {
      __proxyEnvelope: true,
      path: signedPath,
      method: request.method,
      headers: { ...request.headers },
      body: signedBody ? Buffer.from(signedBody).toString('base64') : undefined,
      bodyIsBase64: true,
    };
    const envelopeBytes = Buffer.from(JSON.stringify(envelope), 'utf8');

    /*
     * basePath has any trailing slash stripped in the constructor, so this is
     * always a valid absolute path ("/" when basePath is empty).
     */
    const outerPath = `${this.basePath}/`;
    const protocol = this.client === http ? 'http:' : 'https:';

    // Build the OUTER POST and SigV4-sign it for the Function URL's IAM auth.
    const toSign = new HttpRequest({
      method: 'POST',
      protocol,
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
    const signed = await this.signer.sign(toSign);

    return new Promise((resolve, reject) => {
      const proxyReq = this.client.request(
        {
          host: this.host,
          port: this.port,
          method: 'POST',
          path: outerPath,
          headers: signed.headers,
        },
        (proxyRes: IncomingMessage) => {
          resolve({
            response: new HttpResponse({
              statusCode: proxyRes.statusCode ?? 200,
              headers: reassembleHeaders(flattenHeaders(proxyRes.headers)),
              body: proxyRes,
            }),
          });
        }
      );
      proxyReq.on('error', reject);
      proxyReq.write(envelopeBytes);
      proxyReq.end();
    });
  }
}

function toQuery(
  query: Record<string, string | string[] | null | undefined>
): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(query)) {
    if (v === null || v === undefined) {
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

function flattenHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) {
      // header absent; skip it
    } else if (Array.isArray(v)) {
      out[k] = v.join(', ');
    } else {
      out[k] = v;
    }
  }
  return out;
}

/*
 * Undo the AWS Lambda Function URL edge's response-header remapping. In
 * RESPONSE_STREAM mode the edge renames a set of reserved response headers by
 * prefixing them with `x-amzn-remapped-` (e.g. the upstream `Content-Length`
 * arrives as `x-amzn-remapped-content-length`). We restore the canonical names
 * so the SDK — and any downstream consumer — sees the response exactly as the
 * upstream service sent it (so, e.g., HeadObject's ContentLength is populated).
 * The remapped alias is dropped once restored. An existing canonical header is
 * never overwritten.
 */
const REMAP_PREFIX = 'x-amzn-remapped-';

/*
 * The Lambda proxy's own side channel. For every response header the Function
 * URL streaming edge MANGLES (drops `content-length`, overrides `content-type`,
 * …), the proxy emits a verbatim copy named `x-lambda-proxy-remap-<header>`
 * that the edge forwards untouched. These carry the TRUE upstream values, so
 * they take precedence over anything else when reassembling the response.
 */
const PROXY_REMAP_PREFIX = 'x-lambda-proxy-remap-';

/*
 * Reassemble the true upstream response headers from what reached the caller.
 * Precedence, highest first:
 *   1. `x-lambda-proxy-remap-<h>`  — the proxy's verbatim upstream value.
 *   2. the canonical header          — if the edge left it alone.
 *   3. `x-amzn-remapped-<h>`        — the edge's own remap (fallback).
 * All helper/alias headers are dropped from the result.
 */
export function reassembleHeaders(
  headers: Record<string, string>
): Record<string, string> {
  const out: Record<string, string> = {};

  // Pass 1: carry through non-alias headers and apply the edge's own remap.
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase();
    if (lower.startsWith(PROXY_REMAP_PREFIX)) {
      // handled in pass 2 (authoritative)
    } else if (lower.startsWith(REMAP_PREFIX)) {
      const canonical = lower.slice(REMAP_PREFIX.length);
      if (!Object.hasOwn(headers, canonical)) {
        out[canonical] = v;
      }
    } else {
      out[k] = v;
    }
  }

  // Pass 2: the proxy's side channel wins — it holds the real upstream value.
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase();
    if (lower.startsWith(PROXY_REMAP_PREFIX)) {
      out[lower.slice(PROXY_REMAP_PREFIX.length)] = v;
    }
  }

  return out;
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
