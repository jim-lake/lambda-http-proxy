import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { HttpRequest } from '@smithy/protocol-http';
import { SignatureV4 } from '@smithy/signature-v4';
import { Sha256 } from '@smithy/core/checksum';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { FetchProxy } from '../dist/fetch-proxy.js';
import { createTargetFixture } from './proxy-target.ts';

const REGION = process.env.AWS_REGION || 'us-east-1';
const BEDROCK_REGION = process.env.BEDROCK_REGION || REGION;
const MODEL_ID = process.env.MODEL_ID || 'us.amazon.nova-2-lite-v1:0';

const fixture = createTargetFixture();
before(() => fixture.before());
after(() => fixture.after());

async function signInner(args: {
  service: string;
  region: string;
  host: string;
  method: string;
  path: string;
  query?: Record<string, string>;
  body?: string;
}): Promise<{ url: string; headers: Record<string, string> }> {
  const signer = new SignatureV4({
    service: args.service,
    region: args.region,
    credentials: defaultProvider(),
    sha256: Sha256,
  });
  const request = new HttpRequest({
    method: args.method,
    protocol: 'https:',
    hostname: args.host,
    path: args.path,
    query: args.query,
    headers: {
      host: args.host,
      ...(args.body === undefined
        ? {}
        : { 'content-type': 'application/json' }),
    },
    body: args.body,
  });
  const signed = await signer.sign(request);

  const search = args.query
    ? `?${Object.entries(args.query)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&')}`
    : '';
  return {
    url: `https://${args.host}${args.path}${search}`,
    headers: signed.headers,
  };
}

test('FetchProxy carries a real S3 ListBuckets inner signature to real AWS', async () => {
  const proxy = new FetchProxy({
    proxyUrl: fixture.proxyUrl,
    region: fixture.region,
  });

  const { url, headers } = await signInner({
    service: 's3',
    region: 'us-east-1',
    host: 's3.us-east-1.amazonaws.com',
    method: 'GET',
    path: '/',
  });

  const res = await proxy.fetch(url, { method: 'GET', headers });
  const text = await res.text();

  assert.notEqual(
    res.status,
    403,
    `inner signature did not survive the proxy: ${text.slice(0, 400)}`
  );
  assert.equal(
    res.status,
    200,
    `expected 200 from ListBuckets, got ${res.status}`
  );
  assert.match(text, /ListAllMyBucketsResult/);
});

test('FetchProxy carries a real Bedrock ListFoundationModels inner signature to real AWS', async () => {
  const proxy = new FetchProxy({
    proxyUrl: fixture.proxyUrl,
    region: fixture.region,
  });

  const host = `bedrock.${BEDROCK_REGION}.amazonaws.com`;
  const { url, headers } = await signInner({
    service: 'bedrock',
    region: BEDROCK_REGION,
    host,
    method: 'GET',
    path: '/foundation-models',
  });

  const res = await proxy.fetch(url, { method: 'GET', headers });
  const text = await res.text();

  assert.notEqual(
    res.status,
    403,
    `inner signature did not survive the proxy: ${text.slice(0, 400)}`
  );
  assert.equal(
    res.status,
    200,
    `expected 200 from ListFoundationModels, got ${res.status}: ${text.slice(0, 400)}`
  );
  const parsed = JSON.parse(text) as { modelSummaries?: unknown[] };
  assert.ok(
    Array.isArray(parsed.modelSummaries) && parsed.modelSummaries.length > 0,
    'expected a non-empty modelSummaries array from real Bedrock'
  );
});

test('FetchProxy streams a real Bedrock event-stream body incrementally via a WHATWG ReadableStream', async () => {
  const proxy = new FetchProxy({
    proxyUrl: fixture.proxyUrl,
    region: fixture.region,
  });

  const host = `bedrock-runtime.${BEDROCK_REGION}.amazonaws.com`;
  const payload = JSON.stringify({
    messages: [
      { role: 'user', content: [{ text: 'Say hello in exactly five words.' }] },
    ],
    inferenceConfig: { maxTokens: 64 },
  });
  const { url, headers } = await signInner({
    service: 'bedrock',
    region: BEDROCK_REGION,
    host,
    method: 'POST',
    path: `/model/${encodeURIComponent(MODEL_ID)}/invoke-with-response-stream`,
    body: payload,
  });

  const res = await proxy.fetch(url, {
    method: 'POST',
    headers,
    body: payload,
  });

  assert.notEqual(
    res.status,
    403,
    'inner signature did not survive the proxy for the streaming call'
  );
  assert.equal(
    res.status,
    200,
    `expected 200 from InvokeModelWithResponseStream, got ${res.status}`
  );
  assert.match(
    res.headers.get('content-type') ?? '',
    /vnd\.amazon\.eventstream/
  );
  assert.ok(res.body, 'expected a streaming ReadableStream body');

  const reader = res.body.getReader();
  let chunks = 0;
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks += 1;
    total += value.byteLength;
  }
  assert.ok(chunks >= 1, 'expected at least one streamed chunk');
  assert.ok(
    total > 0,
    'expected non-empty event-stream bytes from real Bedrock'
  );
});
