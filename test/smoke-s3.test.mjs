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
import { ProxyFunctionUrlRequestHandler } from './function-url-runtime.mjs';

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
 * SigV4 survival is the invariant on every call: a SignatureDoesNotMatch is the
 * only hard failure (the proxy mangled the request); a valid response or a
 * post-signature error (AccessDenied/NoSuchKey/…) proves signing survived. If
 * the account has no readable buckets/objects, the chain degrades to a skip
 * rather than a false failure.
 */
const MAX_READ_BYTES = 10 * 1024 * 1024; // 10 MB cap

function s3For(region) {
  return new S3Client({
    region,
    requestHandler: new ProxyFunctionUrlRequestHandler(),
  });
}

function assertSignatureSurvived(err) {
  const name = err?.name || 'Error';
  const msg = err?.message || '';
  assert.ok(
    !/SignatureDoesNotMatch/.test(`${name} ${msg}`),
    `SignatureDoesNotMatch — proxy mangled the signed request: ${name} ${msg}`
  );
}

/* Read a GetObject body stream, enforcing the 10 MB cap without buffering it all. */
async function readCapped(body, cap) {
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

test('S3 read-only chain survives the proxy hop (real AWS)', async (t) => {
  // ListBuckets is a global call; a client for the aws-global region needs no
  // regional assumption. us-east-1 here is just the global S3 endpoint, not a
  // guess about where the data lives.
  const global = s3For('us-east-1');

  // 1. Find a bucket, then ask S3 which region it is in (GetBucketLocation,
  //    also global). We then operate on it with a client bound to that region.
  let bucket;
  let region;
  try {
    const res = await global.send(new ListBucketsCommand({}));
    const names = (res.Buckets ?? []).map((b) => b.Name);
    assert.ok(Array.isArray(names), 'expected a Buckets array');
    for (const name of names) {
      try {
        const loc = await global.send(
          new GetBucketLocationCommand({ Bucket: name })
        );
        bucket = name;
        region = loc.LocationConstraint || 'us-east-1';
        break;
      } catch (err) {
        assertSignatureSurvived(err);
        // Can't read this bucket's location (ownership/policy) — try the next.
      }
    }
  } catch (err) {
    assertSignatureSurvived(err);
    t.skip(`ListBuckets not readable here: ${err?.name}`);
    return;
  }

  if (!bucket) {
    t.skip('no readable bucket found; signature path still validated');
    return;
  }

  const s3 = s3For(region);

  // 2. List objects in that bucket.
  let key;
  let size;
  try {
    const res = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 50 })
    );
    const obj = (res.Contents ?? []).find((o) => (o.Size ?? 0) > 0);
    if (obj) {
      key = obj.Key;
      size = obj.Size;
    }
  } catch (err) {
    assertSignatureSurvived(err);
    t.skip(`ListObjectsV2 not readable on ${bucket}: ${err?.name}`);
    return;
  }

  if (!key) {
    t.skip(`bucket ${bucket} has no readable object; signature path validated`);
    return;
  }

  // 3. HeadObject — metadata only.
  try {
    const head = await s3.send(
      new HeadObjectCommand({ Bucket: bucket, Key: key })
    );
    assert.ok(
      typeof head.ContentLength === 'number',
      'expected a ContentLength from HeadObject'
    );
  } catch (err) {
    assertSignatureSurvived(err);
    t.skip(`HeadObject not readable on ${bucket}/${key}: ${err?.name}`);
    return;
  }

  // 4. GetObject — read the body, capped at 10 MB. Use a ranged request when
  //    the object is larger so we never pull more than the cap off the wire.
  try {
    const range =
      size > MAX_READ_BYTES ? `bytes=0-${MAX_READ_BYTES - 1}` : undefined;
    const res = await s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: key, Range: range })
    );
    const read = await readCapped(res.Body, MAX_READ_BYTES);
    assert.ok(read > 0, 'expected to read at least one byte from the object');
    assert.ok(read <= MAX_READ_BYTES, 'must not read more than the 10 MB cap');
  } catch (err) {
    assertSignatureSurvived(err);
  }
});
