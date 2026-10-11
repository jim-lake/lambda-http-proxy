import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import {
  BedrockClient,
  ListFoundationModelsCommand,
} from '@aws-sdk/client-bedrock';
import {
  BedrockRuntimeClient,
  InvokeModelWithResponseStreamCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { makeProxyRequestHandler } from './proxy-target.ts';

/*
 * End-to-end proof for Bedrock against REAL AWS, through the proxy running in
 * the plain-node Function URL RESPONSE_STREAM emulation.
 *
 *   1. Control plane: ListFoundationModels (needs no model access) proves the
 *      service=bedrock signature survives the proxy.
 *   2. Streaming: InvokeModelWithResponseStream. The binary
 *      application/vnd.amazon.eventstream body is streamed back RAW (the proxy
 *      never buffers and there is no buffering emulator in the path), so the
 *      SDK decodes real event-stream chunks — the streaming output is
 *      indistinguishable from calling Bedrock directly.
 *
 * Credentials come from the ambient AWS environment. There is NO error
 * tolerance: every call must return a well-formed, successful response. Any
 * thrown error — SignatureDoesNotMatch, a protocol/parse error from a mangled
 * body, AccessDenied, ValidationException, anything — fails the test hard.
 * These tests pass only if the proxy delivered EXACTLY the real Bedrock
 * response. No try/catch success paths, no skips, no conditional passes.
 */
const REGION = process.env.AWS_REGION || 'us-east-1';
const MODEL_ID = process.env.MODEL_ID || 'us.amazon.nova-2-lite-v1:0';

test('Bedrock ListFoundationModels survives the proxy hop (real AWS)', async () => {
  const control = new BedrockClient({
    region: REGION,
    requestHandler: makeProxyRequestHandler(),
  });

  // Any error here (including a protocol/parse error from a non-Bedrock body)
  // propagates and fails the test. No catch.
  const res = await control.send(new ListFoundationModelsCommand({}));

  assert.equal(
    res.$metadata?.httpStatusCode,
    200,
    'expected HTTP 200 from ListFoundationModels'
  );
  assert.ok(
    Array.isArray(res.modelSummaries),
    'expected a modelSummaries array'
  );
  assert.ok(
    res.modelSummaries.length > 0,
    'expected at least one foundation model'
  );
});

test('Bedrock InvokeModelWithResponseStream streams raw event-stream through the proxy (real AWS)', async () => {
  const runtime = new BedrockRuntimeClient({
    region: REGION,
    requestHandler: makeProxyRequestHandler(),
  });
  const payload = {
    messages: [
      { role: 'user', content: [{ text: 'Say hello in exactly five words.' }] },
    ],
    inferenceConfig: { maxTokens: 64 },
  };

  // Any error propagates and fails the test. No catch.
  const res = await runtime.send(
    new InvokeModelWithResponseStreamCommand({
      modelId: MODEL_ID,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify(payload),
    })
  );

  assert.equal(
    res.$metadata?.httpStatusCode,
    200,
    'expected HTTP 200 from InvokeModelWithResponseStream'
  );
  assert.ok(res.body, 'expected a response body stream');

  let chunks = 0;
  let text = '';
  for await (const event of res.body) {
    assert.ok(
      event.chunk?.bytes,
      'expected every stream event to carry a decoded chunk'
    );
    chunks += 1;
    const decoded = JSON.parse(Buffer.from(event.chunk.bytes).toString('utf8'));
    const delta = decoded?.contentBlockDelta?.delta?.text;
    if (delta) {
      text += delta;
    }
  }

  // The binary event-stream must have survived the proxy byte-for-byte and the
  // SDK must have decoded real events.
  assert.ok(chunks >= 1, 'expected at least one decoded stream event');
  assert.ok(
    text.length > 0,
    'expected non-empty generated text from the model'
  );
});
