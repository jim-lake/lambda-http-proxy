# lambda-http-proxy

A streaming HTTP proxy that runs on AWS Lambda. It forwards **SigV4-signed AWS
requests verbatim** to their real target and **streams the response back** to
the caller, so the signature verifies at the upstream exactly as if the client
had called the service directly.

The expected use case is a **Lambda Function URL invoked in response-streaming
mode** (`InvokeMode: RESPONSE_STREAM`). You send the proxy a small **wrapped
request object** (the signed request in a JSON envelope) and the proxy streams
back a response that is **indistinguishable from the raw upstream response** —
same status, same headers, same body bytes. A consumer can pipe that response
straight to whatever is downstream without rewriting anything.

```
caller ──wrapped request (envelope)──▶ Function URL (RESPONSE_STREAM)
                                              │ unwraps + forwards verbatim
                                              ▼
                                        real AWS service
                                              │ streams response
   raw upstream response ◀────────────────────┘   (status + headers + body,
   (pipe straight downstream)                       byte-for-byte, never buffered)
```

- **Input: a wrapped request object.** The signed request (exact path, method,
  headers, body) rides inside a JSON envelope. Wrapping is required so the
  signed path survives the Function URL hop and the signed content-length never
  collides with the envelope's own content-length (details below).
- **Output: the raw upstream response.** The proxy conveys the upstream's status
  code and headers through the response-streaming metadata prelude (which a
  deployed Function URL turns into real HTTP status + headers at the edge) and
  pipes the body through untouched. Nothing SDK-specific is added to the body;
  binary bodies (e.g. Bedrock's `application/vnd.amazon.eventstream`) pass
  through byte-for-byte.

The most convenient way to produce the wrapped request is the included
**`requestHandler`** for any AWS SDK v3 client. The SDK signs the request as
usual; the handler wraps that signed request and sends it to the proxy; the
proxy forwards it to the real host (S3, Bedrock, DynamoDB, …) and streams the
response straight back.

```
AWS SDK client ──signs──▶ ProxyRequestHandler ──POST envelope──▶ Lambda proxy
                                                                     │ forwards verbatim
                                                                     ▼
                                                              real AWS service
                                                                     │ streams response
   SDK parses response ◀──────────────────────────────────────────┘
```

Because the proxy never alters the signed path, headers, or body, SigV4
verification passes unchanged. The response is piped (never buffered) end to
end — the Function URL runs in `RESPONSE_STREAM` invoke mode.

## Primary use case: AWS SDK `requestHandler`

Install the proxy's request handler alongside your SDK clients and point it at
your deployed Function URL. Everything else about your SDK usage stays the same.

```js
import { S3Client, ListBucketsCommand } from '@aws-sdk/client-s3';
import { ProxyRequestHandler } from 'lambda-http-proxy/proxy-request-handler.mjs';

// The HTTPS Function URL of your deployed proxy.
const PROXY_URL = 'https://<id>.lambda-url.<region>.on.aws/';

const s3 = new S3Client({
  region: 'us-east-1',
  requestHandler: new ProxyRequestHandler({ proxyUrl: PROXY_URL }),
});

// Use the client exactly as normal — the request is signed by the SDK, routed
// through the proxy, forwarded to S3, and the response is streamed back.
const res = await s3.send(new ListBucketsCommand({}));
console.log(res.Buckets?.map((b) => b.Name));
```

The same handler works for any SigV4 service. Here it is with Bedrock,
including a **streaming** model invocation (the proxy streams the event-stream
chunks straight through):

```js
import {
  BedrockRuntimeClient,
  InvokeModelWithResponseStreamCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { ProxyRequestHandler } from 'lambda-http-proxy/proxy-request-handler.mjs';

const bedrock = new BedrockRuntimeClient({
  region: 'us-east-1',
  requestHandler: new ProxyRequestHandler({ proxyUrl: PROXY_URL }),
});

const res = await bedrock.send(
  new InvokeModelWithResponseStreamCommand({
    modelId: 'us.amazon.nova-2-lite-v1:0',
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify({
      messages: [
        { role: 'user', content: [{ text: 'Say hello in five words.' }] },
      ],
      inferenceConfig: { maxTokens: 64 },
    }),
  })
);

for await (const event of res.body) {
  if (event.chunk?.bytes) {
    const decoded = JSON.parse(Buffer.from(event.chunk.bytes).toString('utf8'));
    const delta = decoded?.contentBlockDelta?.delta?.text;
    if (delta) process.stdout.write(delta);
  }
}
```

### Constructing the handler

```js
// Production: point at the deployed HTTPS Function URL.
new ProxyRequestHandler({
  proxyUrl: 'https://<id>.lambda-url.<region>.on.aws/',
});

// Local testing: point at a local proxy over plain HTTP.
new ProxyRequestHandler({ proxyHost: '127.0.0.1', proxyPort: 3000 });
```

### How it works

`ProxyRequestHandler.handle(request)` receives the request **after** the SDK's
SigV4 middleware has signed it. It wraps the whole signed request — exact path
(including encoding such as Bedrock's `%3A`), method, headers, and body — in a
JSON envelope and POSTs it to the proxy as `application/json`.

Wrapping in an envelope matters for two reasons:

- **The signed path survives.** A Lambda Function URL re-encodes `rawPath`,
  which would corrupt paths that were signed with specific percent-encoding and
  break the signature. The envelope carries the exact signed path.
- **Content-length never collides.** The outer POST has its own
  `content-length` (the envelope size); the signed `content-length` rides inside
  the envelope headers and is forwarded to the upstream unchanged.

The proxy unwraps the envelope and forwards the signed request verbatim. It
strips only hop-by-hop headers and headers the Function URL itself injects
(`x-amzn-trace-id`, `x-forwarded-*`, `cloudfront-*`, `x-amz-cf-id`, `via`). All
signed headers — including `authorization`, `x-amz-date`,
`x-amz-content-sha256`, `x-amz-security-token`, `host`, and service headers like
`x-amzn-bedrock-*` — pass through untouched.

On the way back, the proxy conveys the upstream status code and headers through
the response-streaming metadata prelude and pipes the upstream body through
untouched (never buffered). On a deployed Function URL the AWS edge turns that
prelude into the real HTTP status line + headers, so the caller receives a
response **indistinguishable from calling the upstream directly** — same status,
same headers, same body bytes. Binary bodies pass through byte-for-byte.

> The proxy expects callers to use this envelope format. Point your SDK clients
> at it via `ProxyRequestHandler` rather than sending a raw signed request
> directly.

## Deploy

Response streaming is the **only** supported mode. The Function URL is created
with `InvokeMode: RESPONSE_STREAM` and `AuthType: AWS_IAM`.

```bash
ROLE_ARN=arn:aws:iam::<account>:role/<lambda-exec-role> \
AWS_REGION=us-east-1 \
./scripts/deploy.sh
```

This builds the artifact with the AWS CLI only, zips just
`dist/lambda-http-proxy.mjs` (no `node_modules` — the SDK is runtime-provided),
and configures the Function URL with `RESPONSE_STREAM`. Runtime is `nodejs24.x`;
the handler name is `lambda-http-proxy.handler`.

Because the Function URL uses `AWS_IAM` auth, callers need
`lambda:InvokeFunctionUrl` permission on the function. (You can combine this with
the SDK `requestHandler` above — the inner request is still SigV4-signed for the
target service.)

## Build

The source is TypeScript; the build produces a single ESM artifact with
Rollup + esbuild. The AWS SDK is marked **external** (provided by the managed
runtime), so the artifact stays tiny.

```bash
npm run build        # typecheck + emit .d.ts + bundle → dist/lambda-http-proxy.mjs
```

The runtime-provided SDK version is pinned in `package.json` under
`lambdaRuntime.providedSdkVersion` and treated as external in
`rollup.config.mjs`.

## Test

Everything runs with **plain Node** — no SAM, RIE, LocalStack, or Docker. Three
separate commands make up the gate; all must be green:

```bash
npm run ts:check      # tsc --noEmit (type-check only)
npm run lint          # eslint src --fix (strict, src only)
npm test              # build + ALL tests (incl. real AWS)
```

`npm test` builds the artifact and then runs `tsx --test "test/**/*.test.mjs"`
— every test file, including the real-AWS S3 and Bedrock end-to-end tests. Use
`npm run test:only` to run the tests without rebuilding. The real-AWS tests use
the ambient AWS credentials on the box; no setup is required.

### Plain-node Function URL emulation (the output contract)

`test/function-url-runtime.mjs` emulates a Function URL running in
`RESPONSE_STREAM` mode using **only plain Node**. It installs a faithful
`globalThis.awslambda` shim (`streamifyResponse` + `HttpResponseStream.from`)
that produces the exact response-streaming wire format (JSON metadata prelude +
eight NUL bytes + body), then plays the role of the AWS edge: it strips the
prelude and hands you a raw, upstream-equivalent response.

```js
import {
  invokeFunctionUrl,
  makeEnvelopeEvent,
  collect,
} from './test/function-url-runtime.mjs';

const event = makeEnvelopeEvent({
  path: '/my-bucket/object.txt?x-id=GetObject',
  method: 'GET',
  headers: { host: 's3.us-east-1.amazonaws.com' },
});

const { statusCode, headers, body } = await invokeFunctionUrl(event);
// `body` is a Readable you can pipe straight downstream — byte-for-byte the
// upstream body. `statusCode` and `headers` mirror the upstream exactly.
```

`test/function-url.test.mjs` uses this harness to assert the proxy output is
indistinguishable from the upstream: status, headers, binary body integrity,
and incremental (non-buffered) delivery.

### Real-AWS end-to-end tests

`test/smoke-s3.test.mjs` and `test/smoke-bedrock.test.mjs` use the included
`ProxyFunctionUrlRequestHandler`: a real SDK client signs the request, the
handler wraps it in the proxy envelope and runs it through the plain-node
Function URL emulation, which forwards it verbatim to **real AWS over HTTPS**
and streams the raw response back. A `SignatureDoesNotMatch` is the only hard
failure (the proxy mangled the request); a valid response — or a
post-verification error like `AccessDenied`/`NoSuchKey` — proves signing
survived. Because the body is streamed back raw, Bedrock's binary
`application/vnd.amazon.eventstream` response is decoded by the SDK intact,
validating true streaming without any buffering emulator.

## Project layout

```
src/index.ts                      # proxy handler (TypeScript, single file)
dist/lambda-http-proxy.mjs        # built artifact (Lambda handler)
scripts/proxy-request-handler.mjs # ProxyRequestHandler — the SDK requestHandler (published entry)
scripts/deploy.sh                 # AWS CLI deploy (RESPONSE_STREAM only)
test/proxy.test.mjs               # unit tests for proxy() internals (node:test)
test/function-url.test.mjs        # output-contract tests via the plain-node runtime
test/function-url-runtime.mjs     # plain-node RESPONSE_STREAM Function URL emulator + SDK requestHandler
test/smoke-s3.test.mjs            # S3 end-to-end proof against real AWS
test/smoke-bedrock.test.mjs       # Bedrock end-to-end proof against real AWS (incl. streaming)
```
