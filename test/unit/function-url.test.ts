import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { startOrigin } from '../helpers.ts';
import {
  invokeFunctionUrl,
  collect,
  makeEnvelopeEvent,
} from '../function-url-runtime.ts';

/*
 * These tests drive the proxy through the plain-node Function URL emulator
 * (`test/function-url-runtime.ts`) in RESPONSE_STREAM mode — the EXPECTED use
 * case. They assert the proxy output is INDISTINGUISHABLE from the upstream:
 * same status, same headers, same body bytes, streamed incrementally. A
 * consumer can pipe `body` straight downstream with no response rewriting.
 *
 * Input is still the proxy envelope; only the output contract is exercised here.
 */
process.env.PROXY_TARGET_SCHEME = 'http';

test('output status, headers, and body match the upstream exactly', async () => {
  const bodyText = 'the-upstream-body-bytes';
  const { server, port } = await startOrigin(
    (_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(206, {
        'content-type': 'application/octet-stream',
        'x-upstream-marker': 'present',
        etag: '"abc123"',
      });
      res.end(bodyText);
    }
  );

  const event = makeEnvelopeEvent({
    path: '/some/object?x-id=GetObject',
    method: 'GET',
    headers: { host: `127.0.0.1:${port}` },
  });

  const { statusCode, headers, body } = await invokeFunctionUrl(event);
  const received = (await collect(body)).toString('utf8');
  server.close();

  // Status mirrored from upstream (not forced to 200).
  assert.equal(statusCode, 206);
  // Upstream headers surfaced verbatim — the caller cannot tell a proxy was involved.
  assert.equal(headers['content-type'], 'application/octet-stream');
  assert.equal(headers['x-upstream-marker'], 'present');
  assert.equal(headers.etag, '"abc123"');
  // Body is byte-for-byte the upstream body — no prelude, no wrapper.
  assert.equal(received, bodyText);
});

test('binary body passes through byte-for-byte', async () => {
  // Simulate a binary payload like Bedrock's event-stream bytes.
  const payload = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x7f, 0x80, 0x00, 0x2a]);
  const { server, port } = await startOrigin(
    (_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, {
        'content-type': 'application/vnd.amazon.eventstream',
      });
      res.end(payload);
    }
  );

  const event = makeEnvelopeEvent({
    path: '/model/foo/invoke-with-response-stream',
    method: 'POST',
    headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'hi' }),
  });

  const { statusCode, body } = await invokeFunctionUrl(event);
  const received = await collect(body);
  server.close();

  assert.equal(statusCode, 200);
  assert.ok(received.equals(payload), 'binary body must survive byte-for-byte');
});

test('body is delivered incrementally, not buffered', async () => {
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

  const event = makeEnvelopeEvent({
    path: '/',
    method: 'GET',
    headers: { host: `127.0.0.1:${port}` },
  });

  const { body } = await invokeFunctionUrl(event);

  const start = Date.now();
  const timings: { t: number; chunk: string }[] = [];
  for await (const chunk of body) {
    timings.push({ t: Date.now() - start, chunk: chunk.toString('utf8') });
  }
  server.close();

  const full = timings.map((x) => x.chunk).join('');
  assert.equal(full, 'chunk-1;chunk-2;chunk-3');
  assert.ok(timings.length >= 2, 'expected multiple streamed chunks');
  // The first chunk must arrive well before the delayed ones (proves streaming).
  const firstBatch = timings.filter((x) => x.chunk.includes('chunk-1'));
  assert.ok(firstBatch.length >= 1);
});

test('upstream error status is mirrored (e.g. post-signature NoSuchKey)', async () => {
  const { server, port } = await startOrigin(
    (_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(404, { 'content-type': 'application/xml' });
      res.end('<Error><Code>NoSuchKey</Code></Error>');
    }
  );

  const event = makeEnvelopeEvent({
    path: '/missing',
    method: 'GET',
    headers: { host: `127.0.0.1:${port}` },
  });

  const { statusCode, headers, body } = await invokeFunctionUrl(event);
  const received = (await collect(body)).toString('utf8');
  server.close();

  assert.equal(statusCode, 404);
  assert.equal(headers['content-type'], 'application/xml');
  assert.match(received, /NoSuchKey/);
});

test('empty-body response (HEAD) still conveys status and headers', async () => {
  // HEAD responses carry metadata (Content-Length, ETag, …) in headers with an
  // EMPTY body. The proxy must flush the metadata prelude even though no body
  // byte is ever written, otherwise the edge builds a response missing those
  // headers (e.g. HeadObject's Content-Length comes back undefined).
  const { server, port } = await startOrigin(
    (_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, {
        'content-length': '12345',
        etag: '"deadbeef"',
        'content-type': 'application/octet-stream',
      });
      res.end(); // no body — mirrors a HEAD response
    }
  );

  const event = makeEnvelopeEvent({
    path: '/some/object',
    method: 'HEAD',
    headers: { host: `127.0.0.1:${port}` },
  });

  const { statusCode, headers, body } = await invokeFunctionUrl(event);
  const received = await collect(body);
  server.close();

  assert.equal(statusCode, 200);
  // Upstream headers survive even with an empty body.
  assert.equal(headers['content-length'], '12345');
  assert.equal(headers.etag, '"deadbeef"');
  assert.equal(headers['content-type'], 'application/octet-stream');
  // Body is genuinely empty — byte-for-byte the upstream (HEAD) body.
  assert.equal(received.length, 0);
});
