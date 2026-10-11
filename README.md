# lambda-outbound-proxy

A streaming HTTP proxy that runs on AWS Lambda. It forwards **SigV4-signed AWS
requests verbatim** to their real target and **streams the response back**, so
the signature verifies at the upstream exactly as if you'd called the service
directly. The response you get back is **indistinguishable from the raw upstream
response** — same status, same headers, same body bytes, never buffered.

It deploys as a **Lambda Function URL in response-streaming mode**
(`InvokeMode: RESPONSE_STREAM`, `AuthType: AWS_IAM`).

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
// Production: the HTTPS Function URL of your deployed proxy.
new ProxyRequestHandler({
  proxyUrl: 'https://<id>.lambda-url.<region>.on.aws/',
});

// Local: a proxy running over plain HTTP.
new ProxyRequestHandler({ proxyHost: '127.0.0.1', proxyPort: 3000 });
```

Because the Function URL uses `AWS_IAM` auth, the caller's identity needs
`lambda:InvokeFunctionUrl` on the function. The inner request is still
SigV4-signed for the target service.

## Deploy

Response streaming is the only supported mode. The script builds the artifact,
packages it (no `node_modules` — the AWS SDK is provided by the runtime), and
configures the Function URL with `RESPONSE_STREAM` and `AWS_IAM`.

```bash
ROLE_ARN=arn:aws:iam::<account>:role/<lambda-exec-role> \
AWS_REGION=us-east-1 \
./scripts/deploy.sh
```

## License

MIT
