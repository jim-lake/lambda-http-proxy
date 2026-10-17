# AGENTS.md

Operational reference for working on **lambda-outbound-proxy**.

## ⛔ NEVER decrement the version in package.json

**NEVER decrement, revert, roll back, or "unbump" `version` in `package.json`
FOR ANY REASON.** This includes — without exception — script testing, running
the test suite, experiments, reverting a mistaken build, cleaning up, or any
other situation. The version is monotonic: it only ever goes up.

If a build bumped the version as a side effect of something, **leave it bumped.**
Do not "restore" it. There is no scenario in which lowering the version is
correct.

## ⛔ Comments: only non-obvious single-liners

**No file-header comments, no function/JSDoc comments, no multi-line block
comments, no narrative.** Comments must never restate what the code already
says. The ONLY comment allowed is a single short line explaining something
genuinely **non-obvious** (a surprising workaround, a spec quirk, a required
`eslint-disable`). If the code is self-explanatory, write no comment. Behavioral
instructions and design rationale belong **here in AGENTS.md**, not in source.

## ⛔ Dependencies: always add the LATEST version — never from memory

When adding a dependency to `package.json`, **look up the current latest version
and pin that exact version.** Do NOT guess, and do NOT rely on your memory of
version numbers — your memory is stale. Check the real latest (e.g.
`npm view <pkg> version`) and use it. The one exception is anything that must
mirror the runtime SDK: dev deps that shadow the managed runtime SDK stay pinned
to `package.json#lambdaRuntime.providedSdkVersion` (see Toolchain), not "latest".

## Project

A streaming HTTP proxy that runs on AWS Lambda. It forwards **SigV4-signed AWS
requests verbatim** to their real target and **streams the response back**, so
the signature verifies at the upstream exactly as if the client had called the
service directly.

## ⚠️ The Lambda signs NOTHING and runs with NO privileges

**Internalize this before touching anything.** The Lambda handler
(`src/lambda-outbound-proxy.ts`) has **no AWS SDK, no SigV4 code, and makes no
signed calls.** It receives the caller's **already-signed** request and forwards
those exact bytes to the upstream verbatim — a dumb pipe. All signing happens on
the **client** side:

1. **Inner request** — the consumer's AWS SDK signs it for the target service
   (S3, Bedrock, …). The Lambda relays it untouched.
2. **Outer POST to the Function URL** — `ProxyRequestHandler` signs it for the
   `lambda` service. IAM on the URL (`AuthType: AWS_IAM`) verifies it before the
   handler runs; this is the **only** gate on who may use the proxy.

Consequently the Lambda **execution role needs ZERO privileges** beyond basic
Lambda execution (CloudWatch Logs) — no S3, no Bedrock, no upstream-service
permissions, ever. It never calls any service as itself, so it never needs to.
Do not add signing to the handler, do not import the SDK into it, and do not
suggest attaching upstream permissions to its role. When writing code or
comments, never state or imply the Lambda signs anything or acts with its own
identity — **read `src/lambda-outbound-proxy.ts` before making any claim about
what the handler does.**

The proxy is consumed as a custom **`requestHandler`** on any AWS SDK v3 client
(see `README.md`). The SDK signs the request; the handler wraps it and sends it
to the proxy; the proxy forwards it to the real host (S3, Bedrock, …) and
streams the response straight back through the SDK.

Two published entry points, both TypeScript source built to `dist/` (gitignored;
rebuild with `npm run build`):

- `src/lambda-outbound-proxy.ts` — the Lambda handler. Zero runtime deps beyond Node
  builtins. Built to `dist/lambda-outbound-proxy.mjs` (handler `lambda-outbound-proxy.handler`).
- `src/proxy-request-handler.ts` — the SDK `requestHandler` consumers import.
  Built to `dist/proxy-request-handler.mjs`. It **always SigV4-signs the outer
  POST** to the Function URL for the `lambda` service, so it authenticates
  against the URL's `AWS_IAM` auth. Signing uses static top-level imports of
  `@smithy/signature-v4`, `@smithy/core/checksum` (SHA-256), and
  `@aws-sdk/credential-provider-node`; those plus `@smithy/protocol-http` stay
  external (optional peer deps), not bundled — every AWS SDK v3 client ships
  them. No dynamic `import()` in source (there is an eslint rule enforcing it).
- `src/fetch-proxy.ts` — a drop-in WHATWG `fetch` for `fetch`-based SDKs (e.g.
  the `openai` SDK's Bedrock provider). Exports the `FetchProxy` class
  (`new FetchProxy({ proxyUrl, region?, credentials? })` with a bound `.fetch`).
  Built to `dist/fetch-proxy.js` (+ `.d.ts`/`.d.mts`). It is a thin transport
  wrapper over `ProxyRequestHandler`: the inner (already-signed) request rides
  through the envelope untouched, the outer POST is SigV4-signed for `lambda`,
  and the streamed response is adapted to a WHATWG `Response` with a
  `ReadableStream` body. Same external deps as the requestHandler.

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
3. The Lambda handler unwraps the envelope (`parseEvent` in
   `src/lambda-outbound-proxy.ts`). If the body is a `__proxyEnvelope`, it uses
   `envelope.{path,method,headers,body}`; otherwise it falls back to the raw
   Function URL event.
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
  emits types. `rollup.config.mjs` builds both entry points (handler +
  requestHandler), each as `.mjs` plus `.d.ts`/`.d.mts`.
- **tsx** runs everything executable (the tests).
- The AWS SDK (`@aws-sdk/*`, `@smithy/*`) is **external** in the bundle — the
  managed runtime ships it. Pinned version is recorded in
  `package.json#lambdaRuntime.providedSdkVersion` (currently `3.1105.0`); dev
  deps that mirror the runtime SDK are pinned to the same value.

```bash
npm run ts:check     # tsc --noEmit (type-check only)
npm run lint         # eslint src test --fix  (strict)
npm run pretty       # prettier --write across the repo
npm run build        # ts:check + rollup (esbuild bundle + dts) -> dist/
npm test             # build, then test:deployed + test:unit (deployed is the default)
npm run test:deployed  # real-AWS smoke tests against the LIVE Function URL (.env)
npm run test:unit      # in-process adapter/output-contract tests, no deployed URL
npm run test:local     # dev-only: run the smoke suite against the in-process emulation
```

Pinned to resolve peer ranges: `typescript@6.0.3` (fits typescript-eslint's
`<6.1.0`), `eslint@9`. Keep `src/**/*.ts` and `test/**/*.ts` lint-clean.

## The gate (run EVERY time; all must be green)

```bash
npm run ts:check       # tsc --noEmit
npm run lint           # eslint src test --fix (strict)
npm test               # build + test:deployed (real LIVE Function URL) + test:unit
```

**Deployed is the default and primary target.** `npm test` builds the bundle,
then runs `test:deployed` — the real-AWS smoke suite against the **live deployed
Function URL** named in `.env` (`LAMBDA_FUNCTION_URL`), with the outer envelope
POST SigV4-signed for `lambda` over real HTTPS, exercising the full deployed
path including IAM auth — followed by `test:unit`, the fast in-process adapter
and output-contract checks. `PROXY_TARGET` defaults to `deployed`; `local` is an
explicit opt-in (`npm run test:local`) used ONLY while developing the Lambda
handler against the in-process plain-node emulation. The box always has valid
AWS credentials; **nothing needs Docker, SAM, RIE, or LocalStack**. Do not add
skips or gating for the real-AWS tests. If any command is not green, the change
is not done.

## Tests

Two groups. **Deployed smoke tests** are `test/*.test.ts` (run by
`test:deployed` against the live Function URL). **In-process unit tests** are
`test/unit/**/*.test.ts` (run by `test:unit`, no deployed URL). Shared non-test
helpers (e.g. the Function URL runtime emulator) live beside them as plain `.ts`
and are imported, not run directly.

### Unit: proxy internals — `test/unit/proxy.test.ts` + `test/unit/proxy-request-handler.test.ts` (no network)

`proxy.test.ts` exercises `proxy()` directly against throwaway local http
origins. No Lambda runtime involved (the non-runtime fallback emits the
response-streaming wire format; the test strips the prelude to recover the raw
upstream body). Covers header preservation, Host preservation, body integrity,
incremental streaming, the `x-amzn-bedrock-*` regression, and envelope
path/headers/body. `proxy-request-handler.test.ts` exercises the built
`dist/proxy-request-handler.mjs` entry: it POSTs the signed request as an
envelope to a throwaway local proxy and asserts the envelope shape and the
surfaced response.

### Unit: output contract — `test/unit/function-url.test.ts` (no network)

Drive the proxy through `test/function-url-runtime.ts`, a **plain-node**
emulation of a Function URL in `RESPONSE_STREAM` mode. It installs a faithful
`globalThis.awslambda` shim (`streamifyResponse` + `HttpResponseStream.from`
writing the JSON prelude + eight NUL bytes + body), then acts as the AWS edge:
strips the prelude and returns `{ statusCode, headers, body }` where `body` is a
Readable. Assert the output is **indistinguishable from the upstream**: status,
headers, binary body integrity, and incremental delivery.

### Unit: fetch adapter — `test/unit/fetch-proxy.test.ts` (no network)

Drives the built `dist/fetch-proxy.js` `FetchProxy` through the in-process
emulation against a throwaway origin. Covers the WHATWG contract the adapter
owns and a deployed black box can't show: status/header mapping, byte-for-byte
inner-header fidelity, streaming `ReadableStream` body, `redirect: 'manual'`
(no following), null-body (HEAD/204/304), `Request`-object input, and
`AbortSignal`.

### Deployed smoke — `test/smoke-{s3,bedrock,fetch,unsigned}.test.ts`

The target is chosen by `test/proxy-target.ts` via `createTargetFixture()` /
`resolveTarget()`. **`deployed` is the default**; `local` (the in-process
emulation that still forwards to real AWS) is an explicit opt-in for Lambda
development only. Either way the proxy forwards verbatim to **real AWS** and
streams the raw response back.

- `smoke-s3.test.ts` / `smoke-bedrock.test.ts`: a real SDK client signs the
  inner request; the published `ProxyRequestHandler` (inline, as a consumer
  would) signs the outer POST. S3: ListBuckets + GetObject. Bedrock:
  ListFoundationModels + `InvokeModelWithResponseStream` (binary
  `application/vnd.amazon.eventstream` decoded intact — true streaming).
- `smoke-fetch.test.ts`: the published `FetchProxy` with a manually SigV4-signed
  inner request to real S3 and Bedrock, incl. a streaming event-stream read.
- `smoke-unsigned.test.ts`: **deployed-only** security guard — a bare unsigned
  POST to the Function URL must be rejected `403` by IAM. It is NOT registered
  in local mode (no IAM in front of a local socket), so it never skips.

A `SignatureDoesNotMatch`/`403` is the only hard failure (the proxy mangled the
request). A valid response — or a post-verification error like
`AccessDenied`/`NoSuchKey`/`ValidationException` — means signing survived.

## Deploy

Streaming is the only supported mode: `InvokeMode: RESPONSE_STREAM`,
`AuthType: AWS_IAM`, `nodejs24.x`, handler `lambda-outbound-proxy.handler`.

```bash
ROLE_ARN=... AWS_REGION=... ./scripts/deploy.sh
```

`scripts/deploy.sh` builds with the AWS CLI only, zips only
`dist/lambda-outbound-proxy.mjs` (no node_modules — SDK is runtime-provided), and
configures the Function URL with `RESPONSE_STREAM`.

`ROLE_ARN` is only the Lambda **execution** role and must carry **NO
privileges** beyond basic Lambda execution (CloudWatch Logs) — never S3,
Bedrock, or any upstream-service permissions, because the handler signs nothing
and never calls any service as itself. `AuthType: AWS_IAM` on the Function URL
is the only access control; never deploy with `AuthType: NONE`.

## Conventions

- Keep `src/lambda-outbound-proxy.ts` free of runtime deps beyond Node builtins.
  Anything SDK-related is dev/test only. (Comment style is governed by the
  comment rule near the top of this file.)
- The published surface is `.` (the handler, `dist/lambda-outbound-proxy.mjs`),
  `./proxy-request-handler.mjs` (`dist/proxy-request-handler.mjs`), and
  `./fetch-proxy.js` (`dist/fetch-proxy.js`). All are built from `src/`;
  `@smithy/*` / `@aws-sdk/*` stay external in the requestHandler and fetch
  bundles.
- When touching header handling or path encoding, the Bedrock real-AWS test is
  the sensitive case (double-encoded path, signed `x-amzn-bedrock-*`). It runs
  as part of `npm test`.
