/* Shared, typed test helpers. */
import http from 'node:http';
import { Buffer } from 'node:buffer';
import { PassThrough } from 'node:stream';
import type { Readable } from 'node:stream';
import type { AddressInfo } from 'node:net';
import type { ResponseMetadata } from '../dist/lambda-outbound-proxy.mjs';

export interface Origin {
  server: http.Server;
  port: number;
}

/*
 * Spin up a throwaway origin server. The handler records what it received so a
 * test can assert the proxy forwarded it byte-for-byte — the crux of SigV4
 * survival: the bytes the origin sees must match what was signed.
 */
export function startOrigin(handler: http.RequestListener): Promise<Origin> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, port });
    });
  });
}

export interface CapturedResponse {
  body: string;
  meta?: ResponseMetadata;
}

/*
 * Collect a PassThrough's bytes + metadata as if we were the Function URL edge.
 * The proxy's non-runtime fallback emits the real response-streaming wire
 * format (JSON prelude + 8 NUL bytes + body), identical to a deployed
 * RESPONSE_STREAM Function URL. We de-prelude here so `body` is the raw upstream
 * body — byte-for-byte what the caller would pipe downstream.
 */
export function captureStream(): {
  stream: PassThrough & { __meta?: ResponseMetadata };
  done: Promise<CapturedResponse>;
} {
  const stream = new PassThrough() as PassThrough & {
    __meta?: ResponseMetadata;
  };
  const chunks: Buffer[] = [];
  stream.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<CapturedResponse>((resolve) => {
    stream.on('end', () => {
      const all = Buffer.concat(chunks);
      const sep = Buffer.alloc(8);
      const idx = all.indexOf(sep);
      if (idx === -1) {
        resolve({ body: all.toString('utf8'), meta: stream.__meta });
        return;
      }
      let meta: ResponseMetadata | undefined;
      try {
        meta = JSON.parse(
          all.subarray(0, idx).toString('utf8')
        ) as ResponseMetadata;
      } catch {
        meta = stream.__meta;
      }
      resolve({
        body: all.subarray(idx + sep.length).toString('utf8'),
        meta: meta ?? stream.__meta,
      });
    });
  });
  return { stream, done };
}

/* Collect a Readable to a Buffer. */
export async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) {
    chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as string));
  }
  return Buffer.concat(chunks);
}
