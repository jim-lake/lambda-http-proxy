import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { startOrigin } from '../helpers.ts';
import { startLocalProxyServer } from '../function-url-runtime.ts';
import { FetchProxy } from '../../dist/fetch-proxy.js';

process.env.PROXY_TARGET_SCHEME = 'http';

const creds = {
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
};

async function readWeb(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

test('resolves a WHATWG Response: status, headers, and body map from upstream', async () => {
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
  const local = await startLocalProxyServer();
  const proxy = new FetchProxy({ proxyUrl: local.url, credentials: creds });

  const res = await proxy.fetch(`http://127.0.0.1:${port}/some/object`);

  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-type'), 'application/octet-stream');
  assert.equal(res.headers.get('x-upstream-marker'), 'present');
  assert.equal(res.headers.get('etag'), '"abc123"');
  assert.ok(res.body instanceof ReadableStream);
  const received = (await readWeb(res.body)).toString('utf8');
  assert.equal(received, bodyText);

  server.close();
  await local.close();
});

test('forwards inner request headers byte-for-byte (inner signature survives)', async () => {
  let seen: IncomingMessage['headers'] | undefined;
  const { server, port } = await startOrigin(
    (req: IncomingMessage, res: ServerResponse) => {
      seen = req.headers;
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    }
  );
  const local = await startLocalProxyServer();
  const proxy = new FetchProxy({ proxyUrl: local.url, credentials: creds });

  const innerHeaders = {
    host: `127.0.0.1:${port}`,
    authorization:
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20260101/us-west-2/bedrock/aws4_request, SignedHeaders=host;x-amz-date, Signature=deadbeefcafe',
    'x-amz-date': '20260101T000000Z',
    'x-amz-content-sha256': 'abc',
    'x-amzn-bedrock-accept': 'application/json',
    'content-type': 'application/json',
  };

  const res = await proxy.fetch(`http://127.0.0.1:${port}/model/foo/invoke`, {
    method: 'POST',
    headers: innerHeaders,
    body: JSON.stringify({ prompt: 'hi' }),
  });
  await res.text();

  assert.equal(seen?.authorization, innerHeaders.authorization);
  assert.equal(seen?.['x-amz-date'], innerHeaders['x-amz-date']);
  assert.equal(seen?.['x-amz-content-sha256'], 'abc');
  assert.equal(seen?.['x-amzn-bedrock-accept'], 'application/json');

  server.close();
  await local.close();
});

test('body streams incrementally — SSE chunks arrive before the end', async () => {
  const { server, port } = await startOrigin(
    (_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: one\n\n');
      setTimeout(() => {
        res.write('data: two\n\n');
        res.end('data: three\n\n');
      }, 20);
    }
  );
  const local = await startLocalProxyServer();
  const proxy = new FetchProxy({ proxyUrl: local.url, credentials: creds });

  const res = await proxy.fetch(`http://127.0.0.1:${port}/chat`, {
    method: 'POST',
    headers: { host: `127.0.0.1:${port}` },
    body: '{"stream":true}',
  });
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  assert.ok(res.body);

  const reader = res.body.getReader();
  const start = Date.now();
  const timings: { t: number; chunk: string }[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    timings.push({
      t: Date.now() - start,
      chunk: Buffer.from(value).toString('utf8'),
    });
  }

  const full = timings.map((x) => x.chunk).join('');
  assert.equal(full, 'data: one\n\ndata: two\n\ndata: three\n\n');
  assert.ok(timings.length >= 2, 'expected multiple streamed chunks');
  const first = timings[0];
  assert.ok(first.chunk.includes('one'));
  assert.ok(first.t < 15, 'first SSE chunk should arrive before the delay');

  server.close();
  await local.close();
});

test('HTTP error statuses resolve (not reject) so the body is readable', async () => {
  const { server, port } = await startOrigin(
    (_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(404, { 'content-type': 'application/xml' });
      res.end('<Error><Code>NoSuchKey</Code></Error>');
    }
  );
  const local = await startLocalProxyServer();
  const proxy = new FetchProxy({ proxyUrl: local.url, credentials: creds });

  const res = await proxy.fetch(`http://127.0.0.1:${port}/missing`);
  assert.equal(res.status, 404);
  assert.equal(res.headers.get('content-type'), 'application/xml');
  const text = await res.text();
  assert.match(text, /NoSuchKey/);

  server.close();
  await local.close();
});

test('does not follow redirects — 3xx + location returned as-is', async () => {
  let hits = 0;
  const { server, port } = await startOrigin(
    (req: IncomingMessage, res: ServerResponse) => {
      hits += 1;
      req.resume();
      if (req.url === '/redirect-me') {
        res.writeHead(302, { location: '/elsewhere' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('followed');
    }
  );
  const local = await startLocalProxyServer();
  const proxy = new FetchProxy({ proxyUrl: local.url, credentials: creds });

  const res = await proxy.fetch(`http://127.0.0.1:${port}/redirect-me`, {
    redirect: 'manual',
  });

  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/elsewhere');
  assert.equal(hits, 1);

  server.close();
  await local.close();
});

test('HEAD / null-body response resolves with a null body and correct status', async () => {
  const { server, port } = await startOrigin(
    (_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, {
        'content-length': '12345',
        etag: '"deadbeef"',
        'content-type': 'application/octet-stream',
      });
      res.end();
    }
  );
  const local = await startLocalProxyServer();
  const proxy = new FetchProxy({ proxyUrl: local.url, credentials: creds });

  const res = await proxy.fetch(`http://127.0.0.1:${port}/some/object`, {
    method: 'HEAD',
  });

  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-length'), '12345');
  assert.equal(res.headers.get('content-type'), 'application/octet-stream');
  assert.equal(res.headers.get('etag'), '"deadbeef"');
  assert.equal(res.headers.get('x-lambda-proxy-remap-content-length'), null);
  assert.equal(res.body, null);

  server.close();
  await local.close();
});

test('accepts a Request object as input', async () => {
  let seenUrl: string | undefined;
  let seenMethod: string | undefined;
  const { server, port } = await startOrigin(
    (req: IncomingMessage, res: ServerResponse) => {
      seenUrl = req.url;
      seenMethod = req.method;
      req.resume();
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    }
  );
  const local = await startLocalProxyServer();
  const proxy = new FetchProxy({ proxyUrl: local.url, credentials: creds });

  const request = new Request(`http://127.0.0.1:${port}/via-request?x=1`, {
    method: 'POST',
    headers: { host: `127.0.0.1:${port}`, 'x-test': 'req-obj' },
    body: 'payload',
  });
  const res = await proxy.fetch(request);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'ok');

  assert.equal(seenMethod, 'POST');
  assert.equal(seenUrl, '/via-request?x=1');

  server.close();
  await local.close();
});

test('aborting via init.signal rejects the fetch', async () => {
  const sockets = new Set<import('node:net').Socket>();
  const { server, port } = await startOrigin(
    (req: IncomingMessage, res: ServerResponse) => {
      req.resume();
      setTimeout(() => {
        if (!res.writableEnded) {
          res.end('late');
        }
      }, 500);
    }
  );
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  const local = await startLocalProxyServer();
  const proxy = new FetchProxy({ proxyUrl: local.url, credentials: creds });

  const controller = new AbortController();
  const p = proxy.fetch(`http://127.0.0.1:${port}/slow`, {
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 20);

  await assert.rejects(p, (err: Error) => err.name === 'AbortError');

  for (const s of sockets) {
    s.destroy();
  }
  server.close();
  await local.close();
});
