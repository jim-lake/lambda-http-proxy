import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FunctionUrlEvent } from '../../dist/lambda-outbound-proxy.mjs';
import { startOrigin, captureStream } from '../helpers.ts';

// Unit tests exercise proxy() directly against throwaway http origins. No
// Lambda runtime is involved — proxy() emits the response-streaming wire format
// via its non-runtime fallback path, and the test strips the prelude to recover
// the raw upstream body. The full RESPONSE_STREAM output contract is covered by
// test/unit/function-url.test.ts.
process.env.PROXY_TARGET_SCHEME = 'http';
const { proxy } = await import('../../dist/lambda-outbound-proxy.mjs');

interface SeenRequest {
  method?: string;
  url?: string;
  headers: IncomingMessage['headers'];
  body?: string;
}

test('forwards signed headers byte-for-byte and preserves Host', async () => {
  let seen: SeenRequest | undefined;
  const { server, port } = await startOrigin(
    (req: IncomingMessage, res: ServerResponse) => {
      let body = '';
      req.on('data', (d: Buffer) => (body += d));
      req.on('end', () => {
        seen = { method: req.method, url: req.url, headers: req.headers, body };
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('origin-ok');
      });
    }
  );

  const signedHost = `127.0.0.1:${port}`;
  const event = {
    version: '2.0',
    rawPath: '/my-bucket/object.txt',
    rawQueryString: 'x-id=GetObject',
    requestContext: { http: { method: 'GET' } },
    headers: {
      host: signedHost,
      authorization:
        'AWS4-HMAC-SHA256 Credential=AKID/20260101/us-east-1/s3/aws4_request, ' +
        'SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=deadbeef',
      'x-amz-date': '20260101T000000Z',
      'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
      // Lambda-injected noise that must be stripped:
      'x-amzn-trace-id': 'Root=1-abc',
      'x-forwarded-for': '203.0.113.1',
      'x-forwarded-proto': 'https',
    },
    isBase64Encoded: false,
  } satisfies FunctionUrlEvent;

  const { stream, done } = captureStream();
  await proxy(event, stream);
  if (!stream.writableEnded) stream.end();
  const result = await done;

  server.close();

  // Response streamed back correctly.
  assert.equal(result.body, 'origin-ok');
  assert.equal(result.meta?.statusCode, 200);

  // Signed headers preserved exactly.
  assert.equal(seen?.headers.authorization, event.headers.authorization);
  assert.equal(seen?.headers['x-amz-date'], '20260101T000000Z');
  assert.equal(seen?.headers['x-amz-content-sha256'], 'UNSIGNED-PAYLOAD');

  // Host preserved as signed — this is what makes SigV4 verification pass.
  assert.equal(seen?.headers.host, signedHost);

  // Path + query preserved.
  assert.equal(seen?.url, '/my-bucket/object.txt?x-id=GetObject');

  // Lambda-injected headers stripped.
  assert.equal(seen?.headers['x-amzn-trace-id'], undefined);
  assert.equal(seen?.headers['x-forwarded-for'], undefined);
  assert.equal(seen?.headers['x-forwarded-proto'], undefined);
});

test('forwards POST body unchanged (payload hash integrity)', async () => {
  let seenBody: string | undefined;
  const payload = JSON.stringify({ hello: 'world', n: 42 });
  const { server, port } = await startOrigin(
    (req: IncomingMessage, res: ServerResponse) => {
      let body = '';
      req.on('data', (d: Buffer) => (body += d));
      req.on('end', () => {
        seenBody = body;
        res.writeHead(201);
        res.end('created');
      });
    }
  );

  const event = {
    version: '2.0',
    rawPath: '/',
    rawQueryString: '',
    requestContext: { http: { method: 'POST' } },
    headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json' },
    body: payload,
    isBase64Encoded: false,
  } satisfies FunctionUrlEvent;

  const { stream, done } = captureStream();
  await proxy(event, stream);
  if (!stream.writableEnded) stream.end();
  await done;
  server.close();

  // Body must match exactly — any mutation would invalidate x-amz-content-sha256.
  assert.equal(seenBody, payload);
});

test('streams chunks incrementally rather than buffering', async () => {
  const { server, port } = await startOrigin(
    (_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('chunk-1;');
      setTimeout(() => {
        res.write('chunk-2;');
        res.end('chunk-3');
      }, 20);
    }
  );

  const event = {
    version: '2.0',
    rawPath: '/',
    rawQueryString: '',
    requestContext: { http: { method: 'GET' } },
    headers: { host: `127.0.0.1:${port}` },
    isBase64Encoded: false,
  } satisfies FunctionUrlEvent;

  const stream = new PassThrough();
  const timings: { t: number; chunk: string }[] = [];
  const start = Date.now();
  const raw: Buffer[] = [];
  stream.on('data', (c: Buffer) => {
    raw.push(c);
    timings.push({ t: Date.now() - start, chunk: c.toString() });
  });
  const done = new Promise<void>((r) => stream.on('end', r));

  await proxy(event, stream);
  if (!stream.writableEnded) stream.end();
  await done;
  server.close();

  // Strip the response-streaming prelude (JSON + 8 NUL bytes) to recover the
  // raw upstream body, then assert the body streamed through intact.
  const all = Buffer.concat(raw);
  const sep = Buffer.alloc(8);
  const idx = all.indexOf(sep);
  const bodyBytes = idx === -1 ? all : all.subarray(idx + sep.length);
  assert.equal(bodyBytes.toString('utf8'), 'chunk-1;chunk-2;chunk-3');
  // Multiple distinct writes arrived over time (proves streaming, not buffering).
  assert.ok(timings.length >= 2, 'expected multiple streamed chunks');
});

test('does NOT strip x-amzn-* signed request headers (Bedrock regression)', async () => {
  let seen: SeenRequest | undefined;
  const { server, port } = await startOrigin(
    (req: IncomingMessage, res: ServerResponse) => {
      seen = { headers: req.headers };
      res.writeHead(200);
      res.end('ok');
    }
  );

  // Bedrock signs x-amzn-bedrock-* headers. The proxy must forward them, while
  // still stripping genuine Function-URL-injected headers like x-amzn-trace-id.
  const event = {
    version: '2.0',
    rawPath: '/model/foo/invoke',
    rawQueryString: '',
    requestContext: { http: { method: 'POST' } },
    headers: {
      host: `127.0.0.1:${port}`,
      'x-amzn-bedrock-accept': 'application/json',
      'x-amzn-bedrock-content-type': 'application/json',
      'x-amzn-trace-id': 'Root=1-should-be-stripped',
    },
    isBase64Encoded: false,
  } satisfies FunctionUrlEvent;

  const { stream, done } = captureStream();
  await proxy(event, stream);
  if (!stream.writableEnded) stream.end();
  await done;
  server.close();

  assert.equal(seen?.headers['x-amzn-bedrock-accept'], 'application/json');
  assert.equal(
    seen?.headers['x-amzn-bedrock-content-type'],
    'application/json'
  );
  assert.equal(seen?.headers['x-amzn-trace-id'], undefined);
});

test('uses envelope path/headers/body verbatim when present', async () => {
  let seen: SeenRequest | undefined;
  const { server, port } = await startOrigin(
    (req: IncomingMessage, res: ServerResponse) => {
      let body = '';
      req.on('data', (d: Buffer) => (body += d));
      req.on('end', () => {
        seen = { method: req.method, url: req.url, headers: req.headers, body };
        res.writeHead(200);
        res.end('ok');
      });
    }
  );

  // Exact signed path with a double-encoded ':' — the thing that broke Bedrock
  // when rebuilt from a decoded rawPath.
  const signedPath =
    '/model/anthropic.claude-3-haiku-20240307-v1%3A0/invoke-with-response-stream';
  const signedPayload = JSON.stringify({ prompt: 'hi' });

  const envelope = {
    __proxyEnvelope: true,
    path: signedPath,
    method: 'POST',
    headers: {
      host: `127.0.0.1:${port}`,
      'content-type': 'application/json',
      'x-amz-content-sha256': 'abc123',
    },
    body: Buffer.from(signedPayload, 'utf8').toString('base64'),
    bodyIsBase64: true,
  };

  // The outer Function URL event carries the envelope as its JSON body. Its own
  // rawPath is intentionally different to prove the envelope path wins.
  const event = {
    version: '2.0',
    rawPath: '/this-should-be-ignored',
    rawQueryString: 'ignored=1',
    requestContext: { http: { method: 'POST' } },
    headers: { host: 'should-be-ignored', 'content-type': 'application/json' },
    body: JSON.stringify(envelope),
    isBase64Encoded: false,
  } satisfies FunctionUrlEvent;

  const { stream, done } = captureStream();
  await proxy(event, stream);
  if (!stream.writableEnded) stream.end();
  await done;
  server.close();

  // Exact signed path preserved (encoding intact).
  assert.equal(seen?.url, signedPath);
  // Envelope headers used, not the outer event headers.
  assert.equal(seen?.headers['x-amz-content-sha256'], 'abc123');
  assert.equal(seen?.headers.host, `127.0.0.1:${port}`);
  // Real signed body delivered, not the envelope JSON.
  assert.equal(seen?.body, signedPayload);
});
