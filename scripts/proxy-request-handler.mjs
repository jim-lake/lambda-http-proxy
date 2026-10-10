import http from 'node:http';
import https from 'node:https';
import { HttpResponse } from '@smithy/protocol-http';

/**
 * A service-agnostic AWS SDK requestHandler that routes an already-signed
 * request through the Lambda HTTP proxy instead of directly to the signed host.
 *
 * It wraps the entire signed request (path, method, headers, body) in a JSON
 * envelope and POSTs it to the proxy. The proxy unwraps it and forwards the
 * signed request verbatim to the real host, so SigV4 verification at the
 * upstream passes unchanged. Works for any SigV4 service — S3, Bedrock,
 * DynamoDB, etc. — because it never interprets the payload.
 *
 * Construct with either:
 *   { proxyUrl: 'https://<id>.lambda-url.<region>.on.aws/' }   (production)
 *   { proxyHost: '127.0.0.1', proxyPort: 3000 }                 (local http)
 */
export class ProxyRequestHandler {
  constructor(opts = {}) {
    if (opts.proxyUrl) {
      const u = new URL(opts.proxyUrl);
      this.client = u.protocol === 'http:' ? http : https;
      this.host = u.hostname;
      this.port = u.port ? Number(u.port) : u.protocol === 'http:' ? 80 : 443;
      this.basePath = u.pathname.replace(/\/$/, '');
    } else {
      this.client = http;
      this.host = opts.proxyHost ?? '127.0.0.1';
      this.port = opts.proxyPort ?? 3000;
      this.basePath = '';
    }
  }

  async handle(request) {
    const signedPath =
      request.path + (request.query ? toQuery(request.query) : '');
    const signedBody = await collectBody(request.body);

    // Wrap the ENTIRE signed request (path, method, headers, body) in a JSON
    // envelope. The outer hop to the proxy is a plain application/json POST;
    // the signed request rides inside untouched. This keeps the two layers
    // separate so the outer content-length (envelope size) never collides with
    // the signed content-length (real payload), and the exact signed path
    // survives the Function URL hop (e.g. Bedrock's %253A).
    const envelope = {
      __proxyEnvelope: true,
      path: signedPath,
      method: request.method,
      headers: { ...request.headers },
      body: signedBody ? Buffer.from(signedBody).toString('base64') : undefined,
      bodyIsBase64: true,
    };
    const envelopeBytes = Buffer.from(JSON.stringify(envelope), 'utf8');

    return new Promise((resolve, reject) => {
      const proxyReq = this.client.request(
        {
          host: this.host,
          port: this.port,
          method: 'POST',
          path: `${this.basePath}/` || '/',
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(envelopeBytes),
          },
        },
        (proxyRes) => {
          resolve({
            response: new HttpResponse({
              statusCode: proxyRes.statusCode,
              headers: flattenHeaders(proxyRes.headers),
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

function toQuery(query) {
  const parts = [];
  for (const [k, v] of Object.entries(query)) {
    if (v == null) parts.push(encodeURIComponent(k));
    else if (Array.isArray(v))
      for (const item of v)
        parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(item)}`);
    else parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

function flattenHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers))
    out[k] = Array.isArray(v) ? v.join(', ') : v;
  return out;
}

async function collectBody(body) {
  if (!body) return undefined;
  if (typeof body === 'string' || Buffer.isBuffer(body)) return body;
  const chunks = [];
  for await (const c of body) chunks.push(c);
  return Buffer.concat(chunks);
}
