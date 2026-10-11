import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import https from 'node:https';
import { resolveTarget } from './proxy-target.ts';

/*
 * Deployment-safety guard against REAL AWS.
 *
 * The deployed Function URL is configured AuthType: AWS_IAM. The Lambda itself
 * signs NOTHING — it forwards the caller's already-signed inner request
 * verbatim — so IAM auth on the URL is the ONLY thing gating who may use the
 * proxy. If someone ever deploys (or reconfigures) it as AuthType: NONE, that
 * gate disappears and the proxy becomes an open, unauthenticated relay anyone
 * can drive. This test proves the URL REJECTS an UNSIGNED request, so an
 * accidentally-public deployment fails the gate loudly.
 *
 * It sends a raw POST with NO SigV4 Authorization header straight to the
 * Function URL (bypassing ProxyRequestHandler, which always signs). IAM auth
 * must reject it with HTTP 403 and the AWS "Forbidden"/"Missing Authentication
 * Token" shape. A 2xx — meaning the URL accepted an unsigned request — is a
 * hard failure.
 *
 * This only has meaning against a live IAM-protected URL, so it is a no-op in
 * local mode (the local socket has no IAM in front of it).
 */

interface UnsignedResponse {
  statusCode: number;
  body: string;
}

/* Fire a bare, UNSIGNED POST at the URL and collect status + body. */
function postUnsigned(url: string, body: string): Promise<UnsignedResponse> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            statusCode: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          })
        );
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

const t = resolveTarget();

test('deployed Function URL rejects an unsigned request (real AWS IAM)', async (ctx) => {
  if (t.target !== 'deployed') {
    ctx.skip('only meaningful against a live IAM-protected Function URL');
    return;
  }

  const res = await postUnsigned(
    t.functionUrl!,
    JSON.stringify({ __proxyEnvelope: true, probe: 'unsigned' })
  );

  // IAM auth must forbid the unsigned request. Anything 2xx means the URL
  // accepted it unauthenticated — exactly the misconfiguration this guards.
  assert.ok(
    res.statusCode < 200 || res.statusCode >= 300,
    `expected a non-2xx status for an unsigned request, got ${res.statusCode} ` +
      '— the Function URL appears to accept UNAUTHENTICATED requests ' +
      '(check AuthType: AWS_IAM)'
  );
  assert.equal(
    res.statusCode,
    403,
    `expected HTTP 403 Forbidden from IAM auth, got ${res.statusCode}: ${res.body}`
  );
  assert.match(
    res.body,
    /Forbidden|Missing Authentication Token/i,
    `expected an AWS auth-rejection body, got: ${res.body}`
  );
});
