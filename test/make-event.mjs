/*
 * Generate a Lambda Function URL (v2.0) event that wraps a real SigV4-signed
 * request in the proxy envelope, for `sam local invoke`.
 *
 * The signed request is produced exactly as the SDK requestHandler would, then
 * wrapped the same way ProxyRequestHandler wraps it. Writing the event to a
 * file lets us invoke the function in the REAL nodejs24.x runtime via SAM.
 *
 * Usage:
 *   tsx test/make-event.mjs > event.json
 *   tsx test/make-event.mjs my-bucket some/key > event.json
 */
import { Sha256 } from '@aws-crypto/sha256-js';
import { SignatureV4 } from '@aws-sdk/signature-v4';
import { HttpRequest } from '@smithy/protocol-http';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';

const REGION = process.env.AWS_REGION || 'us-east-1';
const [, , bucket, key] = process.argv;

const isGetObject = Boolean(bucket && key);
const host = isGetObject
  ? `${bucket}.s3.${REGION}.amazonaws.com`
  : `s3.${REGION}.amazonaws.com`;
const path = isGetObject ? `/${encodeURIComponent(key)}` : '/';
const query = isGetObject ? {} : { 'x-id': 'ListBuckets' };

const signer = new SignatureV4({
  service: 's3',
  region: REGION,
  credentials: fromNodeProviderChain(),
  sha256: Sha256,
});

const signed = await signer.sign(
  new HttpRequest({
    method: 'GET',
    protocol: 'https:',
    hostname: host,
    path,
    query,
    headers: {
      host,
      'x-amz-content-sha256':
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    },
  })
);

const signedPath =
  path +
  (Object.keys(query).length
    ? `?${new URLSearchParams(query).toString()}`
    : '');

const envelope = {
  __proxyEnvelope: true,
  path: signedPath,
  method: 'GET',
  headers: signed.headers,
  bodyIsBase64: true,
};

const event = {
  version: '2.0',
  routeKey: '$default',
  rawPath: '/',
  rawQueryString: '',
  headers: { 'content-type': 'application/json' },
  requestContext: { http: { method: 'POST', path: '/' } },
  body: JSON.stringify(envelope),
  isBase64Encoded: false,
};

process.stdout.write(JSON.stringify(event, null, 2));
