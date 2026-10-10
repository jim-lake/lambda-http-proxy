import { HttpResponse } from '@smithy/protocol-http';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { Readable } from 'node:stream';

/*
 * A requestHandler for tests that routes the signed request through the proxy
 * running in the REAL nodejs24.x runtime via `sam local start-lambda`.
 *
 * There is no homebrew runtime: the function executes in AWS's actual Lambda
 * emulation container. This handler wraps the signed request in the proxy
 * envelope, packages it as a Function URL (v2) event, and invokes the function
 * through SAM's local Lambda endpoint with the direct Invoke API.
 *
 * Note on streaming: no local emulator (SAM, RIE, LocalStack) implements the
 * InvokeWithResponseStream operation — they all buffer. So locally we use
 * direct Invoke and parse the buffered response-streaming payload (a JSON
 * metadata prelude + eight NUL bytes + body). True incremental streaming via
 * InvokeWithResponseStream only happens against a real deployed Function URL.
 *
 * Start the endpoint first:  sam local start-lambda --port 3001
 */
export class SamLambdaRequestHandler {
  constructor({
    endpoint = 'http://127.0.0.1:3001',
    functionName = 'ProxyFunction',
    region = 'us-east-1',
  } = {}) {
    this.functionName = functionName;
    this.lambda = new LambdaClient({
      endpoint,
      region,
      // SAM local needs no real auth; supply dummy static creds.
      credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
    });
  }

  async handle(request) {
    const signedPath =
      request.path + (request.query ? toQuery(request.query) : '');
    const signedBody = await collectBody(request.body);

    const envelope = {
      __proxyEnvelope: true,
      path: signedPath,
      method: request.method,
      headers: { ...request.headers },
      body: signedBody ? Buffer.from(signedBody).toString('base64') : undefined,
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

    const out = await this.lambda.send(
      new InvokeCommand({
        FunctionName: this.functionName,
        Payload: Buffer.from(JSON.stringify(event), 'utf8'),
      })
    );

    const payload = Buffer.from(out.Payload ?? new Uint8Array());
    const { statusCode, headers, body } = parseStreamingPayload(payload);

    return {
      response: new HttpResponse({
        statusCode,
        headers,
        body: Readable.from(body),
      }),
    };
  }
}

/*
 * The response-streaming payload is the JSON metadata prelude, then eight NUL
 * bytes, then the raw body. If no prelude is present, treat the whole payload
 * as the body with a 200 status.
 */
function parseStreamingPayload(payload) {
  const sep = Buffer.from([0, 0, 0, 0, 0, 0, 0, 0]);
  const idx = payload.indexOf(sep);
  if (idx === -1) {
    return { statusCode: 200, headers: {}, body: payload };
  }
  let meta = {};
  try {
    meta = JSON.parse(payload.subarray(0, idx).toString('utf8'));
  } catch {
    meta = {};
  }
  return {
    statusCode: meta.statusCode ?? 200,
    headers: flattenHeaders(meta.headers ?? {}),
    body: payload.subarray(idx + sep.length),
  };
}

function toQuery(query) {
  const parts = [];
  for (const [k, v] of Object.entries(query)) {
    if (v == null) {
      parts.push(encodeURIComponent(k));
    } else if (Array.isArray(v)) {
      for (const item of v) {
        parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(item)}`);
      }
    } else {
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
    }
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

function flattenHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = Array.isArray(v) ? v.join(', ') : String(v);
  }
  return out;
}

async function collectBody(body) {
  if (!body) {
    return undefined;
  }
  if (typeof body === 'string' || Buffer.isBuffer(body)) {
    return body;
  }
  const chunks = [];
  for await (const c of body) {
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}
