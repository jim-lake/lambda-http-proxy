# lambda-http-proxy

A streaming HTTP proxy that runs on AWS Lambda. It forwards **SigV4-signed AWS
requests verbatim** to their real target and **streams the response back** to
the caller, so the signature verifies at the upstream exactly as if the client
had called the service directly.

The primary way to use it is as a custom **`requestHandler`** on any AWS SDK v3
client. The SDK signs the request as usual; the handler ships that signed
request to the proxy; the proxy forwards it to the real host (S3, Bedrock,
DynamoDB, …) and streams the response straight back through the SDK.

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

> The proxy expects callers to use this envelope format. Point your SDK clients
> at it via `ProxyRequestHandler` rather than sending a raw signed request
> directly.

## Deploy

Response streaming is the **only** supported mode. The Function URL is created
with `InvokeMode: RESPONSE_STREAM` and `AuthType: AWS_IAM`.

### SAM

```bash
sam build
sam deploy --guided
```

See `template.yaml`. Runtime is `nodejs24.x`; the handler is the bundled
artifact `dist/lambda-http-proxy.mjs` (handler name `lambda-http-proxy.handler`).

### AWS CLI (no SAM)

```bash
ROLE_ARN=arn:aws:iam::<account>:role/<lambda-exec-role> \
AWS_REGION=us-east-1 \
./scripts/deploy.sh
```

This builds the artifact, zips only `dist/lambda-http-proxy.mjs`, and configures
the Function URL with `RESPONSE_STREAM`.

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

```bash
npm test             # build, then run unit tests
npm run local        # start the local Lambda streaming runtime on :3000
npm run smoke:s3     # sign a real S3 request and send it through the proxy
npm run smoke:bedrock # control-plane + streaming Bedrock requests through the proxy
```

The smoke tests use `ProxyRequestHandler` against a local instance of the proxy
and talk to real AWS, proving the signature survives the proxy hop. A
`SignatureDoesNotMatch` failure would mean the request was mangled; a valid
response (or a post-verification error like `AccessDenied`/`NoSuchKey`) means
signing survived.

## Project layout

```
src/index.ts                      # proxy handler (TypeScript, single file)
dist/lambda-http-proxy.mjs        # built artifact (Lambda handler)
scripts/proxy-request-handler.mjs # ProxyRequestHandler — the SDK requestHandler (published entry)
scripts/deploy.sh                 # AWS CLI deploy (RESPONSE_STREAM only)
test/proxy.test.mjs               # unit tests (node --test)
test/local-server.mjs             # local Lambda streaming runtime emulator
test/smoke-s3.mjs                 # S3 end-to-end proof
test/smoke-bedrock.mjs            # Bedrock end-to-end proof (incl. streaming)
template.yaml                     # SAM template (RESPONSE_STREAM only)
```
