import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  S3Client,
  ListBucketsCommand,
  GetBucketLocationCommand,
  ListObjectsV2Command,
  HeadObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { makeProxyRequestHandler } from './proxy-target.ts';

/*
 * End-to-end proof against REAL AWS, read-only. A real S3Client signs each
 * request; ProxyFunctionUrlRequestHandler wraps it in the proxy envelope and
 * runs it through the proxy (the plain-node Function URL RESPONSE_STREAM
 * emulation), which forwards it verbatim to real S3 over HTTPS and streams the
 * raw response back.
 *
 * The flow is self-seeding and region-agnostic: each read discovers the input
 * for the next — ListBuckets -> GetBucketLocation -> ListObjectsV2 ->
 * HeadObject -> GetObject. No region is assumed anywhere; S3 tells us where a
 * bucket lives and we talk to it there. No writes, no setup. Objects are read
 * up to MAX_READ_BYTES (10 MB).
 *
 * This is a straight-line chain with HARD assertions at every step. The primary
 * invariant is SigV4 survival across the proxy hop (a SignatureDoesNotMatch is
 * called out explicitly), but every step must also actually succeed: no
 * readable bucket, no readable object, a failing HeadObject, or an unreadable
 * body each FAIL the test. There are no skips and no conditional early returns —
 * the result is always a hard pass or fail.
 */
const MAX_READ_BYTES = 10 * 1024 * 1024; // 10 MB cap

function s3For(region: string): S3Client {
  return new S3Client({ region, requestHandler: makeProxyRequestHandler() });
}

interface AwsError {
  name?: string;
  message?: string;
}

/*
 * Run an S3 call. If S3 rejects it with SignatureDoesNotMatch, the proxy
 * mangled the signed request — fail loudly. Any other error is rethrown as-is
 * so the straight-line chain fails on it too (an unreadable step is a failure,
 * never a skip).
 */
async function send<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    const e = err as AwsError;
    const name = e?.name ?? 'Error';
    const msg = e?.message ?? '';
    assert.ok(
      !`${name} ${msg}`.includes('SignatureDoesNotMatch'),
      `SignatureDoesNotMatch — proxy mangled the signed request: ${name} ${msg}`
    );
    throw err;
  }
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
  // ListBuckets is a global call; a client for the aws-global region needs no
  // regional assumption. us-east-1 here is just the global S3 endpoint, not a
  // guess about where the data lives.
  const global = s3For('us-east-1');

  // 1. ListBuckets — there must be at least one bucket to drive the chain.
  const listed = await send(() => global.send(new ListBucketsCommand({})));
  const names = (listed.Buckets ?? [])
    .map((b) => b.Name)
    .filter((n): n is string => typeof n === 'string');
  assert.ok(names.length > 0, 'expected at least one bucket in the account');

  // 2. GetBucketLocation — locate the first bucket and bind a regional client.
  const bucket = names[0];
  const loc = await send(() =>
    global.send(new GetBucketLocationCommand({ Bucket: bucket }))
  );
  const region = loc.LocationConstraint ?? 'us-east-1';
  const s3 = s3For(region);

  // 3. ListObjectsV2 — there must be a non-empty object to read.
  const objects = await send(() =>
    s3.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 50 }))
  );
  const obj = (objects.Contents ?? []).find((o) => (o.Size ?? 0) > 0);
  assert.ok(obj?.Key, `expected a non-empty object in bucket ${bucket}`);
  const key = obj.Key;
  const size = obj.Size ?? 0;

  // 4. HeadObject — metadata must come back with a numeric ContentLength.
  const head = await send(() =>
    s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
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
  const got = await send(() =>
    s3.send(new GetObjectCommand({ Bucket: bucket, Key: key, Range: range }))
  );
  assert.ok(got.Body, 'expected a response body from GetObject');
  const read = await readCapped(
    got.Body as AsyncIterable<{ length: number }> & { destroy?: () => void },
    MAX_READ_BYTES
  );
  assert.ok(read > 0, 'expected to read at least one byte from the object');
  assert.ok(read <= MAX_READ_BYTES, 'must not read more than the 10 MB cap');
});
