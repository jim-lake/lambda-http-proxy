import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { startOrigin, collect } from '../helpers.ts';
// Exercise the built secondary entry point exactly as consumers import it.
import { ProxyRequestHandler } from '../../dist/proxy-request-handler.mjs';

interface SeenRequest {
  method?: string;
  url?: string;
  headers: IncomingMessage['headers'];
  body: string;
}

// The handler POSTs a JSON envelope to the proxy. Stand up a throwaway local
// http "proxy" that records what it received and replies, proving the handler
// wraps the signed request correctly and surfaces the response to the SDK.
test('wraps the signed request in an envelope and POSTs it to the proxy', async () => {
  let seen: SeenRequest | undefined;
  const { server, port } = await startOrigin(
    (req: IncomingMessage, res: ServerResponse) => {
      let body = '';
      req.on('data', (d: Buffer) => (body += d));
      req.on('end', () => {
        seen = { method: req.method, url: req.url, headers: req.headers, body };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('proxy-ok');
      });
    }
  );

  const handler = new ProxyRequestHandler({
    proxyUrl: `http://127.0.0.1:${port}/`,
    region: 'us-east-1',
    credentials: {
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    },
  });

  const signedHeaders = {
    host: 's3.us-east-1.amazonaws.com',
    authorization: 'AWS4-HMAC-SHA256 Credential=AKID/…, Signature=deadbeef',
    'x-amz-date': '20260101T000000Z',
    'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
  };

  const { response } = await handler.handle({
    method: 'PUT',
    path: '/my-bucket/object.txt',
    query: { 'x-id': 'PutObject' },
    headers: signedHeaders,
    body: 'hello-body',
  });

  server.close();

  // Outer hop: a plain application/json POST carrying the envelope.
  assert.equal(seen?.method, 'POST');
  assert.equal(seen?.url, '/');
  assert.equal(seen?.headers['content-type'], 'application/json');

  const envelope = JSON.parse(seen.body) as {
    __proxyEnvelope: boolean;
    path: string;
    method: string;
    headers: Record<string, string>;
    body: string;
    bodyIsBase64: boolean;
  };
  assert.equal(envelope.__proxyEnvelope, true);
  // Exact signed path (incl. query) rides inside the envelope untouched.
  assert.equal(envelope.path, '/my-bucket/object.txt?x-id=PutObject');
  assert.equal(envelope.method, 'PUT');
  // Signed headers (incl. authorization + Host) pass through verbatim.
  assert.deepEqual(envelope.headers, signedHeaders);
  // Body is base64 so binary payloads survive the JSON envelope.
  assert.equal(envelope.bodyIsBase64, true);
  assert.equal(
    Buffer.from(envelope.body, 'base64').toString('utf8'),
    'hello-body'
  );

  // The proxy response is surfaced back to the SDK as an HttpResponse.
  const resp = response as {
    statusCode: number;
    headers: Record<string, string>;
    body: IncomingMessage;
  };
  assert.equal(resp.statusCode, 200);
  const bodyBytes = await collect(resp.body);
  assert.equal(bodyBytes.toString('utf8'), 'proxy-ok');
});
