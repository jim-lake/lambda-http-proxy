import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import https from 'node:https';
import { resolveTarget } from './proxy-target.ts';

interface UnsignedResponse {
  statusCode: number;
  body: string;
}

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

// Deployed-only: there is no IAM gate in front of a local socket to assert on.
if (t.target === 'deployed') {
  registerUnsignedRejectionTest(t.functionUrl!);
}

function registerUnsignedRejectionTest(functionUrl: string): void {
  test('deployed Function URL rejects an unsigned request (real AWS IAM)', async () => {
    const res = await postUnsigned(
      functionUrl,
      JSON.stringify({ __proxyEnvelope: true, probe: 'unsigned' })
    );

    assert.ok(
      res.statusCode < 200 || res.statusCode >= 300,
      `expected a non-2xx status for an unsigned request, got ${res.statusCode}`
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
}
