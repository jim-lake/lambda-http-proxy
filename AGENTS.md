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

The handler is wrapped with `awslambda.streamifyResponse` when the real runtime
provides it. `streamify` and `applyResponseMetadata` guard on the actual
`streamifyResponse`/`HttpResponseStream` **method** (not object presence),
because importing an AWS SDK client sets `globalThis.awslambda = {}` (empty).

## Toolchain

- Node `v24.x`. Deps installed (`node_modules/`). Runtime is `nodejs24.x`.
- **TypeScript is only a type-checker** — never an emitter. `tsc --noEmit` only.
- **esbuild** (via `rollup-plugin-esbuild`) transpiles; **rollup-plugin-dts**
  emits types. Two-pass build in `rollup.config.mjs`.
- **tsx** runs everything executable (tests, smoke tests, event generator).
- The AWS SDK (`@aws-sdk/*`, `@smithy/*`) is **external** in the bundle — the
  managed runtime ships it. Pinned version is recorded in
  `package.json#lambdaRuntime.providedSdkVersion` (currently `3.1105.0`); dev
  deps that mirror the runtime SDK are pinned to the same value.

```bash
npm run ts:check     # tsc --noEmit (type-check only)
npm run lint         # eslint src --fix  (strict; src only, never dist)
npm run pretty       # prettier --write across the repo
npm run build        # ts:check + rollup (esbuild bundle + dts) -> dist/
npm test             # build, then unit tests
npm run test:only    # unit tests without rebuilding
```

Pinned to resolve peer ranges: `typescript@6.0.3` (fits typescript-eslint's
`<6.1.0`), `eslint@9`. Keep `src/**/*.ts` lint-clean.

## Tests

Two layers. Keep real test files as `test/**/*.test.mjs` — the runner glob is
scoped to that so non-test `.mjs` in `test/` (smoke tests, helpers) are not
swept in and left hanging.

### 1. Unit tests — `test/proxy.test.mjs` (no AWS)

Exercise `proxy()` directly against throwaway local http origins. No Lambda
runtime involved (the non-runtime fallback annotates the response stream).
Cover: header preservation, Host preservation, body integrity, incremental
streaming, the `x-amzn-bedrock-*` regression, and envelope path/headers/body.

```bash
npm run test:only
```

### 2. Real-runtime tests via SAM (needs Docker + AWS creds)

The function runs in AWS's **genuine `nodejs24.x` runtime image** — no homebrew
shim. SAM CLI lives in a venv at `~/.sam-venv`, symlinked to `~/.local/bin/sam`
(ensure it is on `PATH`).

- **One-shot invoke** against the real runtime:

  ```bash
  npm run sam:invoke        # builds, signs a real S3 event, sam local invoke
  ```

- **Smoke tests** (real SDK client -> `requestHandler` -> proxy in real runtime
  -> live AWS). `scripts/run-smoke.sh` starts `sam local start-lambda`, waits,
  runs the test, tears SAM down.

  ```bash
  npm run smoke:s3          # ListBuckets (and GetObject with args)
  npm run smoke:bedrock     # ListFoundationModels + streaming invoke
  ```

A `SignatureDoesNotMatch` means the proxy mangled the request. A valid parse —
or a post-verification error like `AccessDenied`/`NoSuchKey`/`ValidationException`
— means signing survived.

## Local streaming limitation (important)

**No local emulator — SAM, RIE, or LocalStack — implements
`InvokeWithResponseStream`.** They all buffer the response (LocalStack's docs
state response streaming is unsupported). So:

- Local smoke tests use **direct `Invoke`** via `SamLambdaRequestHandler`
  (`test/sam-lambda-handler.mjs`), which parses the buffered response-streaming
  payload (JSON metadata prelude + eight NUL bytes + body).
- S3 and Bedrock **control-plane** calls pass locally.
- Bedrock **streaming** (`InvokeModelWithResponseStream`) returns a binary
  `application/vnd.amazon.eventstream` body that the buffered invoke cannot
  carry intact. The smoke test treats this as a **known SKIP**, not a failure.
- **True incremental streaming is only validated against a real deployed
  Function URL** (`InvokeMode: RESPONSE_STREAM`). When extending streaming
  tests, target a deployed function, not a local emulator.

## Deploy

Streaming is the only supported mode: `InvokeMode: RESPONSE_STREAM`,
`AuthType: AWS_IAM`, `nodejs24.x`, handler `lambda-http-proxy.handler`,
`CodeUri: dist/`.

```bash
sam build && sam deploy --guided            # template.yaml
# or, without SAM:
ROLE_ARN=... AWS_REGION=... ./scripts/deploy.sh
```

`scripts/deploy.sh` builds, zips only `dist/lambda-http-proxy.mjs` (no
node_modules — SDK is runtime-provided), and configures the Function URL with
`RESPONSE_STREAM`.

## Conventions

- Keep `src/index.ts` a single comment-light file; it has no runtime deps
  beyond Node builtins. Anything SDK-related is dev/test only.
- The published surface is `.` (the handler) and `./proxy-request-handler.mjs`.
  Don't move `scripts/proxy-request-handler.mjs` into `test/` — it ships.
- When touching header handling or path encoding, run `smoke:bedrock` — Bedrock
  is the sensitive case (double-encoded path, signed `x-amzn-bedrock-*`).
