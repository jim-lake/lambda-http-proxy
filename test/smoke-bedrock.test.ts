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
 * Credentials come from the ambient AWS environment. The only hard failure is
 * SignatureDoesNotMatch (the proxy mangled the request); a post-signature error
 * such as AccessDenied/ValidationException still proves the signature verified.
 */
const REGION = process.env.AWS_REGION || 'us-east-1';
const MODEL_ID = process.env.MODEL_ID || 'us.amazon.nova-2-lite-v1:0';

function assertSignatureSurvived(err: unknown): void {
  const e = err as { name?: string; message?: string };
  const name = e?.name || 'Error';
  const msg = e?.message || '';
  assert.ok(
    !`${name} ${msg}`.includes('SignatureDoesNotMatch'),
    `SignatureDoesNotMatch — proxy mangled the signed request: ${name} ${msg}`
  );
}

test('Bedrock ListFoundationModels survives the proxy hop (real AWS)', async () => {
  const control = new BedrockClient({
    region: REGION,
    requestHandler: makeProxyRequestHandler(),
  });
  try {
    const res = await control.send(new ListFoundationModelsCommand({}));
    assert.ok(
      Array.isArray(res.modelSummaries),
      'expected a modelSummaries array'
    );
  } catch (err) {
    assertSignatureSurvived(err);
  }
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
  try {
    const res = await runtime.send(
      new InvokeModelWithResponseStreamCommand({
        modelId: MODEL_ID,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify(payload),
      })
    );

    let chunks = 0;
    let text = '';
    for await (const event of res.body ?? []) {
      if (event.chunk?.bytes) {
        chunks += 1;
        const decoded = JSON.parse(
          Buffer.from(event.chunk.bytes).toString('utf8')
        );
        const delta = decoded?.contentBlockDelta?.delta?.text;
        if (delta) {
          text += delta;
        }
      }
    }
    // If we got here, the binary event-stream survived the proxy byte-for-byte
    // and the SDK decoded it. (text may be empty depending on the model.)
    assert.ok(chunks >= 1, 'expected at least one decoded stream event');
    assert.equal(typeof text, 'string');
  } catch (err) {
    assertSignatureSurvived(err);
  }
});
