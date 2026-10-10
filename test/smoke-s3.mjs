/*
 * End-to-end proof: a real S3Client signs, a requestHandler ships the signed
 * request through the proxy running in the REAL nodejs24.x runtime (via
 * `sam local start-lambda`), the proxy forwards it verbatim to real S3, and the
 * response comes back. A valid parse (or NoSuchKey/AccessDenied, not
 * SignatureDoesNotMatch) proves SigV4 survived the proxy hop.
 *
 * Requires `sam local start-lambda` to be running (see `npm run smoke:s3`).
 *
 * Usage:
 *   npm run smoke:s3                    # ListBuckets
 *   npm run smoke:s3 -- my-bucket key   # GetObject
 */
import {
  S3Client,
  ListBucketsCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';

import { SamLambdaRequestHandler } from './sam-lambda-handler.mjs';

const REGION = process.env.AWS_REGION || 'us-east-1';
const SAM_ENDPOINT = process.env.SAM_LAMBDA_ENDPOINT || 'http://127.0.0.1:3001';

const [, , bucket, key] = process.argv;

function classify(label, err) {
  const name = err?.name || 'Error';
  const msg = err?.message || '';
  if (/SignatureDoesNotMatch/.test(name) || /SignatureDoesNotMatch/.test(msg)) {
    console.error(
      `\n❌ ${label} FAIL: SignatureDoesNotMatch — proxy mangled the signed request.`
    );
    process.exitCode = 1;
  } else if (/AccessDenied|NoSuchKey|NoSuchBucket/.test(name)) {
    console.log(
      `\n✅ ${label} PASS (signature verified): ${name}, not SignatureDoesNotMatch.`
    );
  } else {
    console.error(`\n⚠️  ${label} unexpected:`, name, msg);
    process.exitCode = 1;
  }
}

async function main() {
  const client = new S3Client({
    region: REGION,
    requestHandler: new SamLambdaRequestHandler({
      endpoint: SAM_ENDPOINT,
      region: REGION,
    }),
  });

  try {
    if (bucket && key) {
      const res = await client.send(
        new GetObjectCommand({ Bucket: bucket, Key: key })
      );
      const text = await res.Body.transformToString();
      console.log(
        '\n✅ S3 PASS: GetObject via proxy. First 200 chars:\n',
        text.slice(0, 200)
      );
    } else {
      const res = await client.send(new ListBucketsCommand({}));
      const names = (res.Buckets ?? []).map((b) => b.Name);
      console.log(
        '\n✅ S3 PASS: ListBuckets via proxy. Buckets:',
        names.length,
        names.slice(0, 3)
      );
    }
    console.log('   SigV4 survived the proxy hop (real nodejs24.x runtime).');
  } catch (err) {
    classify('S3', err);
  }
}

main().catch((err) => {
  console.error('smoke test error:', err);
  process.exit(1);
});
