/*
 * Shared test target selector.
 *
 * Every smoke test uses the SAME published `ProxyRequestHandler` from
 * `dist/proxy-request-handler.mjs`. The handler ALWAYS SigV4-signs the outer
 * POST for the `lambda` service — there is no separate "signing" path in the
 * tests. The only thing that changes between targets is the URL the handler
 * points at:
 *
 *   - local  (default): an in-process plain-http server (startLocalProxyServer)
 *     runs the proxy via the Function URL RESPONSE_STREAM emulation and
 *     forwards verbatim to real AWS. ProxyRequestHandler talks to it over http.
 *     The signed outer POST is accepted as-is (no IAM in front of a local
 *     socket), so signing is exercised but not enforced.
 *
 *   - deployed: ProxyRequestHandler points at a LIVE deployed Function URL
 *     (AuthType: AWS_IAM) over https. The same signed outer POST now
 *     authenticates against real IAM.
 *
 * Selection:
 *   PROXY_TARGET=local                       -> in-process emulation (default)
 *   PROXY_TARGET=deployed                    -> live Function URL
 *   PROXY_FUNCTION_URL=https://...on.aws/    -> required when deployed
 *   PROXY_URL_REGION=us-west-2               -> region to sign the outer POST
 *                                               (defaults to the region parsed
 *                                               from the Function URL host)
 *
 * Setting PROXY_FUNCTION_URL alone implies the deployed target.
 */
import {
  startLocalProxyServer,
  type LocalProxyServer,
} from './function-url-runtime.ts';

export function resolveTarget() {
  const explicit = (process.env.PROXY_TARGET || '').trim().toLowerCase();
  const functionUrl = (
    process.env.LAMBDA_FUNCTION_URL ||
    process.env.PROXY_FUNCTION_URL ||
    ''
  ).trim();

  // PROXY_FUNCTION_URL alone implies deployed; PROXY_TARGET wins if set.
  const target = explicit || (functionUrl ? 'deployed' : 'local');

  if (target === 'deployed') {
    if (!functionUrl) {
      throw new Error(
        'PROXY_TARGET=deployed requires LAMBDA_FUNCTION_URL to be set ' +
          '(e.g. https://<id>.lambda-url.<region>.on.aws/).'
      );
    }
    const region =
      (process.env.PROXY_URL_REGION || '').trim() ||
      regionFromFunctionUrl(functionUrl);
    if (!region) {
      throw new Error(
        'Could not determine the Function URL region. Set PROXY_URL_REGION.'
      );
    }
    return { target, functionUrl, region };
  }

  if (target !== 'local') {
    throw new Error(
      `Unknown PROXY_TARGET "${target}". Use "local" or "deployed".`
    );
  }
  return { target: 'local' };
}

/*
 * Target lifecycle for the smoke tests. The tests themselves construct
 * `new ProxyRequestHandler({ proxyUrl })` INLINE — exactly as a real consumer
 * would — so they double as usage examples. This fixture only supplies the URL
 * (and, for deployed, the signing region) and manages the local server:
 *
 *   `fixture.before` / `fixture.after` plug straight into node:test's
 *   `before`/`after`. In LOCAL mode `before` brings up the in-process proxy
 *   server and `after` tears it down. In DEPLOYED mode both do essentially
 *   nothing. After `before` has run, read `fixture.proxyUrl` (and
 *   `fixture.region`) to build the handler.
 */
export interface TargetFixture {
  before: () => Promise<void>;
  after: () => Promise<void>;
  /** The URL to pass to `new ProxyRequestHandler({ proxyUrl })`. */
  readonly proxyUrl: string;
  /** Region for the outer signature; only set for deployed. */
  readonly region: string | undefined;
}

export function createTargetFixture(): TargetFixture {
  const t = resolveTarget();

  if (t.target === 'deployed') {
    return {
      before: () => Promise.resolve(),
      after: () => Promise.resolve(),
      proxyUrl: t.functionUrl!,
      region: t.region,
    };
  }

  let local: LocalProxyServer | undefined;
  return {
    before: async () => {
      local = await startLocalProxyServer();
    },
    after: async () => {
      await local?.close();
      local = undefined;
    },
    get proxyUrl(): string {
      if (!local) {
        throw new Error(
          'local proxy server not started — call fixture.before() first'
        );
      }
      return local.url;
    },
    region: undefined,
  };
}

/* Human-readable description of where the tests are pointed (for logs). */
export function describeTarget() {
  const t = resolveTarget();
  return t.target === 'deployed'
    ? `deployed Function URL ${t.functionUrl} (signed for lambda in ${t.region})`
    : 'local in-process Function URL emulation';
}

/* Parse "<id>.lambda-url.<region>.on.aws" -> region. */
function regionFromFunctionUrl(url: string): string {
  try {
    const host = new URL(url).hostname;
    const m = /\.lambda-url\.([^.]+)\.on\.aws$/.exec(host);
    return m ? m[1] : '';
  } catch {
    return '';
  }
}
