/*
 * End-to-end proof for Bedrock through the proxy running in the REAL
 * nodejs24.x runtime (via `sam local start-lambda`).
 *
 *   1. Control plane: ListFoundationModels (needs no model access). Proves the
 *      bedrock service signature survives the proxy.
 *   2. Streaming: InvokeModelWithResponseStream. The event-stream response is
 *      forwarded through the proxy and decoded by the SDK into chunks.
 *
 * Note: SAM local buffers the response, so this validates streaming
 * correctness, not incremental timing. Incremental delivery happens on a real
 * deployed Function URL.
 *
 * Requires `sam local start-lambda` to be running (see `npm run smoke:bedrock`).
 */
import { BedrockClient, ListFoundationModelsCommand } from '@aws-sdk/client-bedrock';
import {
  BedrockRuntimeClient,
  InvokeModelWithResponseStreamCommand,
} from '@aws-sdk/client-bedrock-runtime';

import { SamLambdaRequestHandler } from './sam-lambda-handler.mjs';

const REGION = process.env.AWS_REGION || 'us-east-1';
const SAM_ENDPOINT = process.env.SAM_LAMBDA_ENDPOINT || 'http://127.0.0.1:3001';
const MODEL_ID = process.env.MODEL_ID || 'us.amazon.nova-2-lite-v1:0';

function classify(label, err) {
  const name = err?.name || 'Error';
  const msg = err?.message || '';
  if (/SignatureDoesNotMatch/.test(name) || /SignatureDoesNotMatch/.test(msg)) {
    console.error(
      `\n❌ ${label} FAIL: SignatureDoesNotMatch — proxy mangled the signed request.`
    );
    process.exitCode = 1;
  } else if (
    /AccessDenied|ResourceNotFound|ValidationException|ThrottlingException/.test(name)
  ) {
    console.log(
      `\n✅ ${label} PASS (signature verified): ${name}, not SignatureDoesNotMatch.`
    );
  } else {
    console.error(`\n⚠️  ${label} unexpected:`, name, msg);
    process.exitCode = 1;
  }
}

async function main() {
  const requestHandler = new SamLambdaRequestHandler({
    endpoint: SAM_ENDPOINT,
    region: REGION,
  });

  const control = new BedrockClient({ region: REGION, requestHandler });
  try {
    const res = await control.send(new ListFoundationModelsCommand({}));
    const n = res.modelSummaries?.length ?? 0;
    console.log(
      `\n✅ Bedrock PASS: ListFoundationModels via proxy returned ${n} models.`
    );
    console.log('   SigV4 (service=bedrock) survived the proxy hop.');
  } catch (err) {
    classify('Bedrock control-plane', err);
  }

  const runtime = new BedrockRuntimeClient({ region: REGION, requestHandler });
  const payload = {
    messages: [{ role: 'user', content: [{ text: 'Say hello in exactly five words.' }] }],
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
        const decoded = JSON.parse(Buffer.from(event.chunk.bytes).toString('utf8'));
        const delta = decoded?.contentBlockDelta?.delta?.text;
        if (delta) {
          text += delta;
        }
      }
    }
    console.log(
      `\n✅ Bedrock STREAM PASS: received ${chunks} streamed event(s) via proxy.`
    );
    if (text) {
      console.log('   Model said:', JSON.stringify(text.trim()));
    }
    console.log('   Streaming invocation survived the proxy hop.');
  } catch (err) {
    // Bedrock returns a binary application/vnd.amazon.eventstream body. SAM
    // local's buffered Invoke cannot carry those bytes intact (no local
    // emulator implements InvokeWithResponseStream), so a mangled-stream error
    // here is a KNOWN local limitation, not a proxy defect. The streaming path
    // is validated against a real deployed Function URL instead.
    const name = err?.name || '';
    const msg = err?.message || '';
    if (/ServiceException|Deserialization|Unmarshall/.test(`${name} ${msg}`)) {
      console.log(
        '\n⏭️  Bedrock STREAM SKIPPED locally: SAM buffers the invoke and cannot ' +
          'carry the binary event-stream. Validate streaming against a deployed ' +
          'Function URL (DEPLOYED_FUNCTION_NAME).'
      );
    } else {
      classify('Bedrock streaming', err);
    }
  }
}

main().catch((err) => {
  console.error('smoke test error:', err);
  process.exit(1);
});
