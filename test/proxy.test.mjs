import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Buffer } from 'node:buffer';
import { PassThrough } from 'node:stream';

// Unit tests exercise proxy() directly against throwaway http origins. No
// Lambda runtime is involved — proxy() annotates the response stream via its
// non-runtime fallback path. Real-runtime behaviour is covered by `sam:invoke`.
process.env.PROXY_TARGET_SCHEME = 'http';
const { proxy } = await import('../dist/lambda-http-proxy.mjs');

/**
 * Spin up a throwaway origin server that records exactly what headers/body it
 * received, so we can assert the proxy forwarded them byte-for-byte. This is
 * the crux of SigV4 survival: the bytes the origin sees must match what was
 * signed.
 */
function startOrigin(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}

/** Collect a PassThrough's bytes + metadata as if we were the Function URL caller. */
function captureStream() {
  const stream = new PassThrough();
  const chunks = [];
  stream.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve) => {
    stream.on('end', () =>
      resolve({
        body: Buffer.concat(chunks).toString('utf8'),
        meta: stream.__meta,
      })
    );
  });
  return { stream, done };
}

test('forwards signed headers byte-for-byte and preserves Host', async () => {
  let seen;
  const { server, port } = await startOrigin((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      seen = { method: req.method, url: req.url, headers: req.headers, body };
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('origin-ok');
    });
  });

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
  };

  const { stream, done } = captureStream();
  await proxy(event, stream);
  if (!stream.writableEnded) stream.end();
  const result = await done;

  server.close();

  // Response streamed back correctly.
  assert.equal(result.body, 'origin-ok');
  assert.equal(result.meta.statusCode, 200);

  // Signed headers preserved exactly.
  assert.equal(seen.headers.authorization, event.headers.authorization);
  assert.equal(seen.headers['x-amz-date'], '20260101T000000Z');
  assert.equal(seen.headers['x-amz-content-sha256'], 'UNSIGNED-PAYLOAD');

  // Host preserved as signed — this is what makes SigV4 verification pass.
  assert.equal(seen.headers.host, signedHost);

  // Path + query preserved.
  assert.equal(seen.url, '/my-bucket/object.txt?x-id=GetObject');

  // Lambda-injected headers stripped.
  assert.equal(seen.headers['x-amzn-trace-id'], undefined);
  assert.equal(seen.headers['x-forwarded-for'], undefined);
  assert.equal(seen.headers['x-forwarded-proto'], undefined);
});

test('forwards POST body unchanged (payload hash integrity)', async () => {
  let seenBody;
  const payload = JSON.stringify({ hello: 'world', n: 42 });
  const { server, port } = await startOrigin((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      seenBody = body;
      res.writeHead(201);
      res.end('created');
    });
  });

  const event = {
    version: '2.0',
    rawPath: '/',
    rawQueryString: '',
    requestContext: { http: { method: 'POST' } },
    headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json' },
    body: payload,
    isBase64Encoded: false,
  };

  const { stream, done } = captureStream();
  await proxy(event, stream);
  if (!stream.writableEnded) stream.end();
  await done;
  server.close();

  // Body must match exactly — any mutation would invalidate x-amz-content-sha256.
  assert.equal(seenBody, payload);
});

test('streams chunks incrementally rather than buffering', async () => {
  const { server, port } = await startOrigin((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.write('chunk-1;');
    setTimeout(() => {
      res.write('chunk-2;');
      res.end('chunk-3');
    }, 20);
  });

  const event = {
    version: '2.0',
    rawPath: '/',
    rawQueryString: '',
    requestContext: { http: { method: 'GET' } },
    headers: { host: `127.0.0.1:${port}` },
    isBase64Encoded: false,
  };

  const stream = new PassThrough();
  const timings = [];
  const start = Date.now();
  stream.on('data', (c) =>
    timings.push({ t: Date.now() - start, chunk: c.toString() })
  );
  const done = new Promise((r) => stream.on('end', r));

  await proxy(event, stream);
  if (!stream.writableEnded) stream.end();
  await done;
  server.close();

  const full = timings.map((x) => x.chunk).join('');
  assert.equal(full, 'chunk-1;chunk-2;chunk-3');
  // At least one chunk arrived before the delayed ones (proves streaming).
  assert.ok(timings.length >= 2, 'expected multiple streamed chunks');
});

test('does NOT strip x-amzn-* signed request headers (Bedrock regression)', async () => {
  let seen;
  const { server, port } = await startOrigin((req, res) => {
    seen = { headers: req.headers };
    res.writeHead(200);
    res.end('ok');
  });

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
  };

  const { stream, done } = captureStream();
  await proxy(event, stream);
  if (!stream.writableEnded) stream.end();
  await done;
  server.close();

  assert.equal(seen.headers['x-amzn-bedrock-accept'], 'application/json');
  assert.equal(seen.headers['x-amzn-bedrock-content-type'], 'application/json');
  assert.equal(seen.headers['x-amzn-trace-id'], undefined);
});

test('uses envelope path/headers/body verbatim when present', async () => {
  let seen;
  const { server, port } = await startOrigin((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      seen = { method: req.method, url: req.url, headers: req.headers, body };
      res.writeHead(200);
      res.end('ok');
    });
  });

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
  };

  const { stream, done } = captureStream();
  await proxy(event, stream);
  if (!stream.writableEnded) stream.end();
  await done;
  server.close();

  // Exact signed path preserved (encoding intact).
  assert.equal(seen.url, signedPath);
  // Envelope headers used, not the outer event headers.
  assert.equal(seen.headers['x-amz-content-sha256'], 'abc123');
  assert.equal(seen.headers.host, `127.0.0.1:${port}`);
  // Real signed body delivered, not the envelope JSON.
  assert.equal(seen.body, signedPayload);
});
