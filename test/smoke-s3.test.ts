import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  S3Client,
  ListBucketsCommand,
  GetBucketLocationCommand,
  ListObjectsV2Command,
  HeadObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import type { S3ClientConfig } from '@aws-sdk/client-s3';
import { ProxyRequestHandler } from '../dist/proxy-request-handler.mjs';
import { createTargetFixture } from './proxy-target.ts';

/*
 * End-to-end proof against REAL AWS, read-only. A real S3Client signs each
 * request; the published ProxyRequestHandler SigV4-signs the outer POST and
 * runs it through the proxy (locally, the plain-node Function URL
 * RESPONSE_STREAM emulation), which forwards it verbatim to real S3 over HTTPS
 * and streams the raw response back.
 *
 * The flow is self-seeding and region-agnostic: each read discovers the input
 * for the next — ListBuckets -> GetBucketLocation -> ListObjectsV2 ->
 * HeadObject -> GetObject. No region is assumed anywhere; S3 tells us where a
 * bucket lives and we talk to it there. No writes, no setup. Objects are read
 * up to MAX_READ_BYTES (10 MB).
 *
 * This is a straight-line chain with HARD assertions at every step. Every call
 * must return a well-formed, successful response. There is NO error tolerance:
 * any thrown error — SignatureDoesNotMatch, a protocol/parse error from a
 * mangled body, AccessDenied, NoSuchKey, anything — propagates and fails the
 * test. No skips, no conditional early returns, no try/catch success paths. The
 * result is always a hard pass or fail.
 */
const MAX_READ_BYTES = 10 * 1024 * 1024; // 10 MB cap

const fixture = createTargetFixture();
before(() => fixture.before());
after(() => fixture.after());

function s3For(
  region: string,
  requestHandler: S3ClientConfig['requestHandler']
): S3Client {
  return new S3Client({ region, requestHandler });
}

/* Read a GetObject body stream, enforcing the 10 MB cap without buffering it all. */
async function readCapped(
  body: AsyncIterable<{ length: number }> & { destroy?: () => void },
  cap: number
): Promise<number> {
  let total = 0;
  for await (const chunk of body) {
    total += chunk.length;
    if (total >= cap) {
      if (typeof body.destroy === 'function') {
        body.destroy();
      }
      break;
    }
  }
  return total;
}

test('S3 read-only chain survives the proxy hop (real AWS)', async () => {
  // Inline, exactly as a consumer would: point ProxyRequestHandler at the URL.
  const requestHandler = new ProxyRequestHandler({
    proxyUrl: fixture.proxyUrl,
    region: fixture.region,
  });

  // ListBuckets is a global call; a client for the aws-global region needs no
  // regional assumption. us-east-1 here is just the global S3 endpoint, not a
  // guess about where the data lives.
  const global = s3For('us-east-1', requestHandler);

  // 1. ListBuckets — must return 200 and at least one bucket to drive the chain.
  const listed = await global.send(new ListBucketsCommand({}));
  assert.equal(
    listed.$metadata?.httpStatusCode,
    200,
    'expected HTTP 200 from ListBuckets'
  );
  const names = (listed.Buckets ?? [])
    .map((b) => b.Name)
    .filter((n): n is string => typeof n === 'string');
  assert.ok(names.length > 0, 'expected at least one bucket in the account');

  // 2. GetBucketLocation — locate the first bucket and bind a regional client.
  const bucket = names[0];
  const loc = await global.send(
    new GetBucketLocationCommand({ Bucket: bucket })
  );
  const region = loc.LocationConstraint ?? 'us-east-1';
  const s3 = s3For(region, requestHandler);

  // 3. ListObjectsV2 — there must be a non-empty object to read.
  const objects = await s3.send(
    new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 50 })
  );
  const obj = (objects.Contents ?? []).find((o) => (o.Size ?? 0) > 0);
  assert.ok(obj?.Key, `expected a non-empty object in bucket ${bucket}`);
  const key = obj.Key;
  const size = obj.Size ?? 0;

  // 4. HeadObject — metadata must come back with a numeric ContentLength.
  const head = await s3.send(
    new HeadObjectCommand({ Bucket: bucket, Key: key })
  );
  assert.equal(
    typeof head.ContentLength,
    'number',
    'expected a ContentLength from HeadObject'
  );

  // 5. GetObject — read the body, capped at 10 MB. Use a ranged request when
  //    the object is larger so we never pull more than the cap off the wire.
  const range =
    size > MAX_READ_BYTES ? `bytes=0-${MAX_READ_BYTES - 1}` : undefined;
  const got = await s3.send(
    new GetObjectCommand({ Bucket: bucket, Key: key, Range: range })
  );
  assert.ok(got.Body, 'expected a response body from GetObject');
  const read = await readCapped(
    got.Body as AsyncIterable<{ length: number }> & { destroy?: () => void },
    MAX_READ_BYTES
  );
  assert.ok(read > 0, 'expected to read at least one byte from the object');
  assert.ok(read <= MAX_READ_BYTES, 'must not read more than the 10 MB cap');
});
