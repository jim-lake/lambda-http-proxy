# AGENTS.md

Operational reference for working on **lambda-http-proxy**.

## Project

A streaming HTTP proxy that runs on AWS Lambda. It forwards **SigV4-signed AWS
requests verbatim** to their real target and **streams the response back**, so
the signature verifies at the upstream exactly as if the client had called the
service directly.

The proxy is consumed as a custom **`requestHandler`** on any AWS SDK v3 client
(see `README.md`). The SDK signs the request; the handler wraps it and sends it
to the proxy; the proxy forwards it to the real host (S3, Bedrock, …) and
streams the response straight back through the SDK.

- Handler source: `src/index.ts` (single file).
- Published SDK request handler: `scripts/proxy-request-handler.mjs`.
- Built artifact: `dist/lambda-http-proxy.mjs` (+ `.d.ts`). `dist/` is
  gitignored; rebuild with `npm run build`.

## How the proxy works

1. The SDK's SigV4 middleware signs the request. `ProxyRequestHandler.handle`
   receives the already-signed `HttpRequest`.
2. The handler wraps the **entire** signed request (exact path, method,
   headers, base64 body) in a JSON **envelope** and POSTs it to the proxy as
   `application/json`. The envelope exists for two reasons:
   - The signed path survives verbatim. A Function URL re-encodes `rawPath`,
     which would corrupt paths signed with specific encoding (e.g. Bedrock's
     `%3A`) and break the signature. `envelope.path` carries the exact bytes.
   - Content-length never collides. The outer POST has its own content-length
     (envelope size); the signed content-length rides inside the envelope
     headers and is forwarded to the upstream unchanged.
3. The Lambda handler unwraps the envelope (`parseEvent` in `src/index.ts`). If
   the body is a `__proxyEnvelope`, it uses `envelope.{path,method,headers,body}`;
   otherwise it falls back to the raw Function URL event.
4. `buildUpstreamHeaders` forwards every signed header and strips only
   hop-by-hop headers plus Function-URL-injected ones (`x-amzn-trace-id`,
   `x-forwarded-*`, `cloudfront-*`, `x-amz-cf-id`, `via`). **Do not** blanket-
   strip by prefix — Bedrock signs `x-amzn-bedrock-*` headers; dropping them
   breaks verification. There is a regression test for this.
5. `forwardAndStream` opens an HTTPS request to the signed `host` and
   `upstream.pipe(responseStream)` — the response is never buffered.
6. **Output contract.** `applyResponseMetadata` conveys the upstream status +
   headers via `awslambda.HttpResponseStream.from` (real runtime) — which emits
   a JSON metadata prelude + eight NUL bytes + body. On a deployed Function URL
   the AWS edge consumes that prelude and produces the real HTTP status +
   headers, so the body the caller receives is byte-for-byte the upstream body.
   The output is **indistinguishable from calling the upstream directly**. The
   non-runtime fallback writes the identical wire format (prelude + 8 NUL +
   body) so a plain-node harness sees exactly what a deployed Function URL
   emits.

The handler is wrapped with `awslambda.streamifyResponse` when the real runtime
provides it. `streamify` and `applyResponseMetadata` guard on the actual
`streamifyResponse`/`HttpResponseStream` **method** (not object presence),
because importing an AWS SDK client sets `globalThis.awslambda = {}` (empty).

## Toolchain

- Node `v24.x`. Deps installed (`node_modules/`). Runtime is `nodejs24.x`.
- **TypeScript is only a type-checker** — never an emitter. `tsc --noEmit` only.
- **esbuild** (via `rollup-plugin-esbuild`) transpiles; **rollup-plugin-dts**
  emits types. Two-pass build in `rollup.config.mjs`.
- **tsx** runs everything executable (the tests).
- The AWS SDK (`@aws-sdk/*`, `@smithy/*`) is **external** in the bundle — the
  managed runtime ships it. Pinned version is recorded in
  `package.json#lambdaRuntime.providedSdkVersion` (currently `3.1105.0`); dev
  deps that mirror the runtime SDK are pinned to the same value.

```bash
npm run ts:check     # tsc --noEmit (type-check only)
npm run lint         # eslint src --fix  (strict; src only, never dist)
npm run pretty       # prettier --write across the repo
npm run build        # ts:check + rollup (esbuild bundle + dts) -> dist/
npm test             # build, then run ALL tests (incl. real AWS)
npm run test:only    # just the tests, no rebuild
```

Pinned to resolve peer ranges: `typescript@6.0.3` (fits typescript-eslint's
`<6.1.0`), `eslint@9`. Keep `src/**/*.ts` lint-clean.

## The gate (run EVERY time; all three must be green)

Three separate commands, all green at the end of every change:

```bash
npm run ts:check     # tsc --noEmit
npm run lint         # eslint src --fix (strict, src only)
npm test             # build + tsx --test "test/**/*.test.mjs" (incl. real AWS)
```

`npm test` runs the artifact bundle then every test file, **including the
real-AWS S3 and Bedrock end-to-end tests**. The box always has valid AWS
credentials; **nothing needs Docker, SAM, RIE, or LocalStack**. Do not add skips
or gating for the real-AWS tests. If any of the three commands is not green, the
change is not done.

## Tests

Three layers, all under `npm test`. Keep real test files as `test/**/*.test.mjs`
— the runner glob is scoped to that so non-test `.mjs` in `test/` (the Function
URL runtime helper) is not swept in and left hanging.

### 1. Unit tests — `test/proxy.test.mjs` (no network)

Exercise `proxy()` directly against throwaway local http origins. No Lambda
runtime involved (the non-runtime fallback emits the response-streaming wire
format; the test strips the prelude to recover the raw upstream body). Cover:
header preservation, Host preservation, body integrity, incremental streaming,
the `x-amzn-bedrock-*` regression, and envelope path/headers/body.

### 2. Output-contract tests — `test/function-url.test.mjs` (no network)

Drive the proxy through `test/function-url-runtime.mjs`, a **plain-node**
emulation of a Function URL in `RESPONSE_STREAM` mode. It installs a faithful
`globalThis.awslambda` shim (`streamifyResponse` + `HttpResponseStream.from`
writing the JSON prelude + eight NUL bytes + body), then acts as the AWS edge:
strips the prelude and returns `{ statusCode, headers, body }` where `body` is a
Readable. Assert the output is **indistinguishable from the upstream**: status,
headers, binary body integrity, and incremental delivery. This is the expected
use case (invoke the Function URL with response streaming; pipe the raw output
straight downstream).

### 3. Real-AWS end-to-end tests — `test/smoke-{s3,bedrock}.test.mjs`

A real SDK client signs the request; `ProxyFunctionUrlRequestHandler` (exported
from `test/function-url-runtime.mjs`) wraps it in the proxy envelope and runs it
through the same plain-node Function URL emulation, which forwards it verbatim
to **real AWS over HTTPS** and streams the raw response back. No Docker, no SAM
— just the ambient credentials on the box.

- `smoke-s3.test.mjs`: ListBuckets + GetObject.
- `smoke-bedrock.test.mjs`: ListFoundationModels + `InvokeModelWithResponseStream`.
  Because the body streams back raw, the binary
  `application/vnd.amazon.eventstream` response is decoded by the SDK intact —
  this validates true streaming with no buffering emulator in the path.

A `SignatureDoesNotMatch` is the only hard failure (the proxy mangled the
request). A valid response — or a post-verification error like
`AccessDenied`/`NoSuchKey`/`ValidationException` — means signing survived.

## Deploy

Streaming is the only supported mode: `InvokeMode: RESPONSE_STREAM`,
`AuthType: AWS_IAM`, `nodejs24.x`, handler `lambda-http-proxy.handler`.

```bash
ROLE_ARN=... AWS_REGION=... ./scripts/deploy.sh
```

`scripts/deploy.sh` builds with the AWS CLI only, zips only
`dist/lambda-http-proxy.mjs` (no node_modules — SDK is runtime-provided), and
configures the Function URL with `RESPONSE_STREAM`.

## Conventions

- Keep `src/index.ts` a single comment-light file; it has no runtime deps
  beyond Node builtins. Anything SDK-related is dev/test only.
- The published surface is `.` (the handler) and `./proxy-request-handler.mjs`.
  Don't move `scripts/proxy-request-handler.mjs` into `test/` — it ships.
- When touching header handling or path encoding, the Bedrock real-AWS test is
  the sensitive case (double-encoded path, signed `x-amzn-bedrock-*`). It runs
  as part of `npm test`.
