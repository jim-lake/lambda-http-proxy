# lambda-outbound-proxy

A streaming HTTP proxy that runs on AWS Lambda. It forwards **SigV4-signed AWS
requests verbatim** to their real target and **streams the response back**, so
the signature verifies at the upstream exactly as if you'd called the service
directly. The response you get back is **indistinguishable from the raw upstream
response** — same status, same headers, same body bytes, never buffered.

It deploys as a **Lambda Function URL in response-streaming mode**
(`InvokeMode: RESPONSE_STREAM`, `AuthType: AWS_IAM`).

## The Lambda signs nothing and runs with NO privileges

**This is the single most important thing to understand about the proxy.**

- **The Lambda DOES NOT sign anything.** It has no AWS SDK, imports no SigV4
  code, and makes no signed calls. It receives the caller's **already-signed**
  request and forwards those exact bytes to the upstream verbatim. All signing
  happens on the **client** side (the SDK signs the inner request; the included
  `ProxyRequestHandler` signs the outer POST). The Lambda is a dumb pipe.
- **The Lambda runs with NO privileges.** Its execution role needs **zero** AWS
  permissions — no S3, no Bedrock, no access to any upstream service, nothing
  beyond basic Lambda execution (writing its own CloudWatch Logs). It never
  calls any AWS service _as itself_, so it never needs permission to. Give it an
  empty/minimal execution role. **Never** attach upstream-service permissions to
  it.

Because the Lambda holds no credentials and signs nothing, it can never act as a
confused deputy. The upstream only ever sees requests the **caller** signed with
the **caller's** identity. The two signatures in play are:

1. **Inner request** — signed by the caller's SDK for the target service (S3,
   Bedrock, …). The Lambda relays it untouched.
2. **Outer POST to the Function URL** — signed by `ProxyRequestHandler` for the
   `lambda` service. IAM on the URL (`AuthType: AWS_IAM`) verifies this before
   the handler ever runs, and it is the **only** thing gating who may use the
   proxy. Deploying with `AuthType: NONE` removes that gate and turns the proxy
   into an open relay — don't.

## Install

```bash
npm install lambda-outbound-proxy
```

## Usage

Add the included `ProxyRequestHandler` to any AWS SDK v3 client and point it at
your deployed Function URL. Everything else about your SDK usage stays the same
— the SDK signs the request, the handler routes it through the proxy, and the
response streams straight back.

```js
import { S3Client, ListBucketsCommand } from '@aws-sdk/client-s3';
import { ProxyRequestHandler } from 'lambda-outbound-proxy/proxy-request-handler.mjs';

const s3 = new S3Client({
  region: 'us-east-1',
  requestHandler: new ProxyRequestHandler({
    proxyUrl: 'https://<id>.lambda-url.<region>.on.aws/',
  }),
});

const res = await s3.send(new ListBucketsCommand({}));
console.log(res.Buckets?.map((b) => b.Name));
```

The same handler works for any SigV4 service. Streaming responses stream through
untouched — here with Bedrock:

```js
import {
  BedrockRuntimeClient,
  InvokeModelWithResponseStreamCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { ProxyRequestHandler } from 'lambda-outbound-proxy/proxy-request-handler.mjs';

const bedrock = new BedrockRuntimeClient({
  region: 'us-east-1',
  requestHandler: new ProxyRequestHandler({
    proxyUrl: 'https://<id>.lambda-url.<region>.on.aws/',
  }),
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
// The HTTPS Function URL of your deployed proxy.
new ProxyRequestHandler({
  proxyUrl: 'https://<id>.lambda-url.<region>.on.aws/',
});

// Optionally override the region used to sign the outer POST (defaults to the
// region parsed from the Function URL host) and/or the credentials (defaults
// to the AWS default provider chain).
new ProxyRequestHandler({
  proxyUrl: 'https://<id>.lambda-url.<region>.on.aws/',
  region: 'us-west-2',
  credentials: { accessKeyId: '…', secretAccessKey: '…' },
});
```

The handler **always SigV4-signs the outer POST** to the Function URL for the
`lambda` service, so it authenticates against the URL's `AWS_IAM` auth out of
the box. The caller's identity needs `lambda:InvokeFunctionUrl` on the function.
This is independent of the inner request, which stays SigV4-signed for the
target service (S3, Bedrock, …) inside the envelope.

Because signing is built in, `ProxyRequestHandler` resolves `@smithy/signature-v4`,
`@smithy/core` (for its SHA-256), and `@aws-sdk/credential-provider-node` at
runtime. These ship with every AWS SDK v3 client, so a consumer that already
uses the SDK has them; they are declared as optional peer dependencies.

## Deploy

Response streaming is the only supported mode. The script builds the artifact,
packages it (no `node_modules` — the AWS SDK is provided by the runtime), and
configures the Function URL with `RESPONSE_STREAM` and `AWS_IAM`.

```bash
ROLE_ARN=arn:aws:iam::<account>:role/<lambda-exec-role> \
AWS_REGION=us-east-1 \
./scripts/deploy.sh
```

`ROLE_ARN` is just the Lambda **execution** role, and it should have **NO
privileges** beyond basic Lambda execution (CloudWatch Logs). Do **not** grant
it S3, Bedrock, or any upstream-service permissions — the Lambda signs nothing
and never calls any service as itself, so it needs none. `AWS_IAM` on the
Function URL is the only access control; keep it.

## License

MIT
