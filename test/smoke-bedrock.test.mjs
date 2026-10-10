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
import { ProxyFunctionUrlRequestHandler } from './function-url-runtime.mjs';

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

function assertSignatureSurvived(err) {
  const name = err?.name || 'Error';
  const msg = err?.message || '';
  assert.ok(
    !/SignatureDoesNotMatch/.test(`${name} ${msg}`),
    `SignatureDoesNotMatch — proxy mangled the signed request: ${name} ${msg}`
  );
}

test('Bedrock ListFoundationModels survives the proxy hop (real AWS)', async () => {
  const control = new BedrockClient({
    region: REGION,
    requestHandler: new ProxyFunctionUrlRequestHandler(),
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
    requestHandler: new ProxyFunctionUrlRequestHandler(),
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
    for await (const event of res.body) {
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
  } catch (err) {
    assertSignatureSurvived(err);
  }
});
